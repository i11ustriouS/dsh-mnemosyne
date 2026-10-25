/**
 * 发布到 GitHub 的辅助脚本。
 *
 * 用法：
 *   node publish/gh.mjs topics         给仓库打 dsh-plugin topic
 *   node publish/gh.mjs check          检查仓库状态
 *
 * Token 从环境变量 GITHUB_TOKEN 读，不写进文件。
 * 需要 NODE_EXTRA_CA_CERTS 指向系统证书包（本机有 TLS 中间人）。
 */
const TOKEN = process.env.GITHUB_TOKEN ?? "";
const OWNER = "i11ustriouS";
const REPO = "dsh-mnemosyne";

const headers = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: "application/vnd.github+json",
  "User-Agent": "mnemosyne-publish",
  "Content-Type": "application/json",
};

async function api(path, options = {}) {
  const r = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: { ...headers, ...(options.headers ?? {}) },
    signal: AbortSignal.timeout(30000),
  });
  const text = await r.text();
  let data = null;
  try {
    data = text === "" ? null : JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: r.status, data };
}

const command = process.argv[2] ?? "check";

if (TOKEN === "") {
  console.log("请先设置 GITHUB_TOKEN 环境变量。");
  process.exit(1);
}

if (command === "topics") {
  // 官方收录要求仓库带 dsh-plugin topic
  const current = await api(`/repos/${OWNER}/${REPO}/topics`);
  const names = new Set(current.data?.names ?? []);
  names.add("dsh-plugin");
  names.add("deepseek-harness");
  const r = await api(`/repos/${OWNER}/${REPO}/topics`, {
    method: "PUT",
    body: JSON.stringify({ names: [...names] }),
  });
  console.log(`设置 topics → ${r.status}`);
  console.log("  ", (r.data?.names ?? []).join(", "));
} else {
  const r = await api(`/repos/${OWNER}/${REPO}`);
  if (r.status !== 200) {
    console.log(`仓库不可访问 → ${r.status}`, JSON.stringify(r.data).slice(0, 200));
    process.exit(1);
  }
  const repo = r.data;
  console.log(`仓库：${repo.full_name}`);
  console.log(`  可见性：${repo.private ? "私有" : "公开"}`);
  console.log(`  默认分支：${repo.default_branch}`);
  console.log(`  topics：${(repo.topics ?? []).join(", ") || "（无）"}`);
  console.log(`  size：${repo.size} KB`);
  console.log(`  pushed_at：${repo.pushed_at}`);

  const tree = await api(`/repos/${OWNER}/${REPO}/contents/`);
  if (tree.status === 200 && Array.isArray(tree.data)) {
    console.log(`  根目录文件数：${tree.data.length}`);
    for (const item of tree.data.slice(0, 20)) console.log(`    ${item.type === "dir" ? "📁" : "📄"} ${item.name}`);
  }
}