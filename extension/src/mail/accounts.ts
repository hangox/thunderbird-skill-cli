// accounts.list —— 列出扩展授权的账号与（可选）发件 identity。
//
// 设计意图：这是只读域里"最不敏感"的一条 route——账号/身份信息是用户自己
// 邮箱的元数据，不是他人隐私，因此这里不做 docs/07 里针对搜索结果 `from`
// 字段的脱敏（那是对方地址）；账号自己的地址正是调用方选 identity 发件时
// 需要的信息，脱敏反而降低可用性。
import type { JsonSchema } from "../schema.js";
import { validate } from "../schema.js";
import { MailAdapterError, issueRef, resolveRef, type MailAdapterContext } from "./state.js";

const ACCOUNTS_LIST_SCHEMA: JsonSchema = {
  type: "object",
  properties: { includeIdentities: { type: "boolean" } },
  required: [],
};

interface AccountsListBody {
  includeIdentities?: boolean;
}

interface IdentityDto {
  identityRef: string;
  name?: string;
  email?: string;
  replyTo?: string;
  default: boolean;
}

interface AccountDto {
  accountRef: string;
  name: string;
  type: string;
  identities?: IdentityDto[];
}

interface AccountRefPayload {
  accountNativeId: string;
}

interface IdentityRefPayload {
  accountNativeId: string;
  identityNativeId: string;
}

function toIdentityDto(identity: MailIdentity, context: MailAdapterContext): IdentityDto {
  const payload: IdentityRefPayload = { accountNativeId: identity.accountId, identityNativeId: identity.id };
  const dto: IdentityDto = {
    identityRef: issueRef("identity", context, payload),
    default: identity.default === true,
  };
  if (identity.name) dto.name = identity.name;
  if (identity.email) dto.email = identity.email;
  if (identity.replyTo) dto.replyTo = identity.replyTo;
  return dto;
}

export async function accountsList(body: unknown, context: MailAdapterContext): Promise<{ accounts: AccountDto[] }> {
  const result = validate(ACCOUNTS_LIST_SCHEMA, body);
  if (!result.ok) throw new MailAdapterError("E_VALIDATION", `accounts list 请求体不合法：${result.errors.map((e) => `${e.path} ${e.message}`).join("; ")}`);
  const parsed = body as AccountsListBody;

  const accounts = await browser.accounts.list(false);
  const accountDtos: AccountDto[] = accounts.map((account) => {
    const accountPayload: AccountRefPayload = { accountNativeId: account.id };
    const dto: AccountDto = {
      accountRef: issueRef("acc", context, accountPayload),
      name: account.name,
      type: account.type,
    };
    if (parsed.includeIdentities === true) {
      dto.identities = (account.identities ?? []).map((identity) => toIdentityDto(identity, context));
    }
    return dto;
  });

  return { accounts: accountDtos };
}

/** 供 folders/search/messages handler 复用：把 accountRef 解析回原生 accountId，并附带 E_NOT_FOUND 的统一失败关闭语义。 */
export function resolveAccountNativeId(accountRef: string, context: MailAdapterContext): string {
  const payload = resolveRef<AccountRefPayload>("acc", accountRef, context);
  return payload.accountNativeId;
}
