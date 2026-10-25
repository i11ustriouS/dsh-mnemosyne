/**
 * 一次性清理被污染的事实（修复前的遗留数据）。
 *
 * 清理对象：
 *  1. path 谓词但不是真路径（描述性文字，如「记忆女神面板挂载槽 shell.overlay」）
 *  2. 值是从框架注入回流的内容
 *  3. path 谓词但只是裸文件名/相对裸路径（没有目录上下文，注入里没有意义）
 *
 * 用法：node test/clean-facts.mjs [--apply]
 */
import { createStore } from "../lib/store.js";
import { isActive, isFrameworkEcho, isPathLike } from "../lib/facts.js";
import { requireDataDir } from "./paths.mjs";

const dataDir = requireDataDir();
const apply = process.argv.includes("--apply");

const store = createStore(dataDir, { maxEntries: 20000, logger: { warn: (message) => console.warn(message) } });

/** 裸相对路径（没有盘符、没有 / 开头）在「目录」行里没有意义。 */
function isWeakPath(value) {
  const text = String(value ?? "").trim();
  if (isPathLike(text)) return false;
  if (/^[A-Za-z]:/u.test(text)) return false; // 盘符但含空格等，另有判断
  return !text.includes("/") || !text.includes("../");
}

const active = store.listFacts().filter((fact) => isActive(fact));
const doomed = active.filter((fact) => {
  if (isFrameworkEcho(fact.value)) return true;
  if (fact.predicate !== "path") return false;
  if (!isPathLike(fact.value)) return true;
  return false;
});

console.log(`生效事实 ${active.length} 条，待清理 ${doomed.length} 条${apply ? "（执行）" : "（预览）"}`);
for (const fact of doomed) {
  console.log(`  ${fact.id} ${fact.subject}/${fact.predicate} = ${fact.value}`);
}

if (!apply) {
  console.log("\n（预览模式，数据未改动。加 --apply 执行）");
  process.exit(0);
}

for (const fact of doomed) {
  store.retireFact(fact.id, {});
}
const left = store.listFacts().filter((fact) => isActive(fact));
console.log(`\n已清理。生效事实 ${left.length} 条：`);
for (const fact of left) console.log(`  ${fact.subject}/${fact.predicate} = ${fact.value}`);
