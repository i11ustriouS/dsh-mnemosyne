/**
 * 一次性清理：删掉与「性格」重复的「偏好」事实。
 *
 * 模型常把同一个短语（如「需求推进快」）同时填进 personality 和 preference。
 * 现在归纳时会自动去重，这里处理修复前的遗留数据。
 *
 * 用法：node test/dedupe-cross.mjs [--apply]
 */
import { createStore } from "../lib/store.js";
import { isActive, sameFactValue } from "../lib/facts.js";
import { requireDataDir } from "./paths.mjs";

const dataDir = requireDataDir();
const apply = process.argv.includes("--apply");

const store = createStore(dataDir, { maxEntries: 20000, logger: { warn: (message) => console.warn(message) } });
const active = store.listFacts().filter((fact) => isActive(fact));

const traits = active.filter((fact) => fact.predicate === "personality").map((fact) => fact.value);
const doomed = active.filter(
  (fact) =>
    fact.predicate === "preference"
    && traits.some((trait) => sameFactValue(trait, fact.value)),
);

console.log(`生效事实 ${active.length} 条；性格 ${traits.length} 条；跨谓词重复 ${doomed.length} 条${apply ? "（执行）" : "（预览）"}`);
for (const fact of doomed) console.log(`  ✗ ${fact.id} 偏好「${fact.value}」与性格重复`);

if (!apply) {
  console.log("\n（预览模式，数据未改动。加 --apply 执行）");
  process.exit(0);
}

for (const fact of doomed) store.retireFact(fact.id, {});
const left = store.listFacts().filter((fact) => isActive(fact));
console.log(`\n已清理。生效事实 ${active.length} → ${left.length} 条。`);