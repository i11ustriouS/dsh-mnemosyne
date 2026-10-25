/**
 * 一次性清理：合并「同一件事的不同说法」的多值事实。
 *
 * 例：`全程离线不联网` 与 `要求全程离线不联网` 各占一个槽，
 * 框架里就出现两条一样的意思。这里保留更简洁的写法，其余标记失效。
 *
 * 用法：node test/dedupe-facts.mjs [--apply]
 */
import { createStore } from "../lib/store.js";
import { isActive, sameFactValue } from "../lib/facts.js";
import { requireDataDir } from "./paths.mjs";

const dataDir = requireDataDir();
const apply = process.argv.includes("--apply");

const store = createStore(dataDir, { maxEntries: 20000, logger: { warn: (message) => console.warn(message) } });
const active = store.listFacts().filter((fact) => isActive(fact));

const groups = new Map();
for (const fact of active) {
  const key = `${fact.subject}/${fact.predicate}`;
  const list = groups.get(key);
  if (list === undefined) groups.set(key, [fact]);
  else list.push(fact);
}

const doomed = [];
const report = [];
for (const [key, list] of groups) {
  if (list.length < 2) continue;
  const used = new Set();
  for (let i = 0; i < list.length; i += 1) {
    if (used.has(i)) continue;
    const cluster = [i];
    for (let j = i + 1; j < list.length; j += 1) {
      if (used.has(j)) continue;
      if (sameFactValue(list[i].value, list[j].value)) {
        cluster.push(j);
        used.add(j);
      }
    }
    if (cluster.length < 2) continue;
    // 保留更短的写法（通常更干净），并列时保留更早的
    const members = cluster.map((index) => list[index]);
    members.sort((a, b) => a.value.length - b.value.length || Number(a.validFrom) - Number(b.validFrom));
    const keep = members[0];
    for (const drop of members.slice(1)) doomed.push({ keep, drop });
    report.push({ key, keep: keep.value, drops: members.slice(1).map((fact) => fact.value) });
  }
}

console.log(`生效事实 ${active.length} 条，可合并 ${report.length} 组（涉及 ${doomed.length} 条）${apply ? "（执行）" : "（预览）"}`);
for (const item of report) {
  console.log(`  ${item.key}: 保留「${item.keep}」 ← 并入 ${item.drops.map((value) => `「${value}」`).join("、")}`);
}

if (!apply) {
  console.log("\n（预览模式，数据未改动。加 --apply 执行）");
  process.exit(0);
}

for (const { keep, drop } of doomed) {
  store.retireFact(drop.id, { supersededBy: keep.id });
}
const left = store.listFacts().filter((fact) => isActive(fact));
console.log(`\n已合并。生效事实 ${active.length} → ${left.length} 条。`);
