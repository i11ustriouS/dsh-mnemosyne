/**
 * 存储压缩 CLI：把追加式操作流重写成「每条一行最终状态」。
 *
 * 用法：node test/compact.mjs [--apply]
 *
 * 为什么需要它：每轮归档、每次总结更新、每次打标签、每次召回计数都追加一行，
 * 所以 80 条记忆对应上千行操作记录。压缩不丢任何内容，只是丢掉被覆盖的中间版本。
 * ⚠️ 写的是 $DSH_HOME 下的记忆库：从沙箱子进程执行需要提权，否则 EPERM。
 */
import { createStore } from "../lib/store.js";
import { requireDataDir } from "./paths.mjs";

const dataDir = requireDataDir();
const apply = process.argv.includes("--apply");

const store = createStore(dataDir, { maxEntries: 20000, logger: { warn: (message) => console.warn(message) } });
const before = store.stats();

console.log(`数据目录：${dataDir}`);
console.log(`压缩前：${before.count} 条记忆 / 回放 ${before.lines} 行 / 事实 ${before.facts} 条（${before.factsLines} 行）`);
console.log(`需要压缩：${store.needsCompaction() ? "是" : "否"}`);

if (!apply) {
  console.log("\n（预览模式，数据未改动。加 --apply 执行）");
  process.exit(0);
}

const started = Date.now();
const result = store.compact();
const facts = store.compactFacts();
console.log(`\n条目：${result.before} → ${result.after} 行（-${result.shrunk}，${result.files} 个分片）`);
console.log(`事实：${facts.before} → ${facts.after} 行（-${facts.shrunk}）`);
console.log(`耗时 ${Date.now() - started} ms`);

const after = store.stats();
console.log(`\n压缩后：${after.count} 条记忆 / ${after.lines} 行 / 事实 ${after.facts} 条（${after.factsLines} 行）`);
