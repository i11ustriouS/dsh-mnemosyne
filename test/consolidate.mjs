/**
 * 记忆固化 CLI（可离线执行、可 dry-run）。
 *
 * 用法：
 *   node test/consolidate.mjs              # 预览（不改数据）
 *   node test/consolidate.mjs --apply      # 真正执行
 *   node test/consolidate.mjs --apply 90   # 只归档 90 天前的
 *
 * 执行逻辑与 Host 内 runConsolidation 一致：只打标签、只新增，原文永不删除。
 * ⚠️ 写的是 $DSH_HOME 下的记忆库：从沙箱子进程执行需要提权，否则 EPERM。
 */
import { createStore, newEntryId } from "../lib/store.js";
import { buildTopics } from "../lib/topics.js";
import { planConsolidation } from "../lib/consolidate.js";
import { requireDataDir } from "./paths.mjs";

const dataDir = requireDataDir();
const apply = process.argv.includes("--apply");
const ageArg = Number(process.argv.find((arg) => /^\d+$/.test(arg)));
const minAgeDays = Number.isFinite(ageArg) && ageArg > 0 ? ageArg : 30;

const store = createStore(dataDir, { maxEntries: 20000, logger: { warn: (message) => console.warn(message) } });
const entries = store.load();
const topics = buildTopics(entries);
const now = Date.now();

const plan = planConsolidation({ entries, topics, now, options: { minAgeDays, minTurns: 5 } });

console.log(`数据目录：${dataDir}`);
console.log(`记忆 ${entries.length} 条 / 话题 ${topics.topics.length} 个 / 归档阈值 ${minAgeDays} 天${apply ? "（执行）" : "（预览）"}`);
console.log(`\n计划：合并 ${plan.stats.duplicates} 条重复 / 生成 ${plan.stats.digests} 条摘要 / 归档 ${plan.stats.archived} 条旧记忆`);

if (plan.groups.length > 0) {
  console.log("\n=== 重复组 ===");
  for (const group of plan.groups.slice(0, 8)) {
    const keep = entries.find((entry) => entry.id === group.keepId);
    console.log(`- 保留 ${group.keepId} ｜ 并入 ${group.dropIds.length} 条 ｜ ${(keep?.summary ?? "").slice(0, 50)}`);
  }
}

if (plan.digests.length > 0) {
  console.log("\n=== 摘要 digest ===");
  for (const item of plan.digests) {
    console.log(`- ${item.topic.count}轮 · ${item.topic.title}`);
    console.log(`  ${item.draft.summary.slice(0, 150)}`);
  }
}

if (plan.archived.length > 0) {
  console.log("\n=== 归档候选 ===");
  for (const id of plan.archived.slice(0, 10)) {
    const entry = entries.find((item) => item.id === id);
    console.log(`- ${id} [${entry?.kind}] ${(entry?.summary ?? "").slice(0, 50)}`);
  }
}

if (!apply) {
  console.log("\n（预览模式，数据未改动。加 --apply 执行）");
  process.exit(0);
}

// ── 执行 ────────────────────────────────────────────────────────────────────
let merged = 0;
let digests = 0;
let archived = 0;
const tagArchived = (entry, extra = {}) => {
  store.put({ ...entry, ...extra, tags: [...new Set([...(entry.tags ?? []), "archived"])], updatedAt: now });
};

for (const group of plan.groups) {
  const keep = store.getEntry(group.keepId);
  if (keep === null) continue;
  store.put({
    ...keep,
    tags: [...new Set([...(keep.tags ?? []), "merged"])],
    mergedFrom: [...new Set([...(keep.mergedFrom ?? []), ...group.dropIds])].slice(-40),
    updatedAt: now,
  });
  for (const dropId of group.dropIds) {
    const drop = store.getEntry(dropId);
    if (drop === null) continue;
    tagArchived(drop, { mergedInto: group.keepId });
    merged += 1;
  }
}

for (const item of plan.digests) {
  const entry = { id: newEntryId(now), ...item.draft };
  store.put(entry);
  for (const id of item.archiveIds) {
    const target = store.getEntry(id);
    if (target === null) continue;
    tagArchived(target, { mergedInto: entry.id });
  }
  digests += 1;
}

for (const id of plan.archived) {
  const target = store.getEntry(id);
  if (target === null) continue;
  tagArchived(target);
  archived += 1;
}

console.log(`\n已执行：合并 ${merged} / 摘要 ${digests} / 归档 ${archived}`);
console.log(`库内总计：${store.load().length} 条（其中 digest ${store.listEntries().filter((entry) => entry.source === "digest").length} 条）`);
