/**
 * 离线预览：用真实记忆库数据 + 当前源码跑一次注入渲染，不依赖运行中的 DSH。
 * 用途：改完 lib/ 之后立刻看效果，不用重启。
 * 运行：node test/preview.mjs "你的问题"
 */
import { createStore } from "../lib/store.js";
import { createRecall } from "../lib/recall.js";
import { renderInjection } from "../lib/summarize.js";
import { buildTopics } from "../lib/topics.js";
import { resolveDataDir } from "./paths.mjs";

const dataDir = resolveDataDir();
const query = process.argv[2] ?? "记忆库插件怎么优化";
const maxChars = Number(process.argv[3] ?? 2600);

const store = createStore(dataDir, { logger: { warn() {} } });
const entries = store.load();
const recall = createRecall({ maxRecall: 8 });
recall.rebuild(entries);
const profile = store.readProfile();
const topics = buildTopics(entries);
const facts = store.listFacts().filter((fact) => fact.validUntil === null || Number(fact.validUntil) > Date.now());

const result = recall.recall(query, { limit: 8 });
const text = renderInjection({ profile, facts, recall: result, topics, maxChars });

console.log(`=== 库内条目 ${entries.length} 条 / 话题 ${topics.topics.length} 个 / 生效事实 ${facts.length} 条 ===`);
const hitTopics = new Set(result.all.map((hit) => topics.byEntryId.get(hit.entry.id)).filter(Boolean));
console.log("命中话题：", [...hitTopics].map((id) => topics.list.get(id)?.title).join(" | ") || "(无)");
console.log("\n=== 召回 ===\n", result.all.map((hit) => `${hit.entry.id} score=${hit.score.toFixed(2)} ${(hit.reasons ?? []).join(",")}`).join("\n") || "(无)");
console.log(`\n=== 注入文本（${text.length} 字符 / 预算 ${maxChars}）===\n${text}`);
