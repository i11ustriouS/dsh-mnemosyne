/**
 * 来源识别与单向隔离的测试。
 *
 * 隔离规则（用户选定）：
 *   - QQ 会话只召回 QQ 自己的记忆（看不到 DSH 网页里的对话）
 *   - DSH 侧不限来源，所以能翻到群里说过什么
 *   - 未标 origin 的存量数据按 local 处理
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ORIGIN,
  describeUmo,
  readIngressSessions,
  resetOriginCache,
  resolveOrigin,
} from "../lib/origin.js";
import { createRecall } from "../lib/recall.js";

let passed = 0;
const failed = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed.push({ name, message: error.message });
    console.log(`  ✗ ${name}\n      ${error.message}`);
  }
}

function eq(actual, expected, label = "") {
  if (actual !== expected) throw new Error(`${label} 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

console.log("[origin] 来源识别");

// 造一个假的 DSH_HOME，里面放 ingress 的 sessions.json
const dshHome = mkdtempSync(join(tmpdir(), "mnemo-origin-"));
const ingressDir = join(dshHome, "dsh-astrbot-ingress");
mkdirSync(ingressDir, { recursive: true });
writeFileSync(join(ingressDir, "sessions.json"), JSON.stringify({
  "123456789": { sessionId: "session-qq-group", cwd: "D:/work", chatType: "group", senderId: "u987", updatedAt: 1 },
  "123456789#u987654321": { sessionId: "session-qq-private", cwd: "D:/work", chatType: "private", senderId: "u987654321", updatedAt: 2 },
}, null, 2), "utf8");
resetOriginCache();

check("ingress 映射表可读", () => {
  const map = readIngressSessions(dshHome);
  eq(map.size, 2, "条目数");
  eq(map.get("session-qq-group").umo, "123456789", "umo");
  eq(map.get("session-qq-group").chatType, "group", "chatType");
});

check("群会话识别为 QQ 群聊", () => {
  const info = resolveOrigin("session-qq-group", dshHome);
  eq(info.origin, ORIGIN.QQ, "origin");
  eq(info.chatType, "group", "chatType");
  eq(info.tags.includes("qq"), true, "含 qq 标签");
  eq(info.tags.includes("qq-group"), true, "含 qq-group 标签");
  eq(info.tags.includes("astrbot"), true, "含 astrbot 标签");
});

check("私聊会话识别为 QQ 私聊", () => {
  const info = resolveOrigin("session-qq-private", dshHome);
  eq(info.origin, ORIGIN.QQ, "origin");
  eq(info.tags.includes("qq-private"), true, "含 qq-private 标签");
  eq(info.tags.includes("qq-group"), false, "不含 qq-group");
});

check("未知会话识别为 local 且无标签", () => {
  const info = resolveOrigin("session-web-123", dshHome);
  eq(info.origin, ORIGIN.LOCAL, "origin");
  eq(info.tags.length, 0, "无标签");
  eq(info.umo, "", "无 umo");
});

check("空 sessionId 安全返回 local", () => {
  eq(resolveOrigin("", dshHome).origin, ORIGIN.LOCAL);
  eq(resolveOrigin(undefined, dshHome).origin, ORIGIN.LOCAL);
});

check("ingress 未安装时安全降级", () => {
  const emptyHome = mkdtempSync(join(tmpdir(), "mnemo-noingress-"));
  resetOriginCache();
  const info = resolveOrigin("session-qq-group", emptyHome);
  eq(info.origin, ORIGIN.LOCAL, "origin");
  eq(info.tags.length, 0, "无标签");
  rmSync(emptyHome, { recursive: true, force: true });
});

check("umo 可读化", () => {
  eq(describeUmo("123456789"), "群 123456789");
  eq(describeUmo("123456789#u987"), "群 123456789 · 用户 987");
  eq(describeUmo(""), "");
});

// ── 单向隔离 ────────────────────────────────────────────────────────────────
console.log("\n[origin] 单向隔离");

const now = Date.now();
const entries = [
  { id: "mv-qq-1", t: now - 1000, kind: "event", summary: "QQ 群里聊了游戏服务器的事", user: "群里聊游戏服务器", assistant: "好的", keywords: ["游戏服务器"], entities: ["游戏服务器"], tags: ["qq", "qq-group"], origin: "qq", umo: "123456789", hits: 0 },
  { id: "mv-local-1", t: now - 2000, kind: "event", summary: "在网页里讨论了游戏服务器的部署方案", user: "游戏服务器部署方案", assistant: "可以这样", keywords: ["游戏服务器", "部署"], entities: ["游戏服务器"], tags: [], origin: "local", hits: 0 },
  { id: "mv-legacy-1", t: now - 3000, kind: "event", summary: "旧数据没有 origin 字段，讲游戏服务器", user: "游戏服务器", assistant: "嗯", keywords: ["游戏服务器"], entities: ["游戏服务器"], tags: [], hits: 0 },
];

const recall = createRecall({ maxRecall: 8 });
recall.rebuild(entries);

check("DSH 侧（无 scope）能看到两个来源", () => {
  const r = recall.recall("游戏服务器", { limit: 8 });
  const ids = r.all.map((hit) => hit.entry.id).sort();
  eq(ids.includes("mv-qq-1"), true, "应含 QQ 条目");
  eq(ids.includes("mv-local-1"), true, "应含本地条目");
  eq(ids.includes("mv-legacy-1"), true, "应含旧数据条目");
});

check("QQ 侧（scope=qq）看不到本地与旧数据", () => {
  const r = recall.recall("游戏服务器", { limit: 8, originScope: "qq" });
  const ids = r.all.map((hit) => hit.entry.id);
  eq(ids.includes("mv-qq-1"), true, "应含 QQ 条目");
  eq(ids.includes("mv-local-1"), false, "不该含本地条目");
  eq(ids.includes("mv-legacy-1"), false, "旧数据按 local 处理，不该含");
});

check("scope=local 只看本地（含无 origin 的旧数据）", () => {
  const r = recall.recall("游戏服务器", { limit: 8, originScope: "local" });
  const ids = r.all.map((hit) => hit.entry.id);
  eq(ids.includes("mv-qq-1"), false, "不该含 QQ 条目");
  eq(ids.includes("mv-local-1"), true, "应含本地条目");
  eq(ids.includes("mv-legacy-1"), true, "旧数据应含");
});

check("无检索词时也受隔离约束", () => {
  const r = recall.recall("", { limit: 8, originScope: "qq" });
  const ids = r.all.map((hit) => hit.entry.id);
  eq(ids.includes("mv-qq-1"), true, "应含 QQ 条目");
  eq(ids.includes("mv-local-1"), false, "不该含本地条目");
});

check("隔离不影响标签过滤（test 仍被排除）", () => {
  const withTest = createRecall({ maxRecall: 8 });
  withTest.rebuild([...entries, { id: "mv-test-1", t: now, kind: "event", summary: "游戏服务器自检", user: "游戏服务器", assistant: "x", keywords: ["游戏服务器"], entities: [], tags: ["test"], origin: "qq", hits: 0 }]);
  const r = withTest.recall("游戏服务器", { limit: 8, originScope: "qq" });
  const ids = r.all.map((hit) => hit.entry.id);
  eq(ids.includes("mv-test-1"), false, "test 标签仍应被排除");
});

rmSync(dshHome, { recursive: true, force: true });

console.log(`\n${failed.length === 0 ? "✅" : "❌"} 通过 ${passed} 项，失败 ${failed.length} 项`);
if (failed.length > 0) {
  console.log("\n失败明细：");
  for (const f of failed) console.log(` - ${f.name}: ${f.message}`);
  process.exitCode = 1;
}