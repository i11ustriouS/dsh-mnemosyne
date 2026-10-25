/**
 * 历史会话回填 CLI（可独立于运行中的 DSH 执行）。
 *
 * 用法：
 *   node test/backfill.mjs                # 默认 60 个会话 × 每会话最近 30 轮
 *   node test/backfill.mjs 20 15          # 20 个会话 × 15 轮
 *   node test/backfill.mjs --dry          # 只统计不写库
 *
 * 注意：写入的是真实记忆女神文件。运行中的 DSH 内部索引不会立即看到新条目，
 * 重启后（或面板触发一次导入）才会加载——这也是为什么面板里也有导入按钮。
 */
import { createStore } from "../lib/store.js";
import { runBackfill } from "../lib/backfill.js";
import { buildTopics } from "../lib/topics.js";
import { requireDataDir } from "./paths.mjs";
import { join } from "node:path";



const dataDir = requireDataDir();
const sessionsRoot = process.env.MV_SESSIONS_DIR ?? join(dataDir, "..", "sessions");
const args = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const dryRun = process.argv.includes("--dry");
const maxSessions = Number(args[0] ?? 60);
const maxTurns = Number(args[1] ?? 30);

const store = createStore(dataDir, { maxEntries: 20000, logger: { warn: (message) => console.warn(message) } });
const before = store.load();
const existing = new Set(
  before
    .filter((entry) => typeof entry.sessionId === "string" && entry.sessionId !== "" && Number(entry.turn) > 0)
    .map((entry) => `${entry.sessionId}:${entry.turn}`),
);

console.log(`数据目录：${dataDir}`);
console.log(`会话目录：${sessionsRoot}`);
console.log(`现有记忆：${before.length} 条；待回填：最多 ${maxSessions} 个会话 × ${maxTurns} 轮${dryRun ? "（dry-run）" : ""}\n`);

let lastLine = "";
const result = await runBackfill({
  sessionsRoot: [sessionsRoot],
  existing,
  maxSessions,
  maxTurns,
  write: (entry) => {
    if (!dryRun) store.put(entry);
  },
  onProgress: (progress) => {
    const line = `\r[${progress.index}/${progress.total}] ${progress.phase} 写入=${progress.written ?? 0} 跳过=${progress.skipped ?? 0}`;
    if (line !== lastLine) {
      process.stdout.write(line);
      lastLine = line;
    }
  },
});
process.stdout.write("\n");

console.log(`\n会话 ${result.sessions} 个，解析出 ${result.turns} 轮，写入 ${result.written} 条，跳过 ${result.skipped} 条`);

if (result.entries.length > 0) {
  console.log("\n=== 抽样 5 条 ===");
  for (const entry of result.entries.slice(0, 5)) {
    console.log(`- [${new Date(entry.t).toISOString().slice(0, 16).replace("T", " ")}·${entry.kind}] ${entry.summary.slice(0, 90)}`);
    console.log(`  关键词：${entry.keywords.slice(0, 5).join("/")}`);
  }
}

if (!dryRun) {
  const all = store.load();
  const index = buildTopics(all);
  console.log(`\n=== 话题（${index.topics.length} 个，取前 8）===`);
  for (const topic of index.topics.slice(0, 8)) {
    const from = new Date(topic.t0).toISOString().slice(5, 16).replace("T", " ");
    const to = new Date(topic.t1).toISOString().slice(5, 16).replace("T", " ");
    console.log(`- ${from}~${to} · ${topic.count}轮 · ${topic.title}`);
  }
  console.log(`\n库内总计：${all.length} 条`);
}
