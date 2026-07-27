// 邮件派生内容净化：正文/主题/发件人展示值/预览一律先经这里处理才允许离开
// 扩展进程。设计意图（docs/07 Prompt injection 防护 + 完整方案报告 §5 输出
// 上限）：邮件内容恒为不可信输入，净化的目标不是"让 HTML 好看"，而是消除
// 三类已知的隐藏注入手法——
//   1) CSS/属性隐藏的可见文本（display:none / visibility:hidden / 极小字号 /
//      aria-hidden 等），这类文本人眼看不见但会被当作邮件内容读入模型上下文；
//   2) 零宽字符（ZWSP/ZWNJ/ZWJ/BOM/word-joiner 等）与 Unicode Tag 区块
//      （U+E0000–U+E007F，2024 年披露的"ASCII smuggling"隐写手法）用于在
//      看似空白处夹带不可见指令；
//   3) 双向控制字符（bidi override/isolate）可以让恶意文本在视觉上呈现和
//      逻辑顺序不一致的内容，误导人工审阅。
// 这里只做"消除可能被模型误当作指令的隐藏信道"，不追求完整还原邮件排版。
import { MailAdapterError } from "./state.js";

/** 零宽/隐写类不可见字符：直接从文本里物理删除，不保留任何痕迹。 */
const INVISIBLE_CHARS_PATTERN = new RegExp(
  [
    "[\\u200B-\\u200F]", // 零宽空格/ZWNJ/ZWJ/LRM/RLM
    "[\\u2028\\u2029]", // 行/段分隔符：会被部分渲染器当作不可见换行滥用
    "\\u2060", // word joiner
    "\\uFEFF", // BOM / zero width no-break space
    "\\u00AD", // soft hyphen
    "\\u180E", // Mongolian vowel separator（历史上的零宽字符）
    "[\\uFE00-\\uFE0F]", // variation selectors
    "[\\uFFF9-\\uFFFB]", // interlinear annotation 标记
    "[\\u{E0000}-\\u{E007F}]", // Unicode Tag 区块：ASCII smuggling 隐写载体
  ].join("|"),
  "gu",
);

/**
 * 双向控制字符：保留会让"看到的文字顺序"与"实际字符顺序"不一致，只能删除
 * 而非替换。覆盖范围：U+061C（ALM）、U+202A-U+202E（LRE/RLE/PDF/LRO/RLO）、
 * U+2066-U+2069（LRI/RLI/FSI/PDI）。LRM/RLM（U+200E/U+200F）已落在上面
 * INVISIBLE_CHARS_PATTERN 的 U+200B-U+200F 区间内，这里不重复处理。
 * 下面这行的字符字面量已逐字节核对对应上述码点（见实现记录），改动前务必
 * 用 `xxd`/等价工具重新核对，不要目测编辑控制字符字面量。
 */
const BIDI_CONTROL_PATTERN = /[؜‪-‮⁦-⁩]/gu;

export function stripInvisibleAndBidi(text: string): string {
  return text.replaceAll(INVISIBLE_CHARS_PATTERN, "").replaceAll(BIDI_CONTROL_PATTERN, "");
}

/** style 属性/computed 值里出现下列模式之一，就认为该节点在视觉上不可见。 */
function isHiddenBySimpleHeuristic(element: Element): boolean {
  if (element.hasAttribute("hidden")) return true;
  if (element.getAttribute("aria-hidden") === "true") return true;
  const style = (element.getAttribute("style") ?? "").toLowerCase().replaceAll(/\s+/g, "");
  if (/display:none/.test(style)) return true;
  if (/visibility:hidden/.test(style)) return true;
  if (/opacity:0(?:\.0*)?(?:;|$)/.test(style)) return true;
  if (/font-size:0(?:px)?(?:;|$)/.test(style)) return true;
  if (/(?:^|;)width:0(?:px)?(?:;|$)/.test(style) && /(?:^|;)height:0(?:px)?(?:;|$)/.test(style)) return true;
  return false;
}

const REMOVE_ENTIRELY_TAGS = new Set(["script", "style", "head", "template", "noscript", "title"]);

