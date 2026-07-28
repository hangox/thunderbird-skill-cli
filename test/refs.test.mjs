// 纯单元测试：extension/src/refs.ts 编译产物（extension/dist/refs.js）。
// 不依赖任何 XPCOM/Experiment 夹具——RefStore 是与运行环境无关的内存原语。
import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_REF_TTL_MS, RefStore, RefStoreCapacityError, refPattern } from "../extension/dist/refs.js";

/** 确定性的 fake random source：递增计数器代替真随机，nowMs 可外部推进。 */
function fakeSource(startMs = 1_700_000_000_000) {
  let counter = 0;
  let nowMs = startMs;
  return {
    randomHex(length) { counter += 1; return counter.toString(16).padStart(length * 2, "0"); },
    nowMs() { return nowMs; },
    advance(ms) { nowMs += ms; },
  };
}

const CONTEXT = (overrides = {}) => ({ clientId: "client_a", pairingEpoch: "0", nowMs: Date.now(), ...overrides });

test("issue 返回符合 kind 前缀格式的 token，resolve 能取回原始 payload", () => {
  const source = fakeSource();
  const store = new RefStore(source);
  const token = store.issue("msg", "client_a", "0", { subject: "hello" }, 60_000);
  assert.match(token, refPattern("msg"));
  const resolved = store.resolve(token, "msg", CONTEXT({ nowMs: source.nowMs() }));
  assert.deepEqual(resolved, { subject: "hello" });
});

test("resolve 在 kind/clientId/pairingEpoch 任一不符时返回 undefined，不泄漏存在与否", () => {
  const source = fakeSource();
  const store = new RefStore(source);
  const token = store.issue("msg", "client_a", "0", { subject: "hello" }, 60_000);
  const now = source.nowMs();
  assert.equal(store.resolve(token, "folder", CONTEXT({ nowMs: now })), undefined, "kind 不符");
  assert.equal(store.resolve(token, "msg", CONTEXT({ nowMs: now, clientId: "client_b" })), undefined, "clientId 不符");
  assert.equal(store.resolve(token, "msg", CONTEXT({ nowMs: now, pairingEpoch: "1" })), undefined, "pairingEpoch 不符");
  assert.equal(store.resolve("msg_不存在的token00000000000", "msg", CONTEXT({ nowMs: now })), undefined, "token 不存在");
  // 正确的组合仍必须成立，证明上面四条不是因为链路整体坏掉。
  assert.deepEqual(store.resolve(token, "msg", CONTEXT({ nowMs: now })), { subject: "hello" });
});

test("过期后 resolve 返回 undefined 并从 store 中移除", () => {
  const source = fakeSource();
  const store = new RefStore(source);
  const token = store.issue("op", "client_a", "0", { id: 1 }, 1_000);
  source.advance(1_001);
  assert.equal(store.resolve(token, "op", CONTEXT({ nowMs: source.nowMs() })), undefined);
  assert.equal(store.size, 0, "过期条目应被清理，不应无限期占用内存");
});

test("prune 主动回收过期条目，未过期条目保留", () => {
  const source = fakeSource();
  const store = new RefStore(source);
  const short = store.issue("undo", "client_a", "0", { id: "short" }, 100);
  const long = store.issue("undo", "client_a", "0", { id: "long" }, 100_000);
  source.advance(200);
  store.prune();
  assert.equal(store.size, 1);
  assert.equal(store.resolve(short, "undo", CONTEXT({ nowMs: source.nowMs() })), undefined);
  assert.deepEqual(store.resolve(long, "undo", CONTEXT({ nowMs: source.nowMs() })), { id: "long" });
});

test("consume 使一次性 token 立即失效，即使未过期", () => {
  const source = fakeSource();
  const store = new RefStore(source);
  const token = store.issue("confirm", "client_a", "0", { ok: true }, 60_000);
  store.consume(token);
  assert.equal(store.resolve(token, "confirm", CONTEXT({ nowMs: source.nowMs() })), undefined);
});

