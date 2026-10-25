/**
 * 清理人设框架里的事件：
 *  1. 开发流水（「实现 X」「自检 N 项通过」「压缩 1034→80 行」）
 *  2. 语义重复（同一件事被归纳了多次，如「全程离线」说了三遍）
 *
 * 这些条目会常驻注入，挤占框架预算却没有长期价值。
 * 用法：node test/clean-profile.mjs [--apply]
 */
import { createStore, normalizeProfile } from "../lib/store.js";
import { isProcessEvent } from "../lib/persona.js";
import { tokenize } from "../lib/text.js";
import { requireDataDir } from "./paths.mjs";

const dataDir = requireDataDir();
const apply = process.argv.includes("--apply");

/**
 * 两条事件是不是在说同一件事。
 *
 * 纯 Jaccard 对长度差异敏感：`定下设备测试工具全程离线不联网的硬性红线`
 * 和 `adb_lab 设备测试工具开发，明确「全程严禁联网」红线` 说的是同一件事，
 * 但用词不同、长度不同，Jaccard 只有 0.2。
 *
 * 而覆盖率会随长句变长而稀释。所以判据是「共享**实词**数」：
 * 事件本来就该短，两条共享 2 个以上实词（中文片段 ≥2 字，或 ASCII 词）基本就是在说同一件事。
 */
function contentTokens(text) {
  return new Set(
    tokenize(String(text ?? "")).filter(
      (token) => /^[a-z0-9_.-]{2,}$/iu.test(token) || /^[\u4e00-\u9fa5]{2,}$/u.test(token),
    ),
  );
}

/** 实词里出现这些，说明讲的是"联网红线"这同一件事。 */
const RED_LINE = /联网|离线/u;

function sameEvent(a, b) {
  const left = contentTokens(a);
  const right = contentTokens(b);
  if (left.size === 0 || right.size === 0) return false;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  // 共享两个实词（如「adb_lab」「测试」「红线」）已经很能说明问题
  if (shared >= 2) return true;
  // 「全程离线」与「全程严禁联网」用词不同但同指一条红线
  return RED_LINE.test(String(a ?? "")) && RED_LINE.test(String(b ?? "")) && shared >= 1;
}

const store = createStore(dataDir, { maxEntries: 20000, logger: { warn: (message) => console.warn(message) } });
const profile = store.readProfile();
const events = Array.isArray(profile.events) ? profile.events : [];

const drop = [];
const merged = [];
const keep = [];
for (const event of events) {
  if (isProcessEvent(event.text ?? "")) {
    drop.push(event);
    continue;
  }
  const twin = keep.find((existing) => sameEvent(existing.text, event.text));
  if (twin === undefined) keep.push(event);
  else merged.push({ kept: twin.text, dropped: event.text });
}

console.log(`框架事件 ${events.length} 条：开发流水 ${drop.length} 条，语义重复 ${merged.length} 条${apply ? "（执行）" : "（预览）"}`);
for (const event of drop) console.log(`  ✗[流水] ${event.text}`);
for (const item of merged) console.log(`  ✗[重复] ${item.dropped}\n           ↑ 已有：${item.kept}`);
for (const event of keep) console.log(`  ✓ ${event.text}`);

if (!apply) {
  console.log("\n（预览模式，数据未改动。加 --apply 执行）");
  process.exit(0);
}

if (drop.length > 0 || merged.length > 0) {
  store.writeProfile(normalizeProfile({ ...profile, events: keep }));
  console.log(`\n已清理：删除 ${drop.length} 条流水 + 合并 ${merged.length} 条重复，剩余 ${keep.length} 条。`);
}