function collectVisibleText(node: Node, out: string[]): void {
  if (node.nodeType === Node.TEXT_NODE) {
    out.push(node.textContent ?? "");
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const element = node as Element;
  const tag = element.tagName.toLowerCase();
  if (REMOVE_ENTIRELY_TAGS.has(tag)) return;
  if (isHiddenBySimpleHeuristic(element)) return;
  const isBlock = !/^(?:a|abbr|b|bdi|bdo|br|cite|code|em|i|mark|q|s|small|span|strong|sub|sup|time|u|wbr)$/.test(tag);
  for (const child of Array.from(element.childNodes)) collectVisibleText(child, out);
  if (isBlock || tag === "br") out.push("\n");
}

/**
 * HTML → 纯文本（默认净化格式）：解析 DOM、丢弃 script/style/head 等不可见
 * 容器与经启发式判定为隐藏的节点，只保留人眼实际可见的文本，再统一做不可见
 * 字符净化与空白折叠。`DOMParser` 在 WebExtension background 页面里可用
 * （`extension/tsconfig.json` 的 `lib` 含 `DOM`）。
 */
export function htmlToPlainText(html: string): string {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(html, "text/html");
  } catch {
    // 解析失败：不冒险把原始 HTML 透传出去（可能仍带隐藏内容/标签），退化为
    // 去标签的粗粒度净化。
    return stripInvisibleAndBidi(html.replaceAll(/<[^>]*>/g, " ")).replaceAll(/[ \t]+/g, " ").trim();
  }
  const out: string[] = [];
  collectVisibleText(doc.body ?? doc.documentElement, out);
  const joined = stripInvisibleAndBidi(out.join(""));
  return joined
    .split("\n")
    .map((line) => line.replaceAll(/[ \t]+/g, " ").trim())
    .filter((line, index, all) => line.length > 0 || (index > 0 && all[index - 1]!.length > 0))
    .join("\n")
    .trim();
}

/** 邮件正文默认净化入口：按 contentFormat 选择处理方式；`raw` 不在这里处理（由调用方按硬上限单独把关）。 */
export function sanitizeBody(content: string, format: "text" | "html"): string {
  const plain = format === "html" ? htmlToPlainText(content) : stripInvisibleAndBidi(content);
  return plain;
}

