/**
 * 从已有记忆里补抽事实（冷启动）。
 *
 * 回填/归档的 episodes 里本来就藏着「叫我老王」「我不喜欢废话」这类稳定事实，
 * 这个脚本把它们抽出来灌进事实库，并让冲突按时间顺序消解（越晚说的越算数）。
 *
 * 用法：node test/mine-facts.mjs [--dry]
 * ⚠️ 写的是 $DSH_HOME 下的记忆库：从沙箱子进程执行需要提权，否则 EPERM。
 */
import { createStore } from "../lib/store.js";
import { extractFacts } from "../lib/text.js";
import { isActive, resolveFacts } from "../lib/facts.js";
import { requireDataDir } from "./paths.mjs";

const dryRun = process.argv.includes("--dry");

const dataDir = requireDataDir();
const store = createStore(dataDir, { maxEntries: 20000, logger: { warn: (message) => console.warn(message) } });
const entries = store.load().slice().sort((a, b) => Number(a.t) - Number(b.t));

console.log(`数据目录：${dataDir}`);
console.log(`扫描 ${entries.length} 条记忆${dryRun ? "（dry-run）" : ""}\n`);

let written = 0;
let retired = 0;
let touched = 0;
const preview = [];

/**
 * 从实体里挑出"项目目录"级别的路径。
 * 历史对话里的路径常带 markdown 残留（`D:\x`](...）、右括号、被空格截断的用户目录，
 * 这些当事实存下来只会污染注入，所以宁可漏也不收。
 */
function pathFromEntity(entity) {
  const match = String(entity ?? "").match(/^[A-Za-z]:[\\/][^)）\]】}`'"”，。；;:：\s]*/u);
  if (match === null) return "";
  const value = match[0].replace(/[\\/]+$/u, "");
  if (value.length < 5) return "";
  if (/…|\.\.\.$/u.test(value)) return "";                              // 被截断的路径
  if (/^[A-Za-z]:[\\/]?$/u.test(value)) return "";                      // 裸盘符
  if (/^[Cc]:[\\/](Program|ProgramData|Windows|System)([\\/]|$)/iu.test(value)) return "";
  if (/^[Cc]:[\\/]Users([\\/]|$)/u.test(value)) return "";              // 用户目录（噪音）
  if (/[\\/](AppData|Temp|tmp|node_modules|\.cache|AppData\\Local)([\\/]|$)/iu.test(value)) return "";
  if (/\.[A-Za-z0-9]{1,5}$/u.test(value)) return "";                    // 文件而非目录
  return value;
}

for (const entry of entries) {
  const facts = extractFacts(entry.user ?? "");
  // 历史对话里更常见的是「工作目录/项目路径」这类环境事实，从实体里补抽
  for (const entity of entry.entities ?? []) {
    const value = pathFromEntity(entity);
    if (value !== "") facts.push({ subject: "env", predicate: "path", value, polarity: "+", confidence: 0.6 });
  }
  if (facts.length === 0) continue;
  const active = store.listFacts().filter((fact) => isActive(fact, entry.t));
  const { puts, retires, touches } = resolveFacts(active, facts, entry.t);
  for (const item of retires) {
    if (!dryRun) store.retireFact(item.fact.id, { supersededBy: item.supersededBy, validUntil: entry.t });
    retired += 1;
    preview.push(`  失效 ${item.fact.slot} = ${item.fact.value}（${item.reason}）`);
  }
  for (const item of touches) {
    if (!dryRun) store.touchFact(item.id);
    touched += 1;
  }
  for (const fact of puts) {
    if (!dryRun) {
      store.putFact({
        ...fact,
        source: "backfill",
        sourceEntryIds: [entry.id],
        t: entry.t,
      });
    }
    written += 1;
    preview.push(`  断言 ${fact.slot} = ${fact.value}${fact.polarity === "-" ? "（否定）" : ""}`);
  }
}

console.log(preview.join("\n") || "（没有抽到新事实）");
console.log(`\n断言 ${written} 条，失效 ${retired} 条，刷新 ${touched} 条`);

if (!dryRun) {
  const active = store.listFacts().filter((fact) => isActive(fact));  console.log(`\n=== 当前生效事实（${active.length} 条）===`);
  for (const fact of active.slice(0, 40)) {
    console.log(`- ${fact.subject}/${fact.predicate} = ${fact.value}  (${fact.source}, ${new Date(fact.validFrom).toISOString().slice(0, 10)})`);
  }
}