test("revokeAllForClient 只清除该 client 的 ref，不影响其他 client", () => {
  const source = fakeSource();
  const store = new RefStore(source);
  const tokenA = store.issue("msg", "client_a", "0", { owner: "a" }, 60_000);
  const tokenB = store.issue("msg", "client_b", "0", { owner: "b" }, 60_000);
  store.revokeAllForClient("client_a");
  assert.equal(store.resolve(tokenA, "msg", CONTEXT({ clientId: "client_a", nowMs: source.nowMs() })), undefined);
  assert.deepEqual(store.resolve(tokenB, "msg", CONTEXT({ clientId: "client_b", nowMs: source.nowMs() })), { owner: "b" });
});

test("clear 清空全部条目", () => {
  const source = fakeSource();
  const store = new RefStore(source);
  store.issue("msg", "client_a", "0", {}, 60_000);
  store.issue("folder", "client_a", "0", {}, 60_000);
  store.clear();
  assert.equal(store.size, 0);
});

test("ttlMs 非正数/非有限数一律 RangeError，超过 MAX_REF_TTL_MS 也 RangeError", () => {
  const source = fakeSource();
  const store = new RefStore(source);
  for (const ttlMs of [0, -1, NaN, Infinity, -Infinity]) {
    assert.throws(() => store.issue("msg", "client_a", "0", {}, ttlMs), RangeError, String(ttlMs));
  }
  assert.throws(() => store.issue("msg", "client_a", "0", {}, MAX_REF_TTL_MS + 1), RangeError);
  // 边界值本身必须允许。
  assert.doesNotThrow(() => store.issue("msg", "client_a", "0", {}, MAX_REF_TTL_MS));
});

test("单 kind 配额耗尽抛出 RefStoreCapacityError，不静默驱逐仍有效的条目", () => {
  const source = fakeSource();
  const store = new RefStore(source, 2, 100);
  store.issue("msg", "client_a", "0", { n: 1 }, 60_000);
  store.issue("msg", "client_a", "0", { n: 2 }, 60_000);
  assert.throws(() => store.issue("msg", "client_a", "0", { n: 3 }, 60_000), (error) => {
    assert.ok(error instanceof RefStoreCapacityError);
    assert.equal(error.kind, "msg");
    assert.equal(error.limit, 2);
    return true;
  });
  assert.equal(store.size, 2, "拒绝签发新 ref 不应影响已有的两个有效条目");
  // 另一个 kind 不受影响。
  assert.doesNotThrow(() => store.issue("folder", "client_a", "0", { n: 1 }, 60_000));
});

test("跨 kind 全局配额耗尽抛出 RefStoreCapacityError(kind: '*')，即使各 kind 各自未超限", () => {
  const source = fakeSource();
  const store = new RefStore(source, 100, 3);
  store.issue("msg", "client_a", "0", {}, 60_000);
  store.issue("folder", "client_a", "0", {}, 60_000);
  store.issue("draft", "client_a", "0", {}, 60_000);
  assert.throws(() => store.issue("op", "client_a", "0", {}, 60_000), (error) => {
    assert.ok(error instanceof RefStoreCapacityError);
    assert.equal(error.kind, "*");
    assert.equal(error.limit, 3);
    return true;
  });
});

test("配额耗尽后过期腾出空间，再次 issue 成功（压力回收）", () => {
  const source = fakeSource();
  const store = new RefStore(source, 1, 100);
  store.issue("msg", "client_a", "0", { n: 1 }, 100);
  assert.throws(() => store.issue("msg", "client_a", "0", { n: 2 }, 60_000), RefStoreCapacityError);
  source.advance(200);
  // issue() 内部先 prune() 再判定配额，过期条目应被回收，腾出名额。
  const token = store.issue("msg", "client_a", "0", { n: 3 }, 60_000);
  assert.deepEqual(store.resolve(token, "msg", CONTEXT({ nowMs: source.nowMs() })), { n: 3 });
});

test("refPattern 与实际签发的 token 形状一致，且不同 kind 互不匹配", () => {
  const source = fakeSource();
  const store = new RefStore(source);
  const msgToken = store.issue("msg", "client_a", "0", {}, 60_000);
  assert.match(msgToken, refPattern("msg"));
  assert.doesNotMatch(msgToken, refPattern("folder"));
});
