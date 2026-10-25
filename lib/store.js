/**
 * 记忆库存储层：log-structured JSONL 分片 + 原子写的 profile。
 *
 * 落盘布局（默认 $DSH_HOME/memory-vault）：
 *   entries/2026-10.jsonl   每月一个分片，逐行追加
 *   profile.json            人设框架（称呼/昵称/性格/重要事件）
 *   state.json              运行时状态（已处理的会话游标、统计）
 *
 * 每行是一个 op：
 *   {"op":"put","entry":{...}}
 *   {"op":"del","id":"..."}
 * 读取时顺序回放得到最终状态，因此更新摘要、删除条目都只追加不重写。
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const MONTH_RE = /^(\d{4})-(\d{2})\.jsonl$/;

/** 时间戳 → 分片名。 */
export function monthKey(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** 生成条目 id。 */
export function newEntryId(now = Date.now()) {
  const rand = Math.random().toString(36).slice(2, 8);
  return `mv-${now.toString(36)}-${rand}`;
}

function readJsonSafe(file, fallback) {
  try {
    const text = readFileSync(file, "utf8");
    if (text.trim() === "") return fallback;
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/** 原子写 JSON（临时文件 + rename），避免半截文件。 */
function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  try {
    renameSync(tmp, file);
  } catch {
    // Windows 上目标被占用时退化为直接覆盖
    try {
      writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
    } finally {
      try {
        unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }
  }
}

/** 默认人设框架。 */
export function emptyProfile() {
  return {
    version: 1,
    user: { name: "", nicknames: [], calledBy: "", tone: "" },
    self: { persona: "", role: "" },
    personality: [],
    preferences: [],
    events: [],
    notes: "",
    updatedAt: 0,
  };
}

/** 归一化外部传入的 profile（容忍缺字段、类型漂移）。 */
export function normalizeProfile(raw) {
  const base = emptyProfile();
  if (raw === null || typeof raw !== "object") return base;
  const arr = (value) =>
    Array.isArray(value) ? value.filter((v) => typeof v === "string" && v.trim() !== "").map((v) => v.trim()).slice(0, 200) : [];
  const str = (value) => (typeof value === "string" ? value.slice(0, 20000) : "");
  const user = raw.user !== null && typeof raw.user === "object" ? raw.user : {};
  const self = raw.self !== null && typeof raw.self === "object" ? raw.self : {};
  return {
    version: 1,
    user: {
      name: str(user.name).slice(0, 200),
      nicknames: arr(user.nicknames),
      calledBy: str(user.calledBy).slice(0, 200),
      tone: str(user.tone).slice(0, 2000),
    },
    self: {
      persona: str(self.persona).slice(0, 8000),
      role: str(self.role).slice(0, 500),
    },
    personality: arr(raw.personality),
    preferences: arr(raw.preferences),
    events: Array.isArray(raw.events)
      ? raw.events
          .filter((e) => e !== null && typeof e === "object" && typeof e.text === "string")
          .map((e) => ({ t: Number.isFinite(e.t) ? Number(e.t) : 0, text: String(e.text).slice(0, 500), kind: typeof e.kind === "string" ? e.kind : "event" }))
          .slice(-500)
      : [],
    notes: str(raw.notes),
    updatedAt: Number.isFinite(raw.updatedAt) ? Number(raw.updatedAt) : 0,
  };
}

/**
 * 创建存储实例。
 * @param {string} root 数据目录
 * @param {{maxEntries?: number, logger?: {warn: (m: string) => void}}} [options]
 */
export function createStore(root, options = {}) {
  const maxEntries = Number.isFinite(options.maxEntries) ? Math.max(100, Number(options.maxEntries)) : 20000;
  const logger = options.logger ?? { warn: () => {} };
  const entriesDir = join(root, "entries");
  const profileFile = join(root, "profile.json");
  const stateFile = join(root, "state.json");

  /** id → entry 的内存视图。 */
  const entries = new Map();
  let loaded = false;
  let entrySeq = new Map(); // id → 最后出现的分片文件（用于清理时判断）

  const ensure = () => {
    mkdirSync(root, { recursive: true });
    mkdirSync(entriesDir, { recursive: true });
  };

  const shards = () => {
    if (!existsSync(entriesDir)) return [];
    return readdirSync(entriesDir)
      .filter((name) => MONTH_RE.test(name))
      .sort();
  };

  const applyOp = (op) => {
    if (op === null || typeof op !== "object") return;
    if (op.op === "put" && op.entry !== null && typeof op.entry === "object" && typeof op.entry.id === "string") {
      entries.set(op.entry.id, op.entry);
      return;
    }
    if (op.op === "del" && typeof op.id === "string") {
      entries.delete(op.id);
    }
  };

  const append = (op) => {
    ensure();
    const t = op.op === "put" ? Number(op.entry?.t ?? Date.now()) : Date.now();
    const file = join(entriesDir, `${monthKey(t)}.jsonl`);
    appendFileSync(file, `${JSON.stringify(op)}\n`, "utf8");
  };

  let loadedLines = 0;

  /** 载入全部分片；返回最终条目数组（按 t 倒序）。 */
  const load = () => {
    let total = 0;
    for (const name of shards()) {
      const file = join(entriesDir, name);
      let text = "";
      try {
        text = readFileSync(file, "utf8");
      } catch (error) {
        logger.warn(`memory-vault: 读取分片 ${name} 失败：${String(error)}`);
        continue;
      }
      for (const line of text.split("\n")) {
        if (line.trim() === "") continue;
        total += 1;
        try {
          applyOp(JSON.parse(line));
        } catch {
          // 单行损坏不影响其它条目
        }
      }
    }
    loaded = true;
    loadedLines = total;
    logger.warn?.(`memory-vault: 载入 ${entries.size} 条记忆（回放 ${total} 行）`);
    return listEntries();
  };

  /**
   * 原子替换文件。Windows 上 renameSync 不能覆盖已存在的目标，
   * 所以用「原文件→.bak、tmp→原名、删 .bak」的夹心写法，失败时回滚。
   */
  const replaceFile = (tmp, target) => {
    const bak = `${target}.bak`;
    if (existsSync(bak)) {
      try {
        unlinkSync(bak);
      } catch {
        /* 旧备份删不掉不影响主流程 */
      }
    }
    if (existsSync(target)) renameSync(target, bak);
    try {
      renameSync(tmp, target);
    } catch (error) {
      if (existsSync(bak)) {
        try {
          renameSync(bak, target);
        } catch {
          /* 回滚也失败：保留 .bak，数据还在盘上 */
        }
      }
      throw error;
    }
    if (existsSync(bak)) {
      try {
        unlinkSync(bak);
      } catch {
        /* 留着无妨 */
      }
    }
  };

  /** 是否需要压缩：操作行数明显多于条目数（说明历史版本堆积）。 */
  const needsCompaction = (ratio = 2.5) => {
    if (!loaded) load();
    if (loadedLines < 200) return false;
    return loadedLines > entries.size * ratio + 50;
  };

  /**
   * 压缩条目分片：把「追加式操作流」重写成「每条一行最终状态」。
   * 内容不变、语义不变，只是丢掉被覆盖的中间版本。
   * 压缩期间若有新写入（文件大小变了）就重来，避免覆盖别人刚写的数据。
   */
  const compact = () => {
    if (!loaded) load();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = loadedLines;
      const groups = new Map();
      for (const entry of entries.values()) {
        const key = monthKey(entry.t);
        const list = groups.get(key);
        if (list === undefined) groups.set(key, [entry]);
        else list.push(entry);
      }
      const sizes = new Map();
      for (const name of shards()) {
        try {
          sizes.set(name, statSync(join(entriesDir, name)).size);
        } catch {
          /* 文件刚被删除 */
        }
      }

      let written = 0;
      let conflict = false;
      for (const [key, list] of groups) {
        list.sort((a, b) => Number(a.t) - Number(b.t));
        const target = join(entriesDir, `${key}.jsonl`);
        const tmp = `${target}.compact`;
        const body = list.map((entry) => JSON.stringify({ op: "put", entry })).join("\n");
        writeFileSync(tmp, body === "" ? "" : `${body}\n`, "utf8");

        let currentSize = null;
        try {
          currentSize = statSync(target).size;
        } catch {
          currentSize = null;
        }
        const knownSize = sizes.get(`${key}.jsonl`);
        if (knownSize !== undefined && currentSize !== null && currentSize !== knownSize) {
          try {
            unlinkSync(tmp);
          } catch {
            /* ignore */
          }
          conflict = true;
          break;
        }
        replaceFile(tmp, target);
        written += list.length;
      }

      if (conflict) {
        // 有人在这期间写过：重新读一遍再来
        entries.clear();
        loaded = false;
        loadedLines = 0;
        load();
        continue;
      }

      // 清掉已经没有条目的旧月份分片
      for (const name of shards()) {
        const key = name.replace(/\.jsonl$/u, "");
        if (!groups.has(key)) {
          try {
            unlinkSync(join(entriesDir, name));
          } catch {
            /* ignore */
          }
        }
      }

      loadedLines = written;
      return { before, after: written, files: groups.size, shrunk: before - written };
    }
    return { before: loadedLines, after: loadedLines, files: 0, shrunk: 0, conflict: true };
  };

  /** 压缩事实库：只保留每条事实的最终状态。 */
  const compactFacts = () => {
    if (!factsLoaded) loadFacts();
    if (!existsSync(factsFile)) return { before: 0, after: 0 };
    let before = 0;
    try {
      before = readFileSync(factsFile, "utf8").split("\n").filter((line) => line.trim() !== "").length;
    } catch {
      before = 0;
    }
    const lines = [...facts.values()].map((fact) => JSON.stringify({ op: "put", fact }));
    const tmp = `${factsFile}.compact`;
    writeFileSync(tmp, lines.length === 0 ? "" : `${lines.join("\n")}\n`, "utf8");
    replaceFile(tmp, factsFile);
    return { before, after: lines.length, shrunk: before - lines.length };
  };

  const ensureLoaded = () => {
    if (!loaded) load();
  };

  /** 丢弃超过 maxEntries 的最旧条目（返回被丢弃的 id）。 */
  const prune = () => {
    if (entries.size <= maxEntries) return [];
    const sorted = [...entries.values()].sort((a, b) => Number(a.t) - Number(b.t));
    const drop = sorted.slice(0, entries.size - maxEntries).map((e) => e.id);
    for (const id of drop) {
      entries.delete(id);
      append({ op: "del", id });
    }
    return drop;
  };

  /** 写入或更新一条记忆。 */
  const put = (entry) => {
    ensureLoaded();
    const record = {
      ...entry,
      updatedAt: Number(entry.updatedAt ?? Date.now()),
    };
    entries.set(record.id, record);
    try {
      append({ op: "put", entry: record });
      loadedLines += 1;
      const dropped = prune();
      if (dropped.length > 0) logger.warn?.(`memory-vault: 超出上限，淘汰 ${dropped.length} 条最旧记忆`);
    } catch (error) {
      logger.warn(`memory-vault: 写入记忆失败：${String(error)}`);
    }
    return record;
  };

  /** 删除一条记忆。 */
  const remove = (id) => {
    ensureLoaded();
    if (!entries.has(id)) return false;
    entries.delete(id);
    try {
      append({ op: "del", id });
      loadedLines += 1;
    } catch (error) {
      logger.warn(`memory-vault: 删除记忆失败：${String(error)}`);
    }
    return true;
  };

  const listEntries = () => {
    ensureLoaded();
    return [...entries.values()].sort((a, b) => Number(b.t) - Number(a.t));
  };

  const getEntry = (id) => {
    ensureLoaded();
    return entries.get(id) ?? null;
  };

  // ── 事实库（语义记忆，与 episodes 分开存） ─────────────────────────────────
  const factsFile = join(root, "facts.jsonl");
  const facts = new Map();
  let factsLoaded = false;

  const applyFactOp = (op) => {
    if (op === null || typeof op !== "object") return;
    if (op.op === "put" && op.fact !== null && typeof op.fact === "object" && typeof op.fact.id === "string") {
      facts.set(op.fact.id, op.fact);
      return;
    }
    if (op.op === "retire" && typeof op.id === "string") {
      const current = facts.get(op.id);
      if (current === undefined) return;
      facts.set(op.id, {
        ...current,
        validUntil: Number(op.validUntil ?? Date.now()),
        supersededBy: typeof op.supersededBy === "string" ? op.supersededBy : null,
      });
      return;
    }
    if (op.op === "touch" && typeof op.id === "string") {
      const current = facts.get(op.id);
      if (current === undefined) return;
      facts.set(op.id, { ...current, lastSeen: Number(op.lastSeen ?? Date.now()), seen: Number(current.seen ?? 1) + 1 });
    }
  };

  const appendFactOp = (op) => {
    ensure();
    appendFileSync(factsFile, `${JSON.stringify(op)}\n`, "utf8");
  };

  const factsSorted = () => [...facts.values()].sort((a, b) => Number(b.t) - Number(a.t));

  const loadFacts = () => {
    if (factsLoaded) return factsSorted();
    if (existsSync(factsFile)) {
      let text = "";
      try {
        text = readFileSync(factsFile, "utf8");
      } catch (error) {
        logger.warn(`memory-vault: 读取事实库失败：${String(error)}`);
      }
      for (const line of text.split("\n")) {
        if (line.trim() === "") continue;
        try {
          applyFactOp(JSON.parse(line));
        } catch {
          // 单行损坏不影响其它事实
        }
      }
    }
    factsLoaded = true;
    return factsSorted();
  };

  const listFacts = () => (factsLoaded ? factsSorted() : loadFacts());

  const putFact = (fact) => {
    if (!factsLoaded) loadFacts();
    facts.set(fact.id, fact);
    try {
      appendFactOp({ op: "put", fact });
    } catch (error) {
      logger.warn(`memory-vault: 写入事实失败：${String(error)}`);
    }
    return fact;
  };

  const retireFact = (id, options = {}) => {
    if (!factsLoaded) loadFacts();
    const current = facts.get(id);
    if (current === undefined) return null;
    const next = {
      ...current,
      validUntil: Number(options.validUntil ?? Date.now()),
      supersededBy: typeof options.supersededBy === "string" ? options.supersededBy : null,
    };
    facts.set(id, next);
    try {
      appendFactOp({ op: "retire", id, validUntil: next.validUntil, supersededBy: next.supersededBy });
    } catch (error) {
      logger.warn(`memory-vault: 事实失效写入失败：${String(error)}`);
    }
    return next;
  };

  const touchFact = (id) => {
    if (!factsLoaded) loadFacts();
    const current = facts.get(id);
    if (current === undefined) return null;
    const next = { ...current, lastSeen: Date.now(), seen: Number(current.seen ?? 1) + 1 };
    facts.set(id, next);
    try {
      appendFactOp({ op: "touch", id, lastSeen: next.lastSeen });
    } catch {
      /* touch 失败不影响正确性 */
    }
    return next;
  };

  const getFact = (id) => {
    if (!factsLoaded) loadFacts();
    return facts.get(id) ?? null;
  };

  const readProfile = () => normalizeProfile(readJsonSafe(profileFile, null));
  const writeProfile = (profile) => {
    ensure();
    const next = normalizeProfile({ ...profile, updatedAt: Date.now() });
    writeJsonAtomic(profileFile, next);
    return next;
  };

  const readState = () => {
    const raw = readJsonSafe(stateFile, {});
    return raw !== null && typeof raw === "object" ? raw : {};
  };

  const writeState = (patch) => {
    ensure();
    const next = { ...readState(), ...patch };
    try {
      writeJsonAtomic(stateFile, next);
    } catch (error) {
      logger.warn(`memory-vault: 写入状态失败：${String(error)}`);
    }
    return next;
  };

  /** 统计信息（面板头部展示）。 */
  const stats = () => {
    const all = listEntries();
    const byKind = new Map();
    let bytes = 0;
    for (const entry of all) {
      byKind.set(entry.kind ?? "chat", (byKind.get(entry.kind ?? "chat") ?? 0) + 1);
    }
    try {
      if (existsSync(entriesDir)) {
        for (const name of shards()) bytes += statSync(join(entriesDir, name)).size;
      }
    } catch {
      /* ignore */
    }
    return {
      root,
      count: all.length,
      byKind: Object.fromEntries(byKind),
      facts: listFacts().length,
      // 生效事实数单独给出：listFacts 含已失效的历史条目，
      // 面板上「事实 N 条」应当指当前生效的那些。
      factsActive: listFacts().filter((fact) => fact.validUntil === null || fact.validUntil === undefined).length,
      lines: loadedLines,
      factsLines: (() => {
        try {
          return existsSync(factsFile) ? readFileSync(factsFile, "utf8").split("\n").filter((line) => line.trim() !== "").length : 0;
        } catch {
          return 0;
        }
      })(),
      newest: all[0]?.t ?? 0,
      oldest: all[all.length - 1]?.t ?? 0,
      bytes,
      loaded,
    };
  };

  return {
    root,
    entriesDir,
    ensure,
    load,
    listEntries,
    getEntry,
    put,
    remove,
    readProfile,
    writeProfile,
    readState,
    writeState,
    loadFacts,
    listFacts,
    putFact,
    retireFact,
    touchFact,
    getFact,
    needsCompaction,
    compact,
    compactFacts,
    stats,
  };
}
