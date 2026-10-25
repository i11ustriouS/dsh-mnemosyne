/**
 * 人设归纳的调用探针：定位「模型没返回文本」到底是哪一步被拒。
 *
 * 用与 summarize 完全相同的参数逐级加料（短 system → PERSONA_PROMPT → 真实 payload），
 * 看哪一级开始出现 finish=aborted。需要重启 DSH 后运行：
 *   node test/probe-persona.mjs
 */
const api = "http://127.0.0.1:62451/memory-vault/api";

const res = await fetch(`${api}/persona/probe`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
});
const data = await res.json();

if (data.ok !== true) {
  console.log(`探针不可用：${data.error}`);
  process.exitCode = 1;
} else {
  console.log(`路由：${data.route.provider}/${data.route.model}`);
  console.log(`真实 payload：${data.payloadChars} 字符\n`);
  for (const item of data.results) {
    const flag = item.textLen > 0 ? "✓" : "✗";
    console.log(`${flag} ${item.name}`);
    console.log(`    chunks=${item.chunks} finish=${item.finish ?? "-"} 文本=${item.textLen} 字符`);
    if (item.text !== "") console.log(`    内容：${JSON.stringify(item.text.slice(0, 90))}`);
    if (item.error !== null) console.log(`    错误：${item.error}`);
  }
  const ok = data.results.filter((item) => item.textLen > 0).length;
  console.log(`\n可用 ${ok} / ${data.results.length} 组`);
  console.log("判读：aborted 是间歇故障（同一参数重跑结果不同），靠重试兜住；max-tokens 截断靠加大 maxTokens 解决");
}