const MARKDOWN_ESCAPE_PATTERN = /([\\`*_[\]])/g;

function escapeMarkdown(text: string): string {
  return text.replaceAll(MARKDOWN_ESCAPE_PATTERN, "\\$1");
}

/** 极简、非完整规范的 HTML → Markdown：只覆盖邮件正文里常见的少量元素（链接/粗斜体/列表/标题/引用），其余一律退化为纯文本，不追求还原完整排版。 */
function collectMarkdown(node: Node, out: string[], listDepth: number): void {
  if (node.nodeType === Node.TEXT_NODE) {
    out.push(escapeMarkdown(node.textContent ?? ""));
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const element = node as Element;
  const tag = element.tagName.toLowerCase();
  if (REMOVE_ENTIRELY_TAGS.has(tag)) return;
  if (isHiddenBySimpleHeuristic(element)) return;

  const children = (): void => { for (const child of Array.from(element.childNodes)) collectMarkdown(child, out, listDepth); };

  switch (tag) {
    case "a": {
      const href = element.getAttribute("href") ?? "";
      const start = out.length;
      children();
      const label = out.splice(start).join("").trim() || href;
      out.push(href ? `[${label}](${href})` : label);
      return;
    }
    case "strong": case "b": { out.push("**"); children(); out.push("**"); return; }
    case "em": case "i": { out.push("*"); children(); out.push("*"); return; }
    case "code": { out.push("`"); children(); out.push("`"); return; }
    case "br": out.push("\n"); return;
    case "li": { out.push(`\n${"  ".repeat(Math.max(0, listDepth - 1))}- `); for (const child of Array.from(element.childNodes)) collectMarkdown(child, out, listDepth + 1); return; }
    case "ul": case "ol": { out.push("\n"); for (const child of Array.from(element.childNodes)) collectMarkdown(child, out, listDepth + 1); out.push("\n"); return; }
    case "blockquote": { out.push("\n> "); children(); out.push("\n"); return; }
    case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": {
      const level = Number(tag.slice(1));
      out.push(`\n${"#".repeat(level)} `); children(); out.push("\n");
      return;
    }
    default: {
      const isBlock = !/^(?:a|abbr|b|bdi|bdo|br|cite|code|em|i|mark|q|s|small|span|strong|sub|sup|time|u|wbr)$/.test(tag);
      children();
      if (isBlock) out.push("\n");
      return;
    }
  }
}

export function htmlToMarkdown(html: string): string {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(html, "text/html");
  } catch {
    return htmlToPlainText(html);
  }
  const out: string[] = [];
  collectMarkdown(doc.body ?? doc.documentElement, out, 0);
  const joined = stripInvisibleAndBidi(out.join(""));
  return joined
    .split("\n")
    .map((line) => line.replaceAll(/[ \t]+/g, " ").trimEnd())
    .join("\n")
    .replaceAll(/\n{3,}/g, "\n\n")
    .trim();
}

/** search/recent 默认字段里 240 字符纯文本 preview（docs/03 §数据压缩与分页）。 */
export function buildPreview(sanitizedText: string, maxChars = 240): string {
  const collapsed = sanitizedText.replaceAll(/\s+/g, " ").trim();
  if (collapsed.length <= maxChars) return collapsed;
  return `${collapsed.slice(0, maxChars)}…`;
}

/**
 * 发件人展示值脱敏（docs/03："from 的脱敏展示值"）：保留展示名与域名，本地
 * 部分只保留首字符。地址本身不属于当前账号/身份（对方地址），因此比账号自己
 * 的地址更保守地处理。
 */
export function maskAddressDisplay(input: { name?: string; email?: string }): string {
  const email = (input.email ?? "").trim();
  const match = /^([^@\s]+)@([^@\s]+)$/.exec(email);
  const maskedEmail = match ? `${match[1]!.slice(0, 1)}***@${match[2]}` : email.length > 0 ? "***" : "";
  const name = (input.name ?? "").trim();
  if (name.length === 0) return maskedEmail || "(未知发件人)";
  return maskedEmail ? `${name} <${maskedEmail}>` : name;
}

export interface TruncatedContent {
  readonly content: string;
  readonly originalBytes: number;
  readonly returnedBytes: number;
  readonly truncated: boolean;
  /** 下一段的起始字节偏移；`truncated` 为 false 时为 undefined。调用方据此签发 cursor ref。 */
  readonly nextOffsetBytes?: number;
}

/**
 * 按 UTF-8 字节数截断（docs/03 `message get` 超限响应形状），且不得在多字节
 * 字符中间切断。`offsetBytes` 支持从上一次截断处继续（cursor 分页）。
 */
export function truncateByBytes(fullText: string, maxBytes: number, offsetBytes = 0): TruncatedContent {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const fullBytes = encoder.encode(fullText);
  if (offsetBytes < 0 || offsetBytes > fullBytes.length) {
    throw new MailAdapterError("E_VALIDATION", "cursor 对应的偏移量超出正文范围");
  }
  const remaining = fullBytes.subarray(offsetBytes);
  if (remaining.length <= maxBytes) {
    return {
      content: decoder.decode(remaining),
      originalBytes: fullBytes.length,
      returnedBytes: remaining.length,
      truncated: false,
    };
  }
  // 找到 <= maxBytes 且落在 UTF-8 字符边界上的最大切点：继续字节（0x80-0xBF）不能作为切点。
  let cut = maxBytes;
  while (cut > 0 && (remaining[cut]! & 0b1100_0000) === 0b1000_0000) cut -= 1;
  const slice = remaining.subarray(0, cut);
  return {
    content: decoder.decode(slice),
    originalBytes: fullBytes.length,
    returnedBytes: slice.length,
    truncated: true,
    nextOffsetBytes: offsetBytes + cut,
  };
}
