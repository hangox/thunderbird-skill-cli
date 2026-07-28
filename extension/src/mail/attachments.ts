// attachments.list —— 列出附件元数据（本轮不实现 attachments.save，那是可逆
// 域 E3 的范围；见 src/contracts/routes.ts 的 `attachments.save` route 与
// capability `mail.reversible.v1`）。
//
// 附件名与邮件正文一样是不可信派生内容（docs/07："附件名...均为不可信数据"），
// 这里同样做零宽/bidi 字符净化，避免隐藏字符污染展示或日志。
import type { JsonSchema } from "../schema.js";
import { opaqueRefSchema, validate } from "../schema.js";
import { stripInvisibleAndBidi } from "./sanitize.js";
import { MailAdapterError, issueRef, resolveRef, type MailAdapterContext } from "./state.js";

interface MessageRefPayload { messageNativeId: number }
interface AttachmentRefPayload { messageNativeId: number; partName: string }

const ATTACHMENTS_LIST_SCHEMA: JsonSchema = {
  type: "object",
  properties: { messageRef: opaqueRefSchema("msg") },
  required: ["messageRef"],
};

interface AttachmentsListBody { messageRef: string }

interface AttachmentDto {
  attachmentRef: string;
  name: string;
  contentType: string;
  size: number;
}

export async function attachmentsList(body: unknown, context: MailAdapterContext): Promise<{ attachments: AttachmentDto[] }> {
  const result = validate(ATTACHMENTS_LIST_SCHEMA, body);
  if (!result.ok) throw new MailAdapterError("E_VALIDATION", `attachments list 请求体不合法：${result.errors.map((e) => `${e.path} ${e.message}`).join("; ")}`);
  const parsed = body as AttachmentsListBody;
  const { messageNativeId } = resolveRef<MessageRefPayload>("msg", parsed.messageRef, context);

  const header = await browser.messages.get(messageNativeId).catch(() => undefined);
  if (!header) throw new MailAdapterError("E_NOT_FOUND", "对象不存在，或不属于当前实例/配对范围");
  const attachments = await browser.messages.listAttachments(messageNativeId);

  return {
    attachments: attachments.map((attachment) => ({
      attachmentRef: issueRef("attachment", context, { messageNativeId, partName: attachment.partName } satisfies AttachmentRefPayload),
      name: stripInvisibleAndBidi(attachment.name ?? ""),
      contentType: attachment.contentType ?? "application/octet-stream",
      size: attachment.size,
    })),
  };
}
