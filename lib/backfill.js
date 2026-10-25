/**
 * 历史会话回填：把 sessions/ 里已有的会话导进记忆库。
 *
 * 优先走 DSH 的 sessionPersistence 服务（正式读取路径，与存储格式解耦）；
 * 服务不可用时退回自己解码 session.v4.jsonl.zstd（多帧追加格式）。
 *
 * 回填不调用模型：一轮几十上百条，逐条总结会烧掉大量 token。
 * 规则摘要够用——它们的主要价值是「能被检索到」，
 * 需要精修时用户可以在面板里逐条触发。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

import { clampText } from "./text.js";
import { fallbackSummary } from "./summarize.js";
import { newEntryId } from "./store.js";

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 从内容块里取纯文本。 */
function textOfBlocks(blocks, limit = 4000) {
  if (!Array.isArray(blocks)) return "";
  let out = "";
  for (const block of blocks) {
    if (block !== null && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
      out += (out === "" ? "" : "\n") + block.text;
      if (out.length >= limit) break;
    }
  }
  return clampText(out, limit);
}

/** 事件数组 → 一轮轮对话（只取正常完成的轮次）。 */
export function turnsFromEvents(events) {
  const turns = [];
  let current = null;
  for (const event of events) {
    if (event === null || typeof event !== "object") continue;
    const type = event.type;
    const data = event.data ?? {};
    if (type === "turn/start") {
      current = { turn: Number(data.turn), users: [], assistants: [], t: Number(event.time) || 0, completed: false };
      continue;
    }
    if (type === "turn/end") {
      if (current !== null && Number(data.turn) === current.turn) {
        current.completed = data.reason?.kind === "completed";
        if (current.completed && (current.users.length > 0 || current.assistants.length > 0)) {
          turns.push({
            turn: current.turn,
            t: current.t || Number(event.time) || Date.now(),
            user: clampText(current.users.join("\n"), 2000),
            assistant: clampText(current.assistants.join("\n"), 4000),
          });
        }
      }
      current = null;
      continue;
    }
    if (current === null) continue;
    if (type === "user/message") {
      const source = data.source;
      if (source !== undefined && source !== null && typeof source.kind === "string" && source.kind !== "user") continue;
      const text = textOfBlocks(data.content, 2000).trim();
      if (text !== "") {
        current.users.push(text);
        if (current.t === 0) current.t = Number(event.time) || 0;
      }
    } else if (type === "assistant/message") {
      const text = textOfBlocks(data.message?.content, 4000).trim();
      if (text !== "") current.assistants.push(text);
    }
  }
  return turns;
}

/** 解码多帧 zstd 会话日志（每帧以 magic 开头，逐帧独立解压）。 */
export function decodeSessionFile(file) {
  const buffer = readFileSync(file);
  const positions = [];
  let cursor = 0;
  while (cursor < buffer.length) {
    const found = buffer.indexOf(ZSTD_MAGIC, cursor);
    if (found < 0) break;
    positions.push(found);
    cursor = found + 4;
  }
  if (positions.length === 0) return [];
  positions.push(buffer.length);
  const chunks = [];
  for (let i = 0; i + 1 < positions.length; i += 1) {
    try {
      chunks.push(zstdDecompressSync(buffer.subarray(positions[i], positions[i + 1])));
    } catch {
      // 单帧损坏不影响其它帧
    }
  }
  const text = Buffer.concat(chunks).toString("utf8");
  const events = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || !trimmed.startsWith("{")) continue;
    try {
      const value = JSON.parse(trimmed);
      if (value !== null && typeof value === "object" && typeof value.type === "string") events.push(value);
    } catch {
      // 跳过损坏行
    }
  }
  return events;
}

