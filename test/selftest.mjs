/**
 * 离线自检：不依赖 DSH 运行时，直接验证分词、索引、检索、存储、注入渲染。
 * 运行：node test/selftest.mjs
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import assert from "node:assert/strict";

import { clampText, detectKind, extractEntities, extractFacts, extractProfileHints, firstSentence, kindLabel, ruleSummary, tokenize, topKeywords } from "../lib/text.js";
import { createStore, newEntryId, normalizeProfile, monthKey } from "../lib/store.js";
import { createRecall, normalizeEntry, parseTimeHint, renderCard } from "../lib/recall.js";
import { composeFrame, factSlot, isActive, isFrameworkEcho as factIsEcho, isPathLike as factIsPath, normalizeFact, renderFactLine, resolveFacts, sameFactValue } from "../lib/facts.js";
import { fallbackSummary, parseSummaryJson, renderHitLines, renderInjection, summarizeWithLlm } from "../lib/summarize.js";
import { buildTopics, renderTopicCard } from "../lib/topics.js";
import { decodeSessionFile, runBackfill, turnsFromEvents } from "../lib/backfill.js";
import { PERSONA_PROMPT, buildPersonaInput, buildPersonaWithLlm, isFrameworkEcho, isPathLike, isProcessEvent, normalizePersonaDraft, sameEvent } from "../lib/persona.js";
import { buildDigest, findDuplicateGroups, isDigestCandidate, pickArchiveCandidates, planConsolidation, similarity, tokenSet } from "../lib/consolidate.js";

let passed = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    failures.push(`${name}: ${error.message}`);
    console.log(`  ✗ ${name} → ${error.message}`);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    failures.push(`${name}: ${error.message}`);
    console.log(`  ✗ ${name} → ${error.message}`);
  }
}

// ── 文本层 ──────────────────────────────────────────────────────────────────
console.log("\n[text] 分词与抽取");

check("中文 bigram 切分", () => {
  const tokens = tokenize("用户想要扩充漏洞库");
  assert.ok(tokens.includes("漏洞"), "应包含「漏洞」");
  assert.ok(tokens.includes("扩充"), "应包含「扩充」");
});

check("停用词被过滤", () => {
  const tokens = tokenize("的了是我你");
  assert.equal(tokens.length, 0, `不应有 token，实际：${tokens.join(",")}`);
});

check("英文词归一化", () => {
  const tokens = tokenize("Deploy the Memory Vault");
  assert.ok(tokens.includes("deploy"));
  assert.ok(tokens.includes("memory"));
  assert.ok(!tokens.includes("the"));
});

check("实体：引号与文件名", () => {
  const entities = extractEntities('把「记忆女神」写到 D:\\记忆女神\\mnemosyne\\index.js');
  assert.ok(entities.includes("记忆女神"), `缺引号实体：${entities.join(",")}`);
  assert.ok(entities.some((e) => e.endsWith("index.js")), `缺文件名：${entities.join(",")}`);
});

check("实体：版本号与日期", () => {
  const entities = extractEntities("2026-10-22 升级到 v0.2.0");
  assert.ok(entities.includes("v0.2.0") || entities.includes("0.2.0"), `缺版本号：${entities.join(",")}`);
  assert.ok(entities.includes("2026-10-22"), `缺日期：${entities.join(",")}`);
});

check("事件类型：人设", () => {
  assert.equal(detectKind("以后叫我老王就行"), "identity");
});

check("事件类型：决策", () => {
  assert.equal(detectKind("决定用 SQLite 存，方案定了"), "decision");
});

check("事件类型：默认闲聊", () => {
  assert.equal(detectKind("今天天气不错"), "chat");
});

check("关键词排序稳定", () => {
  const keywords = topKeywords("记忆女神 记忆女神 记忆女神 插件", 3);
  assert.ok(keywords.includes("记忆女神"));
});

check("规则摘要包含双方", () => {
  const summary = ruleSummary("帮我写个记忆女神插件。", "已经写好了第一版。");
  assert.ok(summary.includes("用户"));
  assert.ok(summary.includes("回应"));
});

check("截断不劈开代理对", () => {
  const emoji = "😀😀😀";
  const out = clampText(emoji, 3);
  assert.ok(!out.includes("\uFFFD"));
});

// ── 存储层 ──────────────────────────────────────────────────────────────────
console.log("\n[store] 存储与回放");

const tempRoot = mkdtempSync(join(tmpdir(), "mv-selftest-"));

check("月份分片名", () => {
  const t = new Date(2026, 9, 22).getTime();
  assert.equal(monthKey(t), "2026-10");
});

check("写入 / 读取回放", () => {
  const store = createStore(tempRoot, { logger: { warn() {} } });
  const entry = { id: "mv-t1", t: Date.now(), kind: "event", user: "hello", assistant: "hi", summary: "打招呼", keywords: ["hello"], entities: [] };
  store.put(entry);
  const list = store.listEntries();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "mv-t1");
});

check("更新同 id 覆盖", () => {
  const store = createStore(tempRoot, { logger: { warn() {} } });
  store.put({ id: "mv-t1", t: Date.now(), kind: "event", user: "hello", assistant: "hi", summary: "更新后的摘要", keywords: [], entities: [] });
  const list = store.listEntries();
  assert.equal(list.length, 1, "同一 id 不应产生两条");
  assert.equal(list[0].summary, "更新后的摘要");
});

check("删除条目", () => {
  const store = createStore(tempRoot, { logger: { warn() {} } });
  assert.equal(store.remove("mv-t1"), true);
  assert.equal(store.listEntries().length, 0);
  assert.equal(store.remove("mv-not-exist"), false);
});

check("重启后从磁盘恢复", () => {
  const store = createStore(tempRoot, { logger: { warn() {} } });
  store.put({ id: "mv-t2", t: Date.now(), kind: "chat", user: "a", assistant: "b", summary: "c", keywords: [], entities: [] });
  const fresh = createStore(tempRoot, { logger: { warn() {} } });
  const list = fresh.listEntries();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "mv-t2");
});

check("损坏行不影响其它条目", () => {
  const dir = join(tempRoot, "entries");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "2026-10.jsonl");
  writeFileSync(file, '{"op":"put","entry":{"id":"mv-t3","t":1,"kind":"chat","user":"x","assistant":"","summary":"s","keywords":[],"entities":[]}}\n{坏行}\n', "utf8");
  const store = createStore(tempRoot, { logger: { warn() {} } });
  assert.ok(store.listEntries().some((e) => e.id === "mv-t3"));
});

check("profile 原子读写与归一化", () => {
  const store = createStore(tempRoot, { logger: { warn() {} } });
  const saved = store.writeProfile({ user: { name: "老王", nicknames: ["王哥", ""] }, personality: ["直接"] });
  assert.equal(saved.user.name, "老王");
  assert.deepEqual(saved.user.nicknames, ["王哥"]);
  const again = store.readProfile();
  assert.equal(again.user.name, "老王");
});

check("profile 容忍脏数据", () => {
  const p = normalizeProfile({ user: "坏值", personality: "不是数组", events: [{ text: "ok", t: 1 }, null] });
  assert.equal(p.user.name, "");
  assert.deepEqual(p.personality, []);
  assert.equal(p.events.length, 1);
});

check("超出上限淘汰最旧", () => {
  const root = mkdtempSync(join(tmpdir(), "mv-prune-"));
  const store = createStore(root, { maxEntries: 100, logger: { warn() {} } });
  const now = Date.now();
  for (let i = 0; i < 130; i += 1) {
    store.put({ id: `mv-p${i}`, t: now - i * 1000, kind: "chat", user: `u${i}`, assistant: "", summary: `s${i}`, keywords: [], entities: [] });
  }
  const list = store.listEntries();
  assert.equal(list.length, 100, `应剩 100 条，实际 ${list.length}`);
  assert.ok(!list.some((e) => e.id === "mv-p129"), "最旧的应被淘汰");
  rmSync(root, { recursive: true, force: true });
});

// ── 索引与检索 ──────────────────────────────────────────────────────────────
console.log("\n[recall] 索引与召回");

const now = Date.now();
const DAY = 86400000;
const fixture = [
  {
    id: "mv-a",
    t: now - 2 * DAY,
    kind: "event",
    sessionId: "s1",
    sessionTitle: "记忆女神插件",
    user: "帮我做一个 AI 对话记忆女神插件，要能自动总结",
    assistant: "好的，先做存储和索引。",
    summary: "用户要求开发对话记忆女神插件，需自动总结每轮对话",
    keywords: ["记忆女神", "插件", "自动总结"],
    entities: ["记忆女神插件"],
  },
  {
    id: "mv-b",
    t: now - 2 * DAY + 60000,
    kind: "decision",
    sessionId: "s1",
    user: "存储用什么？",
    assistant: "用 JSONL 分片追加，不引第三方依赖。",
    summary: "决定用 JSONL 分片追加存储，不引入第三方依赖",
    keywords: ["存储", "JSONL"],
    entities: ["JSONL"],
  },
  {
    id: "mv-c",
    t: now - 40 * DAY,
    kind: "event",
    sessionId: "s2",
    sessionTitle: "安卓测试工具",
    user: "漏洞库规则不够，要扩充",
    assistant: "扩到 302 条。",
    summary: "安卓测试工具漏洞库从 27 条扩充到 302 条",
    keywords: ["漏洞库", "规则", "安卓"],
    entities: ["安卓测试工具", "漏洞库"],
  },
  {
    id: "mv-d",
    t: now - 39 * DAY,
    kind: "identity",
    sessionId: "s2",
    user: "以后叫我老王",
    assistant: "好的老王。",
    summary: "用户要求称呼其为老王",
    keywords: ["称呼", "老王"],
    entities: ["老王"],
  },
];

check("索引构建", () => {
  const recall = createRecall();
  const n = recall.rebuild(fixture);
  assert.equal(n, 4);
  assert.equal(recall.size(), 4);
});

check("中文检索命中", () => {
  const recall = createRecall();
  recall.rebuild(fixture);
  const result = recall.recall("记忆女神怎么存");
  assert.ok(result.primary.length > 0, "应命中记忆女神相关条目");
  assert.equal(result.primary[0].entry.id, "mv-a", `首条应为 mv-a，实际 ${result.primary[0].entry.id}`);
});

check("英文/技术词检索命中", () => {
  const recall = createRecall();
  recall.rebuild(fixture);
  const result = recall.recall("JSONL");
  assert.ok(result.all.some((hit) => hit.entry.id === "mv-b"));
});

check("不相干查询不误报", () => {
  const recall = createRecall();
  recall.rebuild(fixture);
  const result = recall.recall("量子纠缠退相干");
  assert.equal(result.primary.length, 0, `不应命中，实际 ${result.primary.map((h) => h.entry.id).join(",")}`);
});

check("时间提示解析", () => {
  const hint = parseTimeHint("昨天那个事");
  assert.ok(hint !== null && hint.from < hint.to);
  const exact = parseTimeHint("2026-10-22 的会议");
  assert.ok(exact !== null);
});

check("思考延伸带出同会话上下文", () => {
  const recall = createRecall();
  recall.rebuild(fixture);
  const result = recall.recall("记忆女神怎么存", { limit: 1 });
  assert.ok(result.extra.some((hit) => hit.entry.id === "mv-b"), `延伸应包含同会话的 mv-b，实际 ${result.extra.map((h) => h.entry.id).join(",")}`);
});

check("共享对象延伸", () => {
  const recall = createRecall();
  recall.rebuild(fixture);
  const result = recall.recall("安卓测试工具", { limit: 1 });
  const ids = result.all.map((hit) => hit.entry.id);
  assert.ok(ids.includes("mv-c"), `应命中 mv-c，实际 ${ids.join(",")}`);
});

check("删除后不再命中", () => {
  const recall = createRecall();
  recall.rebuild(fixture);
  recall.drop("mv-a");
  const result = recall.recall("记忆女神");
  assert.ok(!result.all.some((hit) => hit.entry.id === "mv-a"));
});

check("空索引不崩溃", () => {
  const recall = createRecall();
  const result = recall.recall("随便问问");
  assert.deepEqual(result.primary, []);
});

check("卡片渲染含 id 与类型", () => {
  const card = renderCard({ entry: normalizeEntry(fixture[0]), score: 1, reasons: ["关键词：记忆女神"] }, 0);
  assert.ok(card.includes("mv-a"));
  assert.ok(card.includes("事件"));
});

// ── 总结与注入 ──────────────────────────────────────────────────────────────
console.log("\n[summarize] 解析与注入渲染");

check("解析裸 JSON", () => {
  const parsed = parseSummaryJson('{"summary":"s","keywords":["a"],"kind":"event"}');
  assert.equal(parsed.summary, "s");
});

check("解析代码块包裹", () => {
  const parsed = parseSummaryJson('好的：\n```json\n{"summary":"x","kind":"task"}\n```');
  assert.equal(parsed.summary, "x");
});

check("解析尾逗号", () => {
  const parsed = parseSummaryJson('{"summary":"y","keywords":["a",],"kind":"chat",}');
  assert.equal(parsed.summary, "y");
});

check("解析失败返回 null", () => {
  assert.equal(parseSummaryJson("完全不是 JSON"), null);
});

check("规则降级摘要", () => {
  const result = fallbackSummary({ user: "帮我修一下插件。", assistant: "已经修好了。", t: now });
  assert.ok(result.summary.length > 0);
  assert.equal(result.source, "rule");
  assert.ok(Array.isArray(result.keywords));
});

await checkAsync("模型总结：正常返回", async () => {
  const stream = async function* () {
    yield { type: "text-delta", index: 0, text: '{"summary":"模型摘要","keywords":["k"],"entities":["e"],"kind":"event","profile":{"userName":"老王","personality":["直接"],"preference":[],"nickname":"","calledBy":"","event":""}}' };
    yield { type: "finish", reason: { kind: "stop" } };
  };
  const result = await summarizeWithLlm({
    route: { provider: "p", model: "m" },
    stream: (options) => stream(),
    turn: { user: "u", assistant: "a", t: now },
  });
  assert.ok(result !== null, "应返回结果");
  assert.equal(result.summary, "模型摘要");
  assert.equal(result.profile.userName, "老王");
});

await checkAsync("模型总结：流失败降级 null", async () => {
  const stream = async function* () {
    yield { type: "finish", reason: { kind: "error", failure: { message: "boom" } } };
  };
  const result = await summarizeWithLlm({
    route: { provider: "p", model: "m" },
    stream: () => stream(),
    turn: { user: "u", assistant: "a", t: now },
  });
  assert.equal(result, null);
});

await checkAsync("模型总结：没有 route 直接 null", async () => {
  const result = await summarizeWithLlm({ route: null, stream: () => (async function* () {})(), turn: { user: "u", assistant: "a", t: now } });
  assert.equal(result, null);
});

await checkAsync("模型总结：超时降级 null", async () => {
  const stream = async function* () {
    await new Promise((resolve) => setTimeout(resolve, 60));
    yield { type: "text-delta", index: 0, text: "{}" };
  };
  const result = await summarizeWithLlm({
    route: { provider: "p", model: "m" },
    stream: () => stream(),
    turn: { user: "u", assistant: "a", t: now },
    timeoutMs: 10,
  });
  assert.equal(result, null);
});

check("注入渲染含框架与卡片", () => {
  const recall = createRecall();
  recall.rebuild(fixture);
  const result = recall.recall("记忆女神");
  const text = renderInjection({
    profile: normalizeProfile({
      user: { name: "老王", nicknames: ["王哥"], calledBy: "老王", tone: "直接" },
      self: { persona: "务实", role: "助手" },
      personality: ["直接"],
      preferences: ["简洁"],
      events: [{ t: now, text: "完成第一版" }],
    }),
    recall: result,
    maxChars: 2600,
  });
  assert.ok(text.includes("老王"));
  assert.ok(text.includes("务实"));
  assert.ok(text.includes("相关记忆"));
  assert.ok(text.includes("mv-a"));
});

check("注入预算生效", () => {
  const recall = createRecall();
  recall.rebuild(fixture);
  const result = recall.recall("记忆女神");
  const text = renderInjection({
    profile: normalizeProfile({ notes: "x".repeat(5000) }),
    recall: result,
    maxChars: 500,
  });
  assert.ok(text.length < 1400, `应受预算约束，实际 ${text.length}`);
});

check("空库注入返回空串", () => {
  const text = renderInjection({ profile: normalizeProfile({}), recall: null, recent: [], maxChars: 1000 });
  assert.equal(text, "");
});

// ── A 档优化回归 ────────────────────────────────────────────────────────────
console.log("\n[optimize] 关键词质量 / 卡片压缩 / 记忆强度");

check("口语短段不进索引", () => {
  const tokens = tokenize("你好可以谢谢");
  assert.ok(!tokens.includes("你好"), `不应包含「你好」：${tokens.join(",")}`);
  assert.ok(!tokens.includes("可以"), `不应包含「可以」：${tokens.join(",")}`);
});

check("滑窗碎片不当关键词", () => {
  const keywords = topKeywords("用户要求写一个 AI 对话记忆女神插件，记忆女神要能自动总结每轮对话", 6);
  const junk = keywords.filter((k) => k === "忆库插" || k === "库插件" || k === "话记忆" || k === "忆库要");
  assert.equal(junk.length, 0, `出现碎片：${keywords.join(",")}`);
  assert.ok(keywords.some((k) => k.includes("记忆")), `应保留记忆相关词：${keywords.join(",")}`);
});

check("规则人设抽取：称呼", () => {
  const hints = extractProfileHints("以后叫我老王就行");
  assert.ok(hints !== null, "应抽到线索");
  assert.equal(hints.calledBy, "老王");
});

check("规则人设抽取：偏好", () => {
  const hints = extractProfileHints("我喜欢简洁的回答，不喜欢废话太多");
  assert.ok(hints !== null);
  assert.ok(hints.preference.some((p) => p.includes("简洁")), `偏好：${hints.preference.join(",")}`);
  assert.ok(hints.preference.some((p) => p.startsWith("不喜欢:")), `反向偏好：${hints.preference.join(",")}`);
});

check("规则人设抽取：无信息返回 null", () => {
  assert.equal(extractProfileHints("今天天气不错"), null);
});

check("卡片单行且不含内部匹配细节", () => {
  const card = renderCard({ entry: normalizeEntry({ ...fixture[0], hits: 3, tags: [] }), score: 1, reasons: ["关键词：记忆女神、插件"] }, 0);
  assert.ok(!card.includes("关联："), `不应暴露内部原因：${card}`);
  assert.equal(card.split("\n").length, 1, "卡片应为单行");
  assert.ok(card.includes("mv-a"));
});

check("召回计数累加并可回写", () => {
  const r = createRecall();
  r.rebuild(fixture);
  r.recall("记忆女神");
  const touched = r.drainHits();
  assert.ok(touched.length > 0, "应有被召回的条目");
  assert.ok(touched.every((entry) => entry.hits >= 1));
  assert.equal(r.drainHits().length, 0, "drain 后应清空");
});

check("test 标签不参与自动召回", () => {
  const r = createRecall();
  r.rebuild([...fixture, { ...fixture[0], id: "mv-test", tags: ["test"] }]);
  const auto = r.recall("记忆女神插件");
  assert.ok(!auto.all.some((hit) => hit.entry.id === "mv-test"), "test 条目不应被自动召回");
  const manual = r.recall("记忆女神插件", { skipTags: [] });
  assert.ok(manual.all.some((hit) => hit.entry.id === "mv-test"), "手动搜索应能看到");
});

check("注入更紧凑（无冗余段落）", () => {
  const r = createRecall();
  r.rebuild(fixture);
  const result = r.recall("记忆女神");
  const text = renderInjection({ profile: normalizeProfile({ user: { name: "老王" } }), recall: result, maxChars: 2600 });
  assert.ok(!text.includes("以下为延伸召回"), "不应再有延伸说明段");
  assert.ok(!text.includes("关联："), "不应暴露内部匹配细节");
  assert.ok(text.includes("### 框架"), "应保留框架段");
});

// ── 话题聚合 ────────────────────────────────────────────────────────────────
console.log("\n[topics] 话题聚类与归并渲染");

// 同会话 4 轮连续 + 3 小时后一轮
const sessionEntries = [
  { ...fixture[0], id: "mv-s1", t: now - 3 * 3600000 },
  { ...fixture[0], id: "mv-s2", t: now - 3 * 3600000 + 60000 },
  { ...fixture[0], id: "mv-s3", t: now - 3 * 3600000 + 120000 },
  { ...fixture[0], id: "mv-s4", t: now - 3 * 3600000 + 180000 },
  { ...fixture[0], id: "mv-s5", t: now },
];

check("连续轮次聚成一个话题", () => {
  const index = buildTopics(sessionEntries);
  const topic = index.list.get(index.byEntryId.get("mv-s1"));
  assert.ok(topic !== undefined, "应归入话题");
  assert.equal(topic.count, 4, `应聚 4 轮，实际 ${topic.count}`);
});

check("间隔超过阈值切成新话题", () => {
  const index = buildTopics(sessionEntries);
  assert.equal(index.topics.length, 2, `应有两个话题，实际 ${index.topics.length}`);
  assert.notEqual(index.byEntryId.get("mv-s1"), index.byEntryId.get("mv-s5"));
});

check("话题卡片带轮数与代表 id", () => {
  const index = buildTopics(sessionEntries);
  const topic = index.topics.find((item) => item.count === 4);
  const card = renderTopicCard(topic, 0, []);
  assert.ok(card.includes("4轮"), `应标注轮数：${card}`);
  assert.ok(card.includes(topic.leadId), `应带代表 id：${card}`);
  assert.equal(card.split("\n").length, 1, "话题卡片应为单行");
});

check("命中同话题的多轮合并成一行", () => {
  const index = buildTopics(sessionEntries);
  const hits = sessionEntries.slice(0, 3).map((entry, i) => ({ entry, score: 10 - i, reasons: [] }));
  const lines = renderHitLines(hits, index);
  assert.equal(lines.length, 1, `3 条同话题应压成 1 行，实际 ${lines.length}`);
  assert.ok(lines[0].includes("4轮"), `应标注话题总轮数：${lines[0]}`);
  assert.ok(lines[0].includes("命中3"), `应标注命中条数：${lines[0]}`);
});

check("话题索引按条目反查", () => {
  const index = buildTopics(sessionEntries);
  assert.ok(index.byEntryId instanceof Map);
  assert.equal(index.byEntryId.size, 5);
});

// ── 历史回填 ────────────────────────────────────────────────────────────────
console.log("\n[backfill] 会话解析与回填");

const evt = (type, data, time, seq) => ({ type, data, time, seq });

const sampleEvents = [
  evt("session", { id: "s-x" }, now, undefined),
  evt("turn/start", { turn: 1 }, now, 0),
  evt("user/message", { content: [{ type: "text", text: "帮我看看这个 bug" }], source: { kind: "user" } }, now, 1),
  evt("assistant/message", { message: { content: [{ type: "text", text: "已经修好了" }] } }, now, 2),
  evt("turn/end", { turn: 1, reason: { kind: "completed" } }, now, 3),
  evt("turn/start", { turn: 2 }, now, 4),
  evt("user/message", { content: [{ type: "text", text: "算了不做了" }], source: { kind: "user" } }, now, 5),
  evt("turn/end", { turn: 2, reason: { kind: "aborted" } }, now, 6),
  evt("turn/start", { turn: 3 }, now, 7),
  evt("user/message", { content: [{ type: "text", text: "系统注入的上下文" }], source: { kind: "agent-inject" } }, now, 8),
  evt("assistant/message", { message: { content: [{ type: "text", text: "收到" }] } }, now, 9),
  evt("turn/end", { turn: 3, reason: { kind: "completed" } }, now, 10),
];

check("只提取正常完成的轮次", () => {
  const turns = turnsFromEvents(sampleEvents);
  assert.equal(turns.length, 2, `应 2 轮，实际 ${turns.length}`);
  assert.equal(turns[0].user, "帮我看看这个 bug");
  assert.equal(turns[0].assistant, "已经修好了");
});

check("非真人来源的消息不计入", () => {
  const turns = turnsFromEvents(sampleEvents);
  assert.ok(!turns.some((turn) => turn.user.includes("系统注入")), "agent-inject 不应计入用户原话");
});

await checkAsync("回填端到端：解码 + 写入 + 去重", async () => {
  const root = mkdtempSync(join(tmpdir(), "mv-backfill-"));
  try {
    const dir = join(root, "ws-1", "session-abc");
    mkdirSync(dir, { recursive: true });
    const jsonl = `${sampleEvents.map((event) => JSON.stringify(event)).join("\n")}\n`;
    const file = join(dir, "session.v4.jsonl.zstd");
    writeFileSync(file, zstdCompressSync(Buffer.from(jsonl, "utf8")));

    const decoded = decodeSessionFile(file);
    assert.equal(decoded.length, sampleEvents.length, `解码事件数不符：${decoded.length}`);

    const written = [];
    const result = await runBackfill({
      sessionsRoot: [root],
      write: (entry) => written.push(entry),
      existing: new Set(),
      maxSessions: 5,
      maxTurns: 10,
    });
    assert.equal(result.written, 2, `应写入 2 条，实际 ${result.written}`);
    assert.ok(written.every((entry) => entry.tags.includes("backfill")));
    assert.ok(written.every((entry) => entry.summary.length > 0));

    // 第二轮：全部应被去重跳过
    const second = await runBackfill({
      sessionsRoot: [root],
      write: () => {},
      existing: new Set(written.map((entry) => `${entry.sessionId}:${entry.turn}`)),
      maxSessions: 5,
      maxTurns: 10,
    });
    assert.equal(second.written, 0, "重复导入应被跳过");
    assert.equal(second.skipped, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check("回填条目可被检索", () => {
  const r = createRecall();
  const entry = {
    id: "mv-bf",
    t: now,
    kind: "event",
    sessionId: "s-x",
    user: "帮我看看这个 bug",
    assistant: "已经修好了",
    summary: "用户报告 bug，已修复",
    keywords: ["bug", "修复"],
    entities: ["bug"],
    tags: ["backfill"],
  };
  r.rebuild([entry]);
  const result = r.recall("那个 bug 修好了吗");
  assert.ok(result.all.some((hit) => hit.entry.id === "mv-bf"), "回填条目应可被召回");
});

// ── 事实层（语义记忆） ──────────────────────────────────────────────────────
console.log("\n[facts] 事实抽取与冲突消解");

check("单值谓词槽位不含值", () => {
  assert.equal(factSlot({ subject: "user", predicate: "nickname", value: "老王" }), "user/nickname");
});

check("多值谓词槽位含值", () => {
  assert.notEqual(
    factSlot({ subject: "user", predicate: "preference", value: "简洁" }),
    factSlot({ subject: "user", predicate: "preference", value: "啰嗦" }),
  );
});

check("非法事实返回 null", () => {
  assert.equal(normalizeFact({ subject: "user", predicate: "", value: "x" }), null);
  assert.equal(normalizeFact({ subject: "user", predicate: "nickname", value: "  " }), null);
});

check("同槽位新值让旧值失效", () => {
  const old = normalizeFact({ subject: "user", predicate: "nickname", value: "老王" }, now);
  const { puts, retires } = resolveFacts([old], [{ subject: "user", predicate: "nickname", value: "王哥" }], now);
  assert.equal(puts.length, 1);
  assert.equal(retires.length, 1);
  assert.equal(retires[0].fact.value, "老王");
  assert.equal(retires[0].reason, "superseded");
  assert.equal(puts[0].replaces, old.id, "新事实应记录替代关系");
});

check("同值重复只刷新不新增", () => {
  const old = normalizeFact({ subject: "user", predicate: "nickname", value: "老王" }, now);
  const { puts, touches } = resolveFacts([old], [{ subject: "user", predicate: "nickname", value: "老王" }], now);
  assert.equal(puts.length, 0);
  assert.equal(touches.length, 1);
});

check("否定让匹配的旧值失效", () => {
  const old = normalizeFact({ subject: "user", predicate: "nickname", value: "老王" }, now);
  const { retires } = resolveFacts([old], [{ subject: "user", predicate: "nickname", value: "老王", polarity: "-" }], now);
  assert.equal(retires.length, 1);
  assert.equal(retires[0].reason, "negated");
});

check("多值谓词可并存", () => {
  const a = normalizeFact({ subject: "user", predicate: "preference", value: "简洁" }, now);
  const { puts, retires } = resolveFacts([a], [{ subject: "user", predicate: "preference", value: "深色主题" }], now);
  assert.equal(puts.length, 1);
  assert.equal(retires.length, 0, "偏好之间不该互相覆盖");
});

check("不同 subject 互不干扰", () => {
  const a = normalizeFact({ subject: "user", predicate: "nickname", value: "老王" }, now);
  const { retires } = resolveFacts([a], [{ subject: "assistant", predicate: "nickname", value: "小助手" }], now);
  assert.equal(retires.length, 0);
});

check("已失效的事实不参与冲突判定", () => {
  const dead = normalizeFact({ subject: "user", predicate: "nickname", value: "老王", validUntil: now - 1000 }, now);
  const { puts, retires } = resolveFacts([dead], [{ subject: "user", predicate: "nickname", value: "王哥" }], now);
  assert.equal(puts.length, 1);
  assert.equal(retires.length, 0);
});

check("规则抽取：称呼与否定", () => {
  const positive = extractFacts("以后叫我老王");
  assert.ok(positive.some((fact) => fact.predicate === "nickname" && fact.value === "老王" && fact.polarity === "+"));
  const negative = extractFacts("以后别叫我老王了");
  assert.ok(negative.some((fact) => fact.predicate === "nickname" && fact.value === "老王" && fact.polarity === "-"));
});

check("规则抽取：偏好正负", () => {
  const facts = extractFacts("我喜欢简洁的回答，不喜欢废话");
  assert.ok(facts.some((fact) => fact.predicate === "preference" && fact.polarity === "+"));
  assert.ok(facts.some((fact) => fact.predicate === "preference" && fact.polarity === "-"));
});

check("事实投影到框架（覆盖手工值）", () => {
  const facts = [
    normalizeFact({ subject: "user", predicate: "nickname", value: "老王" }, now),
    normalizeFact({ subject: "assistant", predicate: "persona", value: "务实", polarity: "+" }, now),
  ];
  const frame = composeFrame({ user: { name: "手填名字", nicknames: [] }, self: {}, personality: [], preferences: [] }, facts, now);
  assert.ok(frame.user.nicknames.includes("老王"));
  assert.equal(frame.self.persona, "务实");
  assert.equal(frame.user.name, "手填名字", "没有对应事实时保留手工值");
});

check("失效事实不进框架", () => {
  const dead = normalizeFact({ subject: "user", predicate: "nickname", value: "老王", validUntil: now - 1000 }, now);
  const frame = composeFrame({ user: { nicknames: [] } }, [dead], now);
  assert.ok(!frame.user.nicknames.includes("老王"));
});

await checkAsync("事实库落盘与回放", async () => {
  const root = mkdtempSync(join(tmpdir(), "mv-facts-"));
  try {
    const store = createStore(root, { logger: { warn() {} } });
    const fact = normalizeFact({ subject: "user", predicate: "nickname", value: "老王" }, now);
    store.putFact(fact);
    assert.equal(store.listFacts().length, 1);

    const fresh = createStore(root, { logger: { warn() {} } });
    const loaded = fresh.listFacts();
    assert.equal(loaded.length, 1, "重启应能回放到事实");
    assert.equal(loaded[0].value, "老王");

    fresh.retireFact(fact.id, { supersededBy: "ft-new" });
    assert.equal(isActive(fresh.listFacts()[0], Date.now()), false, "失效后应不可用");

    const third = createStore(root, { logger: { warn() {} } });
    assert.equal(isActive(third.listFacts()[0], Date.now()), false, "失效状态也要能回放");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check("注入里的事实优先于旧 profile", () => {
  const r = createRecall();
  r.rebuild(fixture);
  const result = r.recall("记忆女神");
  const facts = [normalizeFact({ subject: "user", predicate: "nickname", value: "王哥" }, now)];
  const text = renderInjection({
    profile: normalizeProfile({ user: { name: "老王", nicknames: ["旧昵称"] } }),
    facts,
    recall: result,
    maxChars: 2600,
  });
  assert.ok(text.includes("王哥"), `应注入新昵称：${text.slice(0, 200)}`);
});

// ── 人设框架自动生成 ────────────────────────────────────────────────────────
console.log("\n[persona] 人设归纳");

check("草稿：过滤空值/非字符串/无效日期", () => {
  const draft = normalizePersonaDraft({
    facts: [
      { subject: "user", predicate: "nickname", value: "老王" },
      { subject: "user", predicate: "name", value: "   " },
      { subject: "user", predicate: "", value: "x" },
    ],
    personality: ["直接", "", 3],
    preferences: ["简洁"],
    events: [{ t: "2026-10-22", text: "完成回填" }, { t: "bad-date", text: "" }],
    summary: "  务实的人  ",
  });
  assert.equal(draft.facts.length, 1, `事实应只剩 1 条：${JSON.stringify(draft.facts)}`);
  assert.deepEqual(draft.personality, ["直接"]);
  assert.equal(draft.events.length, 1);
  assert.ok(draft.events[0].t > 0, "合法日期应被解析");
  assert.equal(draft.summary, "务实的人");
});

check("草稿：非对象返回 null", () => {
  assert.equal(normalizePersonaDraft(null), null);
  assert.equal(normalizePersonaDraft("nope"), null);
});

check("草稿事实能进冲突消解", () => {
  const draft = normalizePersonaDraft({ facts: [{ subject: "user", predicate: "nickname", value: "王哥" }] });
  const old = normalizeFact({ subject: "user", predicate: "nickname", value: "老王" }, now);
  const { puts, retires } = resolveFacts([old], draft.facts, now);
  assert.equal(puts.length, 1);
  assert.equal(retires.length, 1, "新草稿应让旧昵称失效");
});

check("输入：时间线带日期与类型", () => {
  const input = buildPersonaInput({
    entries: fixture,
    facts: [normalizeFact({ subject: "user", predicate: "nickname", value: "老王" }, now)],
  });
  assert.ok(input.count > 0);
  assert.ok(/\d{4}-\d{2}-\d{2} \[/u.test(input.timeline), `时间线格式不对：${input.timeline.slice(0, 60)}`);
  assert.ok(input.facts.includes("nickname=老王"));
});

check("输入：上限生效且空库安全", () => {
  const many = Array.from({ length: 120 }, (_, i) => ({ ...fixture[0], id: `mv-${i}`, t: now - i * 1000 }));
  const input = buildPersonaInput({ entries: many, facts: [], limit: 40 });
  assert.equal(input.count, 40);
  assert.equal(buildPersonaInput({ entries: [], facts: [] }).count, 0);
});

check("提示词要求结构化 facts 且禁止编造", () => {
  assert.ok(PERSONA_PROMPT.includes("facts"));
  assert.ok(PERSONA_PROMPT.includes("predicate"));
  assert.ok(/不要编/u.test(PERSONA_PROMPT), "应明确禁止编造");
});

await checkAsync("归纳全链路：模型输出 → 草稿 → 冲突消解", async () => {
  const payload = JSON.stringify({
    facts: [
      { subject: "user", predicate: "nickname", value: "王哥" },
      { subject: "assistant", predicate: "persona", value: "务实" },
    ],
    personality: ["直接"],
    preferences: ["回答简洁"],
    events: [{ t: "2026-10-22", text: "交付 adb_lab" }],
    summary: "务实、要结论的人",
  });
  const stub = () => (async function* () {
    yield { type: "text-delta", text: payload.slice(0, 40) };
    yield { type: "text-delta", text: payload.slice(40) };
    yield { type: "finish", reason: "stop" };
  })();
  const draft = await buildPersonaWithLlm({
    route: { provider: "stub", model: "stub" },
    stream: stub,
    entries: fixture,
    facts: [],
    timeoutMs: 2000,
  });
  assert.ok(draft !== null, "应返回草稿");
  assert.equal(draft.facts.length, 2, "分片文本应被正确拼接解析");
  assert.deepEqual(draft.personality, ["直接"]);
  assert.equal(draft.events.length, 1);

  // 草稿进冲突消解：旧昵称失效
  const old = normalizeFact({ subject: "user", predicate: "nickname", value: "老王" }, now);
  const { puts, retires } = resolveFacts([old], draft.facts, now);
  assert.ok(puts.length >= 1);
  assert.equal(retires.length, 1, "新昵称应让旧昵称失效");
});

await checkAsync("归纳：模型返回非 JSON 时抛错（附原始输出便于定位）", async () => {
  const stub = () => (async function* () {
    yield { type: "text-delta", text: "抱歉，我无法完成这个任务。" };
    yield { type: "finish", reason: { kind: "stop" } };
  })();
  await assert.rejects(
    () => buildPersonaWithLlm({
      route: { provider: "stub", model: "stub" },
      stream: stub,
      entries: fixture,
      facts: [],
      timeoutMs: 2000,
    }),
    /不是 JSON/u,
    "应抛出可读错误而不是静默返回 null",
  );
});

await checkAsync("归纳：模型返回空流时抛错（带 chunk 诊断）", async () => {
  const stub = () => (async function* () {
    yield { type: "finish", reason: { kind: "stop" } };
  })();
  await assert.rejects(
    () => buildPersonaWithLlm({
      route: { provider: "stub", model: "stub" },
      stream: stub,
      entries: fixture,
      facts: [],
      timeoutMs: 2000,
    }),
    /没有返回文本/u,
  );
});

await checkAsync("归纳：首次空流、重试成功则正常返回", async () => {
  let call = 0;
  const stub = () => {
    call += 1;
    if (call === 1) {
      // 第一次模拟限流：直接 finish 没有文本
      return (async function* () {
        yield { type: "finish", reason: { kind: "stop" } };
      })();
    }
    return (async function* () {
      yield { type: "text-delta", text: '{"facts":[],"personality":["直接"],"preferences":[],"events":[],"summary":"x"}' };
      yield { type: "finish", reason: { kind: "stop" } };
    })();
  };
  const draft = await buildPersonaWithLlm({
    route: { provider: "stub", model: "stub" },
    stream: stub,
    entries: fixture,
    facts: [],
    timeoutMs: 2000,
  });
  assert.ok(draft !== null, "重试后应成功");
  assert.deepEqual(draft.personality, ["直接"]);
  assert.equal(call, 2, "应当重试过一次");
});

await checkAsync("归纳：多次间歇中断能靠重试兜住", async () => {
  // 实测该路由的 aborted 率很高（探针 7 组里 5 组失败），重试次数必须够
  let call = 0;
  const stub = () => {
    call += 1;
    if (call < 4) {
      return (async function* () {
        yield { type: "finish", reason: { kind: "aborted" } };
      })();
    }
    return (async function* () {
      yield { type: "text-delta", text: '{"facts":[],"personality":["务实"],"preferences":[],"events":[],"summary":"x"}' };
      yield { type: "finish", reason: { kind: "stop" } };
    })();
  };
  const draft = await buildPersonaWithLlm({
    route: { provider: "stub", model: "stub" },
    stream: stub,
    entries: fixture,
    facts: [],
    timeoutMs: 3000,
  });
  assert.ok(draft !== null, "第 4 次成功也应能返回");
  assert.deepEqual(draft.personality, ["务实"]);
  assert.equal(call, 4, `应在第 4 次成功，实际 ${call} 次`);
});

await checkAsync("归纳：连续失败会抛出最后一次的错误", async () => {
  let call = 0;
  const stub = () => {
    call += 1;
    return (async function* () {
      yield { type: "finish", reason: { kind: "aborted" } };
    })();
  };
  await assert.rejects(
    () => buildPersonaWithLlm({
      route: { provider: "stub", model: "stub" },
      stream: stub,
      entries: fixture,
      facts: [],
      timeoutMs: 2000,
    }),
    /没有返回文本/u,
  );
  assert.equal(call, 5, `应尝试 5 次，实际 ${call} 次`);
});

await checkAsync("归纳：空记忆或空路由直接返回 null", async () => {
  const stub = () => (async function* () { yield { type: "finish" }; })();
  assert.equal(await buildPersonaWithLlm({ route: { provider: "s", model: "s" }, stream: stub, entries: [], facts: [] }), null);
  assert.equal(await buildPersonaWithLlm({ route: null, stream: stub, entries: fixture, facts: [] }), null);
});

await checkAsync("归纳：调用参数正确（不带 temperature、maxTokens 足够）", async () => {
  // 两个真实踩过的坑：
  //  1. 传 temperature → 适配器返回 finish=aborted，表现为「模型没有返回文本」
  //  2. maxTokens 900 → 归纳输出在 236 字符处被截断（finish=max-tokens），JSON 不完整
  let captured = null;
  const stub = (options) => {
    captured = options;
    return (async function* () {
      yield { type: "text-delta", text: '{"facts":[],"personality":[],"preferences":[],"events":[],"summary":"x"}' };
      yield { type: "finish", reason: { kind: "stop" } };
    })();
  };
  await buildPersonaWithLlm({
    route: { provider: "stub", model: "stub" },
    stream: stub,
    entries: fixture,
    facts: [],
    timeoutMs: 2000,
  });
  assert.ok(!("temperature" in captured), "不应传 temperature（适配器会拒绝）");
  assert.ok(captured.maxTokens >= 2000, `maxTokens 要留足以输出完整 JSON，当前 ${captured.maxTokens}`);
  assert.deepEqual(
    Object.keys(captured).sort(),
    ["maxTokens", "messages", "model", "provider", "signal", "system"],
  );
});

// ── 记忆固化 ────────────────────────────────────────────────────────────────
console.log("\n[consolidate] 记忆固化");

check("相似度：同文本为 1、无关为 0", () => {
  const a = tokenSet({ summary: "修复了相机崩溃的问题", keywords: ["相机"] });
  assert.equal(similarity(a, tokenSet({ summary: "修复了相机崩溃的问题", keywords: ["相机"] })), 1);
  assert.equal(similarity(a, tokenSet({ summary: "数据库迁移方案评审", keywords: [] })), 0);
});

check("重复检测：同话题近似条目并组（保留最长的）", () => {
  const base = { sessionId: "s-1", kind: "event", tags: [] };
  const entries = [
    { ...base, id: "a", t: now, summary: "修复了相机崩溃的问题并加了单元测试", keywords: ["相机", "崩溃"] },
    { ...base, id: "b", t: now + 1000, summary: "修复了相机崩溃的问题并加了单元测试", keywords: ["相机", "崩溃"] },
    { ...base, id: "c", t: now + 2000, summary: "讨论了数据库迁移的方案", keywords: ["数据库"] },
  ];
  const byEntryId = new Map([["a", "t1"], ["b", "t1"], ["c", "t1"]]);
  const groups = findDuplicateGroups(entries, { byEntryId });
  assert.equal(groups.length, 1, `应并成 1 组：${JSON.stringify(groups)}`);
  assert.equal(groups[0].dropIds.length, 1);
  assert.ok(!groups[0].dropIds.includes("c"), "不相似的不该被并掉");
});

check("重复检测：跨话题不合并", () => {
  const entries = [
    { id: "a", sessionId: "s-1", t: now, summary: "同一个摘要内容", keywords: [], tags: [] },
    { id: "b", sessionId: "s-2", t: now, summary: "同一个摘要内容", keywords: [], tags: [] },
  ];
  const groups = findDuplicateGroups(entries, { byEntryId: new Map([["a", "t1"], ["b", "t2"]]) });
  assert.equal(groups.length, 0);
});

check("归档候选：又旧 + 没召回 + 非决策类", () => {
  const old = now - 60 * 24 * 3600 * 1000;
  const entries = [
    { id: "old-chat", t: old, kind: "chat", hits: 0, tags: [] },
    { id: "old-decision", t: old, kind: "decision", hits: 0, tags: [] },
    { id: "old-hot", t: old, kind: "chat", hits: 5, tags: [] },
    { id: "recent", t: now, kind: "chat", hits: 0, tags: [] },
    { id: "pinned", t: old, kind: "chat", hits: 0, pinned: true, tags: [] },
    { id: "already", t: old, kind: "chat", hits: 0, tags: ["archived"] },
  ];
  assert.deepEqual(pickArchiveCandidates(entries, { now, minAgeDays: 30 }), ["old-chat"]);
});

check("digest 候选：够大够旧才压", () => {
  assert.equal(isDigestCandidate({ count: 8, t1: now - 1000 }, { now }), false, "太新不压");
  assert.equal(isDigestCandidate({ count: 2, t1: now - 10 * 86400000 }, { now }), false, "太小不压");
  assert.equal(isDigestCandidate({ count: 8, t1: now - 10 * 86400000 }, { now }), true);
});

check("digest 草稿：带跨度轮数要点，细节不进摘要", () => {
  const topic = {
    id: "tp-1",
    title: "adb_lab / 设备测试",
    kind: "decision",
    t0: now - 10 * 86400000,
    t1: now - 8 * 86400000,
    count: 6,
    keywords: ["adb"],
    entities: ["adb_lab"],
    sessionId: "s",
    sessionTitle: "",
    entryIds: ["1", "2"],
    leadId: "1",
  };
  const members = [
    { id: "1", t: topic.t0, kind: "decision", summary: "决定用 python 重写采集层", hits: 2 },
    { id: "2", t: topic.t0 + 1000, kind: "task", summary: "补了 42 项离线自检", hits: 1 },
  ];
  const draft = buildDigest(topic, members, now);
  assert.ok(draft.summary.includes("6轮"), draft.summary);
  assert.ok(draft.summary.includes("决定用 python"), draft.summary);
  assert.equal(draft.source, "digest");
  assert.deepEqual(draft.tags, ["digest"]);
  assert.ok(draft.summary.length <= 240);
});

check("固化计划：已固化的话题不重复生成", () => {
  const oldT = now - 10 * 86400000;
  const entries = [
    { id: "e1", t: oldT, kind: "decision", summary: "决定一", keywords: [], entities: [], tags: [], sessionId: "s", hits: 0 },
    { id: "e2", t: oldT + 1000, kind: "task", summary: "任务二", keywords: [], entities: [], tags: [], sessionId: "s", hits: 0 },
    { id: "e3", t: oldT + 2000, kind: "event", summary: "事件三", keywords: [], entities: [], tags: [], sessionId: "s", hits: 0 },
    { id: "e4", t: oldT + 3000, kind: "event", summary: "事件四", keywords: [], entities: [], tags: [], sessionId: "s", hits: 0 },
    { id: "e5", t: oldT + 4000, kind: "event", summary: "事件五", keywords: [], entities: [], tags: [], sessionId: "s", hits: 0 },
  ];
  const topics = buildTopics(entries);
  const plan = planConsolidation({ entries, topics, now, options: { minTurns: 5, minAgeDays: 7 } });
  assert.equal(plan.digests.length, 1, `应生成 1 条 digest：${JSON.stringify(plan.stats)}`);

  // 已经存在指向这些条目的 digest → 不再重复
  const withDigest = [...entries, { id: "d1", t: oldT, source: "digest", digestOf: ["e1", "e2", "e3", "e4", "e5"], summary: "x", tags: ["digest"] }];
  const again = planConsolidation({ entries: withDigest, topics: buildTopics(withDigest), now, options: { minTurns: 5, minAgeDays: 7 } });
  assert.equal(again.digests.length, 0, "已固化的话题不该重复压");
});

check("归档条目退出自动召回但手动可搜", () => {
  const r = createRecall();
  const archived = normalizeEntry({
    id: "mv-archived",
    t: now,
    kind: "event",
    summary: "相机崩溃已修复并回归验证",
    keywords: ["相机", "崩溃"],
    entities: [],
    tags: ["archived"],
  });
  const active = normalizeEntry({
    id: "mv-active",
    t: now - 1000,
    kind: "event",
    summary: "相机崩溃已修复并回归验证",
    keywords: ["相机", "崩溃"],
    entities: [],
    tags: [],
  });
  r.rebuild([archived, active]);

  const auto = r.recall("相机崩溃");
  assert.ok(!auto.all.some((hit) => hit.entry.id === "mv-archived"), "归档条目不该进自动召回");

  const manual = r.recall("相机崩溃", { skipTags: [] });
  assert.ok(manual.all.some((hit) => hit.entry.id === "mv-archived"), "手动搜索应能看到归档条目");
});

// ── 存储压缩 ────────────────────────────────────────────────────────────────
console.log("\n[compact] 存储压缩");

await checkAsync("压缩：追加流重写成一条一行，数据不变", async () => {
  const root = mkdtempSync(join(tmpdir(), "mv-compact-"));
  try {
    const store = createStore(root, { logger: { warn() {} } });
    for (let i = 0; i < 60; i += 1) {
      store.put({ id: `mv-c${i}`, t: now + i, kind: "event", summary: `第 ${i} 条`, keywords: [], entities: [], tags: [] });
    }
    // 每条再更新 3 次（模拟总结、打标签、召回计数）
    for (let round = 0; round < 3; round += 1) {
      for (let i = 0; i < 60; i += 1) {
        const entry = store.getEntry(`mv-c${i}`);
        store.put({ ...entry, updatedAt: now + round });
      }
    }
    const before = store.stats().lines;
    assert.ok(before >= 240, `应堆积 240 行以上：${before}`);
    assert.equal(store.needsCompaction(), true, "应判定需要压缩");

    const result = store.compact();
    assert.equal(result.after, 60, `压缩后应为 60 行：${result.after}`);
    assert.equal(store.listEntries().length, 60, "内存条目数不变");

    const reopened = createStore(root, { logger: { warn() {} } });
    assert.equal(reopened.listEntries().length, 60, "重开后条目数一致");
    assert.equal(reopened.getEntry("mv-c7").summary, "第 7 条", "内容未损坏");
    assert.equal(reopened.stats().lines, 60, "重开后行数也是 60");
    assert.equal(reopened.needsCompaction(), false, "压缩后不再需要压缩");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await checkAsync("压缩：事实库只保留最终状态（含失效）", async () => {
  const root = mkdtempSync(join(tmpdir(), "mv-compactf-"));
  try {
    const store = createStore(root, { logger: { warn() {} } });
    const fact = normalizeFact({ subject: "user", predicate: "nickname", value: "老王" }, now);
    store.putFact(fact);
    for (let i = 0; i < 5; i += 1) store.touchFact(fact.id);
    store.retireFact(fact.id, { supersededBy: "ft-new" });

    const result = store.compactFacts();
    assert.equal(result.after, 1, `事实应压成 1 行：${result.after}`);

    const reopened = createStore(root, { logger: { warn() {} } });
    const loaded = reopened.listFacts();
    assert.equal(loaded.length, 1);
    assert.equal(isActive(loaded[0], Date.now()), false, "失效状态要在压缩后保留");
    assert.equal(loaded[0].supersededBy, "ft-new", "替代关系也要保留");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await checkAsync("归纳：messages.content 必须是块数组", async () => {
  // 回归用例：适配器不认裸字符串 content，传错会静默返回空流（真实踩过）
  let captured = null;
  const stub = (options) => {
    captured = options;
    return (async function* () {
      yield { type: "text-delta", text: '{"facts":[],"personality":[],"preferences":[],"events":[],"summary":"x"}' };
      yield { type: "finish", reason: { kind: "stop" } };
    })();
  };
  await buildPersonaWithLlm({
    route: { provider: "stub", model: "stub" },
    stream: stub,
    entries: fixture,
    facts: [],
    timeoutMs: 2000,
  });
  assert.ok(Array.isArray(captured.messages[0].content), `content 必须是数组：${typeof captured.messages[0].content}`);
  assert.equal(captured.messages[0].content[0].type, "text");
  assert.equal(typeof captured.messages[0].content[0].text, "string");
  assert.equal(captured.maxTokens > 0, true, "应带 maxTokens");
});

// ── 人设归纳的防污染 ────────────────────────────────────────────────────────
console.log("\n[persona-guard] 防污染");

check("路径事实：真路径通过，描述性文字拒绝", () => {
  assert.equal(isPathLike("D:\\设备测试\\adb_lab"), true);
  assert.equal(isPathLike("D:/记忆女神"), true);
  assert.equal(isPathLike("记忆女神面板挂载槽 shell.overlay"), false, "描述性文字不是路径");
  assert.equal(isPathLike("test/compact.mjs"), false, "裸相对文件不是目录");
  assert.equal(isPathLike(""), false);
  assert.equal(isPathLike("C:\\Program Files\\x"), false, "含空格的盘符路径不可信");
});

check("框架回流内容被识别并拒绝", () => {
  assert.equal(isFrameworkEcho("## 记忆女神\n### 框架"), true);
  assert.equal(isFrameworkEcho("- 目录：D:\\x；D:\\y"), true, "整句注入行样式");
  assert.equal(isFrameworkEcho("- 性格:直接/务实 ｜ 偏好:先给结论"), true, "半角冒号也要识别");
  assert.equal(isFrameworkEcho("用户要求实现记忆女神插件"), false);
});

check("草稿：污染 facts 在归一化时被剔除", () => {
  const draft = normalizePersonaDraft({
    facts: [
      { subject: "user", predicate: "preference", value: "先给结论" },
      { subject: "env", predicate: "path", value: "记忆女神面板挂载槽 shell.overlay" },
      { subject: "env", predicate: "path", value: "D:\\设备测试\\adb_lab" },
    ],
    events: [],
    personality: [],
    preferences: [],
    summary: "",
  });
  assert.equal(draft.facts.length, 2, `应剔掉描述性路径：${JSON.stringify(draft.facts.map((f) => f.value))}`);
  assert.ok(draft.facts.every((fact) => fact.value !== "记忆女神面板挂载槽 shell.overlay"));
});

check("事实入库：path 谓词必须是真路径", () => {
  assert.equal(normalizeFact({ subject: "env", predicate: "path", value: "测试目录" }, now), null);
  assert.ok(normalizeFact({ subject: "env", predicate: "path", value: "D:\\ok\\path" }, now) !== null);
});

check("事实入库：框架回流值被拒绝", () => {
  assert.equal(normalizeFact({ subject: "user", predicate: "preference", value: "### 框架" }, now), null);
  assert.equal(factIsEcho("- 目录：D:\\x"), true);
  assert.equal(factIsPath("D:\\ok"), true);
  assert.equal(factIsPath("测试目录"), false);
});

check("事件过滤：开发流水不算里程碑", () => {
  const draft = normalizePersonaDraft({
    facts: [],
    personality: [],
    preferences: [],
    events: [
      { t: "2026-10-25", text: "记忆女神改造：事实层与情景层分库，自检 75/75 通过" },
      { t: "2026-10-25", text: "修复记忆女神面板空白（挂载槽改为 shell.overlay）" },
      { t: "2026-10-25", text: "记忆女神压缩 1034→80 行（-92%）" },
      { t: "2026-10-22", text: "明确 adb_lab 工具必须全程离线不联网" },
      { t: "2026-10-18", text: "渗透演练改为只对自建本地靶场进行" },
    ],
    summary: "",
  });
  assert.equal(draft.events.length, 2, `应只留 2 条长期约束：${JSON.stringify(draft.events.map((e) => e.text))}`);
  assert.ok(draft.events.every((event) => !/自检|压缩|修复/u.test(event.text)));
});

check("事件过滤：上限压到 5 条", () => {
  // 故意用互不相似的事件，避免触发语义去重
  const texts = [
    "搭建本地渗透靶场并演练全流程",
    "确定安卓测试工具禁止联网",
    "数据库迁移到新存储引擎",
    "重构前端面板挂载方式",
    "引入向量检索替代关键词",
    "统一日志格式与时间戳",
    "接入外部告警通道",
  ];
  const events = texts.map((text, i) => ({ t: "2026-10-2" + (i % 9), text }));
  const draft = normalizePersonaDraft({ facts: [], personality: [], preferences: [], events, summary: "" });
  assert.equal(draft.events.length, 5, `应压到 5 条：${draft.events.length}`);
});

check("归纳输入：框架回流条目被排除", () => {
  const input = buildPersonaInput({
    entries: [
      { t: now, kind: "event", summary: "正常的一轮对话内容", user: "x", keywords: [], entities: [] },
      { t: now, kind: "event", summary: "## 记忆女神\n### 框架\n- 目录：D:\\a", user: "", keywords: [], entities: [] },
      { t: now, kind: "event", summary: "- 性格:直接/务实 ｜ 偏好:先给结论", user: "", keywords: [], entities: [] },
    ],
    facts: [],
  });
  assert.equal(input.count, 1, `应只剩 1 条：${input.timeline}`);
  assert.ok(!input.timeline.includes("### 框架"));
});

check("事件过滤：同一件事被归纳三次只留一条", () => {
  const draft = normalizePersonaDraft({
    facts: [],
    personality: [],
    preferences: [],
    events: [
      { t: "2026-10-22", text: "定下设备测试工具全程离线不联网的硬性红线" },
      { t: "2026-10-22", text: "adb_lab 设备测试工具开发，明确「全程严禁联网」红线，加入相机/漏洞库专项识别" },
      { t: "2026-10-22", text: "提出 adb_lab 实时 WebUI + 多项测试需求，明确全程禁止联网的红线" },
      { t: "2026-10-19", text: "搭建本地渗透靶场并完整演练渗透流程与后台进入" },
    ],
    summary: "",
  });
  assert.equal(draft.events.length, 2, `应归并成 2 条：${JSON.stringify(draft.events.map((e) => e.text))}`);
  assert.ok(draft.events.some((event) => /渗透靶场/u.test(event.text)), "无关事件不能被并掉");
});

check("事件去重：共享实词才算同一件事", () => {
  assert.equal(sameEvent("adb_lab 设备测试工具全程离线", "adb_lab 测试工具严禁联网"), true);
  assert.equal(sameEvent("搭建本地渗透靶场", "修复面板挂载槽"), false);
});

check("多值事实：同一件事的两种说法只算一条", () => {
  // 「全程离线不联网」与「要求全程离线不联网」各占一个槽，但应该判重
  assert.equal(sameFactValue("全程离线不联网", "要求全程离线不联网"), true);
  assert.equal(sameFactValue("先给结论", "回答先给结论"), true);
  assert.equal(sameFactValue("先给结论", "用测试结果说话"), false);
  // 路径不做模糊合并：父目录与子目录都有效
  assert.equal(sameFactValue("D:\\渗透\\pcl2-mirror", "D:\\渗透\\pcl2-mirror\\site"), false);
});

check("多值事实判重后只留一条", () => {
  const existing = normalizeFact({ subject: "user", predicate: "preference", value: "全程离线不联网" }, now);
  const { puts, touches } = resolveFacts([existing], [
    { subject: "user", predicate: "preference", value: "要求全程离线不联网" },
  ], now);
  assert.equal(puts.length, 0, "同一件事不该再插一条");
  assert.equal(touches.length, 1, "应只是刷新已有那条");
});

check("框架合并：旧手填值与新事实按语义去重", () => {
  // profile.json 里可能留着早年手填的「要求全程离线不联网」，
  // 事实层归纳出的是「全程离线不联网」——意思一样，框架里不能并排两条
  const facts = [
    normalizeFact({ subject: "user", predicate: "preference", value: "全程离线不联网" }, now),
    normalizeFact({ subject: "user", predicate: "preference", value: "先给结论" }, now),
  ];
  const frame = composeFrame(
    normalizeProfile({ preferences: ["要求全程离线不联网", "回答先给结论"] }),
    facts,
  );
  assert.equal(frame.preferences.length, 2, `应合并成 2 条：${JSON.stringify(frame.preferences)}`);
  assert.ok(frame.preferences.includes("全程离线不联网"), "应保留更简洁的写法");
  assert.ok(!frame.preferences.includes("要求全程离线不联网"), "带引导词的重复写法应被合并掉");
});

check("框架合并：路径类值不做模糊合并", () => {
  const facts = [
    normalizeFact({ subject: "env", predicate: "path", value: "D:\\渗透\\pcl2-mirror" }, now),
    normalizeFact({ subject: "env", predicate: "path", value: "D:\\渗透\\pcl2-mirror\\site" }, now),
  ];
  const frame = composeFrame(normalizeProfile({}), facts);
  assert.equal(frame.paths.length, 2, `父子目录都应保留：${JSON.stringify(frame.paths)}`);
});

check("框架合并：同一短语不跨性格/偏好重复", () => {
  // 模型常把「需求推进快」同时填进 personality 和 preference
  const facts = [
    normalizeFact({ subject: "user", predicate: "personality", value: "需求推进快" }, now),
    normalizeFact({ subject: "user", predicate: "preference", value: "需求推进快" }, now),
    normalizeFact({ subject: "user", predicate: "preference", value: "先给结论" }, now),
  ];
  const frame = composeFrame(normalizeProfile({}), facts);
  assert.ok(frame.personality.includes("需求推进快"), "性格应保留");
  assert.ok(!frame.preferences.includes("需求推进快"), "偏好里不该再出现同一短语");
  assert.ok(frame.preferences.includes("先给结论"), "其它偏好不受影响");
});

// ── 收尾 ────────────────────────────────────────────────────────────────────
rmSync(tempRoot, { recursive: true, force: true });

console.log(`\n${failed === 0 ? "✅" : "❌"} 通过 ${passed} 项，失败 ${failed} 项`);
if (failed > 0) {
  console.log("\n失败明细：");
  for (const line of failures) console.log(` - ${line}`);
  process.exitCode = 1;
}
