/**
 * 直接调用运行中的 Host 插件 API 触发人设归纳，并观察返回。
 * 用法：node test/diag-persona.mjs
 */
const api = "http://127.0.0.1:62451/memory-vault/api";

const res = await fetch(`${api}/persona/rebuild`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
});
const data = await res.json();

console.log(`HTTP ${res.status} | ok=${data.ok}`);
console.log(`error: ${data.error}`);
if (data.state !== undefined && data.state !== null) console.log(`state: ${JSON.stringify(data.state)}`);
if (data.draft !== null && data.draft !== undefined) {
  console.log(`\ndraft.summary: ${data.draft.summary}`);
  console.log(`draft.facts: ${JSON.stringify(data.draft.facts)}`);
  console.log(`draft.personality: ${JSON.stringify(data.draft.personality)}`);
  console.log(`draft.preferences: ${JSON.stringify(data.draft.preferences)}`);
  console.log(`draft.events: ${JSON.stringify(data.draft.events)}`);
}
