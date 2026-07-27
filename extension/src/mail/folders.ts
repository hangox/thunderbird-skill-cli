// folders.list —— 列出邮件文件夹树（docs/01 附录 A：只读文件夹枚举只需要
// accountsRead，不需要 accountsFolders；本轮 manifest 也确实没有申请
// accountsFolders，见 extension/manifest.json）。
//
// 实现说明：Thunderbird 官方文档里 `MailFolder` 是否总是内嵌 `subFolders`
// 会因版本/调用路径而异（`accounts.get(id, true)` 与 `folders.getSubFolders()`
// 的返回形状没有在本轮找到可交叉核实的单一权威说明），这里采用防御性双路径：
// 优先使用节点自带的嵌套子文件夹数组；缺失时才显式调用
// `browser.folders.getSubFolders()` 兜底。真实 Thunderbird 128/140 环境的
// 行为需要后续 L1/L2 E2E 验证（见 docs/09 与完整方案报告 §8）。
import type { JsonSchema } from "../schema.js";
import { opaqueRefSchema, validate } from "../schema.js";
import { resolveAccountNativeId } from "./accounts.js";
import { MailAdapterError, issueRef, resolveRef, type MailAdapterContext } from "./state.js";

const FOLDERS_LIST_SCHEMA: JsonSchema = {
  type: "object",
  properties: { accountRef: opaqueRefSchema("acc"), parentRef: opaqueRefSchema("folder") },
  required: [],
};

interface FoldersListBody {
  accountRef?: string;
  parentRef?: string;
}

interface FolderRefPayload {
  accountNativeId: string;
  folderNativeId: unknown;
}

interface FolderDto {
  folderRef: string;
  accountRef: string;
  parentRef?: string;
  name: string;
  path: string;
  specialUse: string[];
}

/** 单次 folders.list 最多展开的节点数：邮件账号的文件夹树在病态情况下（大量共享/虚拟文件夹）可能很深/很宽，硬上限避免响应体失控增长（route 冻结的 maxResponseBodyBytes 是 256 KiB）。 */
const MAX_FOLDERS = 2000;
const MAX_DEPTH = 32;

async function childrenOf(folder: MailFolder): Promise<MailFolder[]> {
  if (Array.isArray(folder.subFolders)) return folder.subFolders;
  return browser.folders.getSubFolders(folder.id);
}

async function walk(
  folder: MailFolder,
  accountNativeId: string,
  accountRef: string,
  parentRef: string | undefined,
  depth: number,
  context: MailAdapterContext,
  out: FolderDto[],
  truncated: { value: boolean },
): Promise<void> {
  if (out.length >= MAX_FOLDERS) { truncated.value = true; return; }
  const payload: FolderRefPayload = { accountNativeId, folderNativeId: folder.id };
  const folderRef = issueRef("folder", context, payload);
  const dto: FolderDto = {
    folderRef,
    accountRef,
    name: folder.name,
    path: folder.path,
    specialUse: folder.specialUse ?? [],
  };
  if (parentRef) dto.parentRef = parentRef;
  out.push(dto);
  if (depth >= MAX_DEPTH) { truncated.value = true; return; }
  const children = await childrenOf(folder);
  for (const child of children) {
    if (out.length >= MAX_FOLDERS) { truncated.value = true; return; }
    await walk(child, accountNativeId, accountRef, folderRef, depth + 1, context, out, truncated);
  }
}

export async function foldersList(body: unknown, context: MailAdapterContext): Promise<{ folders: FolderDto[]; truncated: boolean }> {
  const result = validate(FOLDERS_LIST_SCHEMA, body);
  if (!result.ok) throw new MailAdapterError("E_VALIDATION", `folders list 请求体不合法：${result.errors.map((e) => `${e.path} ${e.message}`).join("; ")}`);
  const parsed = body as FoldersListBody;

  const out: FolderDto[] = [];
  const truncated = { value: false };

  if (parsed.parentRef) {
    const payload = resolveRef<FolderRefPayload>("folder", parsed.parentRef, context);
    if (parsed.accountRef && resolveAccountNativeId(parsed.accountRef, context) !== payload.accountNativeId) {
      throw new MailAdapterError("E_VALIDATION", "parentRef 与 accountRef 指向不同账号");
    }
    const parentAccountRef = parsed.accountRef ?? issueRef("acc", context, { accountNativeId: payload.accountNativeId });
    const parentFolder = await browser.folders.get(payload.folderNativeId, true);
    const children = await childrenOf(parentFolder);
    for (const child of children) {
      if (out.length >= MAX_FOLDERS) { truncated.value = true; break; }
      await walk(child, payload.accountNativeId, parentAccountRef, parsed.parentRef, 1, context, out, truncated);
    }
    return { folders: out, truncated: truncated.value };
  }

  const accounts = parsed.accountRef
    ? [await requireAccount(resolveAccountNativeId(parsed.accountRef, context))]
    : await browser.accounts.list(true);

  for (const account of accounts) {
    const accountRef = parsed.accountRef ?? issueRef("acc", context, { accountNativeId: account.id });
    const roots = account.folders ?? (account.rootFolder ? await childrenOf(account.rootFolder) : []);
    for (const root of roots) {
      if (out.length >= MAX_FOLDERS) { truncated.value = true; break; }
      await walk(root, account.id, accountRef, undefined, 1, context, out, truncated);
    }
  }

  return { folders: out, truncated: truncated.value };
}

async function requireAccount(accountNativeId: string): Promise<MailAccount> {
  const account = await browser.accounts.get(accountNativeId, true);
  if (!account) throw new MailAdapterError("E_NOT_FOUND", "账号不存在，或不属于当前实例/配对范围");
  return account;
}
