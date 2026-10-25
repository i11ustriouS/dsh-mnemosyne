/**
 * 重启后的实况验收：直接打运行中 DSH 的插件 API，确认新代码真的生效了。
 *
 * 用法：node test/verify-live.mjs [http://127.0.0.1:62451]
 *
 * 这个脚本只读，不改任何数据。「重启前」和「重启后」各跑一次，输出对比就能看出
 * 新代码（话题聚合 / 事实层 / 回填数据）有没有真的进到运行中的进程里。
 */
const base = (process.argv[2] ?? "http://127.0.0.1:62451").replace(/\/$/u, "");
const api = `${base}/mnemosyne/api`;

let pass = 0;
let fail = 0;
const lines = [];

function ok(label, detail = "") {
  pass += 1;
  lines.push(`  ✓ ${label}${detail ? `  ${detail}` : ""}`);
}
function bad(label, detail = "") {
  fail += 1;
  lines.push(`  ✗ ${label}${detail ? `  ${detail}` : ""}`);
}

async function get(path) {
  const res = await fetch(api + path);
  const text = await res.text();
  try {
    return { status: res.status, ...JSON.parse(text) };
  } catch {
    return { status: res.status, ok: false, error: text.slice(0, 120) };
  }
}

async function post(path, body) {
  const res = await fetch(api + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  try {
    return { status: res.status, ...JSON.parse(text) };
  } catch {
    return { status: res.status, ok: false, error: text.slice(0, 120) };
  }
}

console.log(`目标：${api}\n`);

// 1) Host 插件是否在线
const summary = await get("/summary");
if (summary.ok !== true) {
  console.log(`✗ 插件未响应（HTTP ${summary.status}）：${summary.error ?? ""}`);
  console.log("\n如果这是重启后第一次运行，说明 Host 侧仍未加载 —— 检查 profile 的 dsh.profile.bundles 是否含 dsh-mnemosyne。");
  process.exit(1);
}
ok("Host 插件在线", `HTTP ${summary.status}`);

// 2) 记忆条目是否加载
const count = summary.stats?.count ?? 0;
if (count >= 60) ok("记忆条目已加载", `${count} 条`);
else bad("记忆条目数量偏少", `${count} 条（回填后应 ≥ 67）`);

// 3) 话题索引（新代码才有）
const topics = await get("/topics?limit=5");
if (topics.ok === true) {
  ok("话题接口可用", `${topics.total ?? 0} 个话题`);
  if ((topics.total ?? 0) >= 10) ok("话题聚合生效", (topics.topics ?? []).slice(0, 3).map((topic) => `${topic.count}轮·${topic.title}`).join(" / "));
  else bad("话题数量偏少", `${topics.total ?? 0} 个`);
} else {
  bad("话题接口不可用（旧代码）", `HTTP ${topics.status}`);
}

// 4) 事实库（新代码才有）
const facts = await get("/facts");
if (facts.ok === true) {
  ok("事实接口可用", `${facts.total ?? 0} 条生效事实`);
  const sample = (facts.facts ?? []).slice(0, 3).map((fact) => fact.line ?? `${fact.predicate}=${fact.value}`);
  if ((facts.total ?? 0) > 0) ok("事实已加载", sample.join(" | "));
  else bad("事实库为空", "（mine-facts 写过的 10 条应该能读到）");
} else {
  bad("事实接口不可用（旧代码）", `HTTP ${facts.status}`);
}

// 5) 注入渲染是否用上了新结构
const preview = await post("/preview", { query: "adb_lab 那个安卓测试工具在哪" });
if (preview.ok === true) {
  const text = preview.text ?? "";
  ok("注入渲染可用", `${text.length} 字符`);
  if (text.includes("### 框架")) ok("框架段已渲染");
  else bad("框架段缺失", text.slice(0, 80));
  if (text.includes("目录：")) ok("目录事实进了框架");
  else bad("目录事实没进框架（事实层未生效）");
  if (/·\s*\d+轮/u.test(text)) ok("话题卡片已生效", (text.match(/·\s*\d+轮/u) ?? [""])[0]);
  else bad("没有话题卡片（话题聚合未生效）");
  if (!text.includes("关联：")) ok("无内部匹配细节泄漏");
  else bad("仍在暴露内部匹配细节");
} else {
  bad("注入预览失败", `HTTP ${preview.status}`);
}

// 6) 面板路由是否在（新代码才有）
const status = await get("/backfill/status");
if (status.ok === true) ok("导入历史路由就绪", status.running === true ? "（正在导入）" : "空闲");
else bad("导入历史路由缺失（旧代码）", `HTTP ${status.status}`);

console.log(lines.join("\n"));
console.log(`\n${fail === 0 ? "✅" : "❌"} 通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) {
  console.log("\n失败项说明：");
  console.log("- 若「旧代码」字样出现 → 运行中的进程还是重启前的模块，需要真正重启 DSH");
  console.log("- 若「数量偏少」→ 数据没加载，检查 $DSH_HOME/mnemosyne 下的 entries/ 与 facts.jsonl");
}
process.exitCode = fail === 0 ? 0 : 1;