/** 文件系统扫描：返回 { sessionId, file, mtime } 列表（新到旧）。 */
export function scanSessionFiles(sessionsRoot) {
  const out = [];
  if (!existsSync(sessionsRoot)) return out;
  let workspaces = [];
  try {
    workspaces = readdirSync(sessionsRoot, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return out;
  }
  for (const workspace of workspaces) {
    const workspaceDir = join(sessionsRoot, workspace.name);
    let sessions = [];
    try {
      sessions = readdirSync(workspaceDir, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      continue;
    }
    for (const session of sessions) {
      const dir = join(workspaceDir, session.name);
      let files = [];
      try {
        files = readdirSync(dir).filter((name) => name.endsWith(".jsonl.zstd"));
      } catch {
        continue;
      }
      if (files.length === 0) continue;
      const file = join(dir, files[0]);
      let mtime = 0;
      try {
        mtime = statSync(file).mtimeMs;
      } catch {
        mtime = 0;
      }
      out.push({ sessionId: session.name, workspace: workspace.name, file, mtime });
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

/**
 * 执行回填（异步分片：每处理完一个会话让出事件循环，避免卡住 DSH）。
 * @param {object} deps
 * @param {string[]} deps.sessionsRoot 候选根目录（$DSH_HOME/sessions）
 * @param {(entry: object) => void} deps.write 写入一条记忆
 * @param {Set<string>} deps.existing `${sessionId}:${turn}` 去重集合
 * @param {number} [deps.maxSessions]
 * @param {number} [deps.maxTurns]
 * @param {(progress: object) => void} [deps.onProgress]
 * @param {AbortSignal} [deps.signal]
 * @returns {Promise<{ sessions: number, turns: number, written: number, skipped: number, entries: Array }>}
 */
export async function runBackfill(deps) {
  const maxSessions = Number.isFinite(deps.maxSessions) ? Math.max(1, Number(deps.maxSessions)) : 60;
  const maxTurns = Number.isFinite(deps.maxTurns) ? Math.max(1, Number(deps.maxTurns)) : 30;
  const existing = deps.existing ?? new Set();
  const onProgress = deps.onProgress ?? (() => {});
  const entries = [];

  const files = [];
  for (const root of deps.sessionsRoot) {
    files.push(...scanSessionFiles(root));
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const selected = files.slice(0, maxSessions);

  let sessions = 0;
  let turns = 0;
  let written = 0;
  let skipped = 0;

  for (let i = 0; i < selected.length; i += 1) {
    if (deps.signal?.aborted) break;
    const item = selected[i];
    onProgress({ phase: "read", index: i + 1, total: selected.length, sessionId: item.sessionId, written, skipped });
    // 让出事件循环：DSH 还在跑对话，不能被回填卡死
    await new Promise((resolve) => setImmediate(resolve));

    let events = [];
    try {
      events = decodeSessionFile(item.file);
    } catch {
      continue;
    }
    if (events.length === 0) continue;
    sessions += 1;

    const all = turnsFromEvents(events);
    turns += all.length;
    // 只保留最近的 maxTurns 轮，避免早期闲聊淹没索引
    const chosen = all.slice(-maxTurns);

    for (const turn of chosen) {
      const key = `${item.sessionId}:${turn.turn}`;
      if (existing.has(key)) {
        skipped += 1;
        continue;
      }
      existing.add(key);
      const fallback = fallbackSummary(turn);
      const entry = {
        id: newEntryId(turn.t),
        t: turn.t,
        sessionId: item.sessionId,
        sessionTitle: "",
        turn: turn.turn,
        kind: fallback.kind,
        user: turn.user,
        assistant: turn.assistant,
        summary: fallback.summary,
        keywords: fallback.keywords,
        entities: fallback.entities,
        tags: ["backfill"],
        source: "backfill",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      entries.push(entry);
      deps.write(entry);
      written += 1;
    }
    onProgress({ phase: "write", index: i + 1, total: selected.length, sessionId: item.sessionId, written, skipped });
  }

  onProgress({ phase: "done", index: selected.length, total: selected.length, written, skipped });
  return { sessions, turns, written, skipped, entries };
}
