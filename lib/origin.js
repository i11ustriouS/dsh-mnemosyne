/**
 * 来源识别：判断一条记忆来自哪个入口（DSH 网页 / QQ 桥 / 其他）。
 *
 * 背景：`dsh-astrbot-ingress` 用 `ctx.agents.create()` 建会话，**不带任何来源标记**，
 * 所以从会话对象本身看不出它来自 QQ。但它会在
 * `$DSH_HOME/dsh-astrbot-ingress/sessions.json` 里维护一张反查表：
 *
 *   { "<umo>": { sessionId, cwd, chatType, senderId, updatedAt } }
 *
 * 其中 `umo`（unique message origin）形如 `群号` 或 `群号#u用户号`，
 * `chatType` 是 `group` / `private`。我们读这张表来反查 sessionId 的来源。
 *
 * 这个模块不依赖 ingress 是否安装：文件不存在就一律判定为本地（dsh）。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** 来源标签。 */
export const ORIGIN = {
  /** DSH 网页 / 本地会话。 */
  LOCAL: "local",
  /** 经 AstrBot 桥接的 QQ 会话。 */
  QQ: "qq",
};

/** 缓存：文件内容 + 读取时间，避免每轮都读盘。 */
const cache = {
  at: 0,
  mtimeMs: 0,
  /** sessionId → { umo, chatType, senderId, cwd, updatedAt } */
  bySessionId: new Map(),
};

const CACHE_TTL_MS = 5000;

/** ingress 的数据目录。 */
export function ingressDataDir(dshHome) {
  return join(dshHome, "dsh-astrbot-ingress");
}

/**
 * 读取 ingress 的会话映射表。
 * @param {string} dshHome
 * @returns {Map<string, object>} sessionId → 来源信息
 */
export function readIngressSessions(dshHome) {
  const path = join(ingressDataDir(dshHome), "sessions.json");
  const bySessionId = new Map();

  if (!existsSync(path)) return bySessionId;

  try {
    const stat = statSync(path);
    if (stat.mtimeMs === cache.mtimeMs && Date.now() - cache.at < CACHE_TTL_MS) {
      return cache.bySessionId;
    }
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return bySessionId;

    for (const [umo, mapped] of Object.entries(parsed)) {
      if (mapped === null || typeof mapped !== "object") continue;
      const sessionId = typeof mapped.sessionId === "string" ? mapped.sessionId : "";
      if (sessionId === "") continue;
      bySessionId.set(sessionId, {
        umo,
        chatType: mapped.chatType === "group" ? "group" : "private",
        senderId: typeof mapped.senderId === "string" ? mapped.senderId : "",
        cwd: typeof mapped.cwd === "string" ? mapped.cwd : "",
        updatedAt: Number(mapped.updatedAt) || 0,
      });
    }

    cache.at = Date.now();
    cache.mtimeMs = stat.mtimeMs;
    cache.bySessionId = bySessionId;
    return bySessionId;
  } catch {
    // 文件正在被写（半截 JSON）或格式异常：退回上一次的成功结果
    return cache.bySessionId;
  }
}

/**
 * 反查一个会话的来源。
 * @param {string} sessionId
 * @param {string} dshHome
 * @returns {{ origin: string, umo: string, chatType: string, senderId: string, tags: string[] }}
 */
export function resolveOrigin(sessionId, dshHome) {
  const local = { origin: ORIGIN.LOCAL, umo: "", chatType: "", senderId: "", tags: [] };
  if (typeof sessionId !== "string" || sessionId === "") return local;

  const mapped = readIngressSessions(dshHome).get(sessionId);
  if (mapped === undefined) return local;

  // 群聊与私聊分开打标签：群聊内容里混着别人说的话，检索时可能要区别对待
  const tags = [ORIGIN.QQ, "astrbot", mapped.chatType === "group" ? "qq-group" : "qq-private"];
  return {
    origin: ORIGIN.QQ,
    umo: mapped.umo,
    chatType: mapped.chatType,
    senderId: mapped.senderId,
    tags,
  };
}

/** 清空缓存（测试用）。 */
export function resetOriginCache() {
  cache.at = 0;
  cache.mtimeMs = 0;
  cache.bySessionId = new Map();
}

/**
 * 从 umo 里取出可读的会话标识。
 * umo 形如 `123456789`（群）或 `123456789#u987654321`（群里的某人）。
 */
export function describeUmo(umo) {
  const text = String(umo ?? "");
  if (text === "") return "";
  const [base, suffix] = text.split("#");
  if (suffix === undefined) return `群 ${base}`;
  const user = suffix.startsWith("u") ? suffix.slice(1) : suffix;
  return `群 ${base} · 用户 ${user}`;
}