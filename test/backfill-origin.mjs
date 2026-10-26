/**
 * 给存量记忆补标来源（QQ / local）。
 *
 * 用途：来源识别是在归档那一刻做的。如果你先装了这个插件、后装 dsh-astrbot-ingress，
 * 那段时间里从 QQ 进来的会话会被误标成 local。这个脚本按 ingress 的 sessions.json
 * 反查每个条目的 sessionId，补上 origin / umo / 标签。
 *
 * 只改 origin、umo、tags 三个字段，不动正文。
 *
 * 用法：node test/backfill-origin.mjs [--apply]
 */
import { createStore } from "../lib/store.js";
import { ORIGIN, describeUmo, resolveOrigin, resetOriginCache } from "../lib/origin.js";
import { requireDataDir } from "./paths.mjs";
import { homedir } from "node:os";
import { join } from "node:path";

const apply = process.argv.includes("--apply");
const dataDir = requireDataDir();
const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");

const store = createStore(dataDir, { maxEntries: 20000, logger: { warn: (message) => console.warn(message) } });
const entries = store.load();
resetOriginCache();

console.log(`数据目录：${dataDir}`);
console.log(`记忆 ${entries.length} 条\n`);

const todo = [];
for (const entry of entries) {
  const info = resolveOrigin(entry.sessionId ?? "", dshHome);
  const currentOrigin = entry.origin ?? ORIGIN.LOCAL;
  const currentTags = Array.isArray(entry.tags) ? entry.tags : [];
  const needsOrigin = currentOrigin !== info.origin;
  const needsUmo = (entry.umo ?? "") !== info.umo;
  // 只补缺的标签，不动已有标签（test / backfill / digest 这些要保留）
  const missingTags = info.tags.filter((tag) => !currentTags.includes(tag));
  if (needsOrigin || needsUmo || missingTags.length > 0) {
    todo.push({ entry, info, needsOrigin, needsUmo, missingTags, currentOrigin });
  }
}

const byOrigin = {};
for (const entry of entries) {
  const origin = entry.origin ?? ORIGIN.LOCAL;
  byOrigin[origin] = (byOrigin[origin] ?? 0) + 1;
}
console.log("当前来源分布:", JSON.stringify(byOrigin));

if (todo.length === 0) {
  console.log("\n没有需要补标的条目。");
  process.exit(0);
}

console.log(`\n待补标 ${todo.length} 条${apply ? "（执行）" : "（预览）"}：`);
for (const item of todo.slice(0, 20)) {
  const changes = [];
  if (item.needsOrigin) changes.push(`origin ${item.currentOrigin} → ${item.info.origin}`);
  if (item.needsUmo) changes.push(`umo "${item.entry.umo ?? ""}" → "${item.info.umo}"`);
  if (item.missingTags.length > 0) changes.push(`+${item.missingTags.join(",")}`);
  console.log(`  ${item.entry.id} ${describeUmo(item.info.umo) || "(本地)"}  ${changes.join(" / ")}`);
}
if (todo.length > 20) console.log(`  …还有 ${todo.length - 20} 条`);

if (!apply) {
  console.log("\n（预览模式，数据未改动。加 --apply 执行）");
  process.exit(0);
}

for (const item of todo) {
  const tags = [...(Array.isArray(item.entry.tags) ? item.entry.tags : []), ...item.missingTags];
  store.put({
    ...item.entry,
    origin: item.info.origin,
    umo: item.info.umo,
    tags,
    updatedAt: Date.now(),
  });
}

const after = {};
for (const entry of store.load()) {
  const origin = entry.origin ?? ORIGIN.LOCAL;
  after[origin] = (after[origin] ?? 0) + 1;
}
console.log(`\n已补标 ${todo.length} 条。来源分布：${JSON.stringify(after)}`);