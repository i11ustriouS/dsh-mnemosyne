const r = await fetch("https://awesome-dsh-plugin.com/zh/catalog.json", { signal: AbortSignal.timeout(30000) });
const data = await r.json();

console.log("顶层键:", Object.keys(data).join(", "));
console.log("items 类型:", Array.isArray(data.items) ? `数组 ${data.items.length}` : typeof data.items);
console.log("market:", JSON.stringify(data.market));
console.log("install:", JSON.stringify(data.install));

const items = data.items ?? [];
console.log("\n=== memory 类样本（完整字段） ===");
const mem = items.filter((x) => x.cat === "memory");
console.log(`memory 类共 ${mem.length} 个`);
if (mem.length > 0) console.log(JSON.stringify(mem[0], null, 2));

console.log("\n=== 字段统计 ===");
const fields = new Set();
for (const it of items) for (const k of Object.keys(it)) fields.add(k);
console.log([...fields].join(", "));

console.log("\n=== 分类统计 ===");
const byCat = {};
for (const it of items) byCat[it.cat] = (byCat[it.cat] ?? 0) + 1;
console.log(JSON.stringify(byCat, null, 2));