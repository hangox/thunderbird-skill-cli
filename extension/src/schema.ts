// 通用严格 JSON schema 校验器：拒绝未知字段与原型污染键，字段级硬上限明确。
//
// 设计意图：每条邮件 route 的请求体必须先经过按 route 静态声明的 schema 校验，
// 才允许进入业务逻辑；校验失败不得执行任何部分业务操作。这里只提供纯逻辑
// 校验原语（object 只读 own enumerable 字符串键、拒绝 __proto__/prototype/
// constructor、每个基础类型都有可声明的长度/范围/枚举上限），不含任何
// Thunderbird/XPCOM 依赖，可在普通 Node 环境下单测。
//
// extension/bridge/api.js 中维护一份行为等价的纯 JS 实现（该文件运行在
// Experiment 特权 script 作用域中，无法直接 import 这里的编译产物），两者
// 靠测试保持同步，与仓库里 canonical()/isEd25519Spki() 等既有的“TS 参考实现 +
// 特权 JS 镜像实现”约定一致。

export const DANGEROUS_KEYS: ReadonlySet<string> = new Set(["__proto__", "prototype", "constructor"]);

export type JsonSchema =
  | { readonly type: "string"; readonly minLength?: number; readonly maxLength?: number; readonly pattern?: RegExp; readonly enum?: readonly string[] }
  | { readonly type: "integer"; readonly minimum?: number; readonly maximum?: number }
  | { readonly type: "boolean" }
  | { readonly type: "literal"; readonly value: string }
  | { readonly type: "array"; readonly items: JsonSchema; readonly minItems?: number; readonly maxItems?: number }
  | { readonly type: "object"; readonly properties: Readonly<Record<string, JsonSchema>>; readonly required: readonly string[] };

export interface ValidationFailure {
  readonly path: string;
  readonly message: string;
}

export type ValidationResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly errors: readonly ValidationFailure[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateNode(schema: JsonSchema, value: unknown, path: string, errors: ValidationFailure[]): void {
  switch (schema.type) {
    case "string": {
      if (typeof value !== "string") { errors.push({ path, message: "必须是字符串" }); return; }
      if (schema.minLength !== undefined && value.length < schema.minLength) errors.push({ path, message: `长度不得小于 ${schema.minLength}` });
      if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push({ path, message: `长度不得大于 ${schema.maxLength}` });
      if (schema.pattern !== undefined && !schema.pattern.test(value)) errors.push({ path, message: "格式不合法" });
      if (schema.enum !== undefined && !schema.enum.includes(value)) errors.push({ path, message: "不在允许的枚举范围内" });
      return;
    }
    case "integer": {
      if (!Number.isInteger(value)) { errors.push({ path, message: "必须是整数" }); return; }
      const numeric = value as number;
      if (schema.minimum !== undefined && numeric < schema.minimum) errors.push({ path, message: `不得小于 ${schema.minimum}` });
      if (schema.maximum !== undefined && numeric > schema.maximum) errors.push({ path, message: `不得大于 ${schema.maximum}` });
      return;
    }
    case "boolean": {
      if (typeof value !== "boolean") errors.push({ path, message: "必须是布尔值" });
      return;
    }
    case "literal": {
      if (value !== schema.value) errors.push({ path, message: `必须恰好等于 ${JSON.stringify(schema.value)}` });
      return;
    }
    case "array": {
      if (!Array.isArray(value)) { errors.push({ path, message: "必须是数组" }); return; }
      if (schema.minItems !== undefined && value.length < schema.minItems) errors.push({ path, message: `元素数量不得少于 ${schema.minItems}` });
      if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push({ path, message: `元素数量不得多于 ${schema.maxItems}` });
      value.forEach((item, index) => validateNode(schema.items, item, `${path}[${index}]`, errors));
      return;
    }
    case "object": {
      if (!isPlainObject(value)) { errors.push({ path, message: "必须是 JSON 对象" }); return; }
      const keys = Object.keys(value);
      for (const key of keys) {
        if (DANGEROUS_KEYS.has(key)) { errors.push({ path: `${path}.${key}`, message: "禁止的键名" }); continue; }
        if (!Object.hasOwn(schema.properties, key)) { errors.push({ path: `${path}.${key}`, message: "未知字段" }); continue; }
        validateNode(schema.properties[key] as JsonSchema, value[key], `${path}.${key}`, errors);
      }
      for (const key of schema.required) {
        if (!Object.hasOwn(value, key)) errors.push({ path: `${path}.${key}`, message: "缺少必填字段" });
      }
      return;
    }
  }
}

export function validate(schema: JsonSchema, value: unknown): ValidationResult {
  const errors: ValidationFailure[] = [];
  validateNode(schema, value, "$", errors);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// 常用字段构造器 —— 每条邮件 route 的具体 schema 由实现该 route 的 PR 定义，
// 这里只冻结跨 route 复用的基础形状（opaque ref 格式、空 body、ISO 时间戳）。
// ---------------------------------------------------------------------------

export const EMPTY_OBJECT_SCHEMA: JsonSchema = { type: "object", properties: {}, required: [] };

export function opaqueRefSchema(kind: string): JsonSchema {
  return { type: "string", pattern: new RegExp(`^${kind}_[A-Za-z0-9_-]{16,128}$`), maxLength: 8 + 128 };
}

export const ISO_TIMESTAMP_SCHEMA: JsonSchema = { type: "string", minLength: 20, maxLength: 40, pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/ };

export function boundedArraySchema(items: JsonSchema, maxItems: number): JsonSchema {
  return { type: "array", items, minItems: 0, maxItems };
}
