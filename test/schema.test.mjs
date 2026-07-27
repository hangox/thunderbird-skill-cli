// 纯单元测试：extension/src/schema.ts 编译产物（extension/dist/schema.js）。
// 不依赖任何 XPCOM/Experiment 夹具。
import assert from "node:assert/strict";
import { test } from "node:test";
import { EMPTY_OBJECT_SCHEMA, ISO_TIMESTAMP_SCHEMA, boundedArraySchema, opaqueRefSchema, validate } from "../extension/dist/schema.js";

function errorPaths(result) {
  assert.equal(result.ok, false);
  return result.errors.map((error) => error.path);
}

test("string：类型/长度/pattern/enum 校验", () => {
  const schema = { type: "string", minLength: 2, maxLength: 4, pattern: /^[a-z]+$/, enum: ["ab", "abc", "abcd"] };
  assert.equal(validate(schema, "abc").ok, true);
  assert.equal(validate(schema, 1).ok, false, "非字符串");
  assert.equal(validate(schema, "a").ok, false, "太短");
  assert.equal(validate(schema, "abcde").ok, false, "太长（同时违反 enum 和 maxLength）");
  assert.equal(validate({ type: "string", pattern: /^[a-z]+$/ }, "ABC").ok, false, "不匹配 pattern");
  assert.equal(validate({ type: "string", enum: ["x", "y"] }, "z").ok, false, "不在 enum 内");
});

test("integer：类型/范围校验，拒绝小数与字符串数字", () => {
  const schema = { type: "integer", minimum: 0, maximum: 10 };
  assert.equal(validate(schema, 5).ok, true);
  assert.equal(validate(schema, 5.5).ok, false, "小数不是 integer");
  assert.equal(validate(schema, "5").ok, false, "字符串数字必须被拒绝");
  assert.equal(validate(schema, -1).ok, false, "小于 minimum");
  assert.equal(validate(schema, 11).ok, false, "大于 maximum");
});

test("boolean 与 literal", () => {
  assert.equal(validate({ type: "boolean" }, true).ok, true);
  assert.equal(validate({ type: "boolean" }, "true").ok, false);
  assert.equal(validate({ type: "literal", value: "POST" }, "POST").ok, true);
  assert.equal(validate({ type: "literal", value: "POST" }, "post").ok, false, "大小写敏感");
});

test("array：类型/元素数量/逐项校验，错误路径带下标", () => {
  const schema = { type: "array", items: { type: "integer" }, minItems: 1, maxItems: 3 };
  assert.equal(validate(schema, [1, 2]).ok, true);
  assert.equal(validate(schema, "not-array").ok, false);
  assert.equal(validate(schema, []).ok, false, "少于 minItems");
  assert.equal(validate(schema, [1, 2, 3, 4]).ok, false, "多于 maxItems");
  const badItem = validate(schema, [1, "x", 3]);
  assert.equal(badItem.ok, false);
  assert.ok(errorPaths(badItem).some((path) => path === "$[1]"), "非法元素的错误路径应指向下标");
});

test("object：拒绝未知字段，强制 required，逐字段校验并携带路径", () => {
  const schema = { type: "object", properties: { name: { type: "string" }, age: { type: "integer" } }, required: ["name"] };
  assert.equal(validate(schema, { name: "a" }).ok, true);
  assert.equal(validate(schema, { name: "a", age: 1 }).ok, true);
  assert.equal(validate(schema, "not-object").ok, false);

  const missing = validate(schema, {});
  assert.equal(missing.ok, false);
  assert.ok(errorPaths(missing).includes("$.name"));

  const unknown = validate(schema, { name: "a", extra: 1 });
  assert.equal(unknown.ok, false);
  assert.ok(errorPaths(unknown).includes("$.extra"));

  const badField = validate(schema, { name: "a", age: "old" });
  assert.equal(badField.ok, false);
  assert.ok(errorPaths(badField).includes("$.age"));
});

test("object：拒绝 __proto__/prototype/constructor（含嵌套），不当作未知字段而是危险键单独报告", () => {
  const schema = { type: "object", properties: { nested: { type: "object", properties: {}, required: [] } }, required: [] };
  for (const key of ["__proto__", "prototype", "constructor"]) {
    const topLevel = validate(schema, JSON.parse(`{"${key}": {"x": 1}}`));
    assert.equal(topLevel.ok, false, key);
    assert.ok(errorPaths(topLevel).includes(`$.${key}`), key);

    const nested = validate(schema, { nested: JSON.parse(`{"${key}": {"x": 1}}`) });
    assert.equal(nested.ok, false, `nested ${key}`);
    assert.ok(errorPaths(nested).includes(`$.nested.${key}`), `nested ${key}`);
  }
});

test("EMPTY_OBJECT_SCHEMA 只接受 {}，任何字段都是未知字段", () => {
  assert.equal(validate(EMPTY_OBJECT_SCHEMA, {}).ok, true);
  assert.equal(validate(EMPTY_OBJECT_SCHEMA, { anything: 1 }).ok, false);
});

test("opaqueRefSchema 生成的 pattern 匹配对应 kind 前缀的 token，拒绝其他 kind 或畸形值", () => {
  const schema = opaqueRefSchema("msg");
  assert.equal(validate(schema, `msg_${"a".repeat(20)}`).ok, true);
  assert.equal(validate(schema, `folder_${"a".repeat(20)}`).ok, false, "kind 前缀不符");
  assert.equal(validate(schema, "msg_short").ok, false, "低于最短随机段长度");
  assert.equal(validate(schema, "msg_" + "a".repeat(200)).ok, false, "超过最大长度");
});

test("ISO_TIMESTAMP_SCHEMA 接受标准 ISO 8601 UTC 时间戳，拒绝无时区/非法格式", () => {
  assert.equal(validate(ISO_TIMESTAMP_SCHEMA, "2026-07-24T12:00:00Z").ok, true);
  assert.equal(validate(ISO_TIMESTAMP_SCHEMA, "2026-07-24T12:00:00.123Z").ok, true);
  assert.equal(validate(ISO_TIMESTAMP_SCHEMA, "2026-07-24T12:00:00").ok, false, "缺少 Z");
  assert.equal(validate(ISO_TIMESTAMP_SCHEMA, "not-a-date").ok, false);
});

test("boundedArraySchema 生成的 schema 遵守指定的 maxItems 上限", () => {
  const schema = boundedArraySchema({ type: "string" }, 2);
  assert.equal(validate(schema, ["a", "b"]).ok, true);
  assert.equal(validate(schema, ["a", "b", "c"]).ok, false);
  assert.equal(validate(schema, []).ok, true, "minItems 默认 0，允许空数组");
});
