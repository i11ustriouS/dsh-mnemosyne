/**
 * mnemosyne — AI 对话记忆女神（Host 半）。
 *
 * 三件事：
 *  1. 沉淀：每轮对话（turn/end 且成功）结束后，把「用户说的话 + AI 的回应」归档成一条记忆，
 *     附带时间、会话、摘要、关键词、实体、事件类型。
 *  2. 索引与召回：内容倒排 + 对象实体 + 时间 + 事件类型 + 会话五个维度；
 *     召回时只注入「框架 + 索引卡片」，并做思考延伸（同会话上下文 / 共享对象 / 同期同类）。
 *  3. 分层注入：人设框架常驻，记忆索引按当前提问动态检索，整体受字符预算约束。
 *
 * 数据默认落在 $DSH_HOME/mnemosyne，可通过 config.dataDir 改。
 */
import { homedir } from "node:os";
import { join } from "node:path";

import { createStore, newEntryId, emptyProfile, normalizeProfile } from "./lib/store.js";
import { ORIGIN, describeUmo, resolveOrigin } from "./lib/origin.js";
import { createRecall, renderCard, renderTimeline } from "./lib/recall.js";
import { clampText, compactText, detectKind, extractEntities, kindLabel, ruleSummary, topKeywords } from "./lib/text.js";
import { fallbackSummary, renderHitLines, renderInjection, summarizeWithLlm } from "./lib/summarize.js";
import { buildTopics } from "./lib/topics.js";
import { runBackfill } from "./lib/backfill.js";
import { isActive, renderFactLine, resolveFacts, sameFactValue } from "./lib/facts.js";
import { PERSONA_PROMPT, buildPersonaInput, buildPersonaWithLlm, sameEvent } from "./lib/persona.js";
import { planConsolidation } from "./lib/consolidate.js";

export const name = "mnemosyne";
export const inject = ["systemPrompt", "tools", "webServer"];

const API_PREFIX = "/mnemosyne/api";
const TITLE_MAX = 60;

/** 读取配置（兼容 schemastery 的 getter 对象）。 */
function readConfig(raw) {
  const value = raw !== null && typeof raw === "object" && typeof raw.get === "function" ? raw.get() : raw ?? {};
  const num = (key, fallback, min, max) => {
    const n = Number(value[key]);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  };
  const str = (key) => (typeof value[key] === "string" ? value[key].trim() : "");
  return {
    dataDir: str("dataDir"),
    inject: value.inject !== false,
    maxInjectChars: num("maxInjectChars", 2600, 400, 12000),
    autoSummarize: value.autoSummarize !== false,
    summarizeProvider: str("summarizeProvider"),
    summarizeModel: str("summarizeModel"),
    summarizeTimeoutMs: num("summarizeTimeoutMs", 25000, 3000, 120000),
    maxEntries: num("maxEntries", 20000, 100, 200000),
    maxRecall: num("maxRecall", 8, 1, 30),
    recordSubagents: value.recordSubagents === true,
    autoPersona: value.autoPersona !== false,
    personaEvery: num("personaEvery", 10, 3, 500),
    autoConsolidate: value.autoConsolidate !== false,
    consolidateMinAgeDays: num("consolidateMinAgeDays", 30, 1, 3650),
    consolidateDigestAgeDays: num("consolidateDigestAgeDays", 3, 1, 3650),
  };
}

/** DSH 状态根。 */
function resolveDshHome() {
  const env = process.env.DSH_HOME;
  if (typeof env === "string" && env.trim() !== "") return env.trim();
  const profileDir = process.env.DSH_PROFILE_DIR;
  if (typeof profileDir === "string" && profileDir.trim() !== "") {
    // <dsh-home>/profiles/<name> → <dsh-home>
    return join(profileDir.trim(), "..", "..");
  }
  return join(homedir(), ".dsh");
}

/** 从内容块里取纯文本。 */
function textOfBlocks(blocks, limit = 8000) {
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

/** 会话是否属于子代理（按需排除）。 */
function isSubagentSession(session) {
  try {
    const header = session?.header;
    if (header === undefined || header === null) return false;
    if (typeof header.parentSessionId === "string" && header.parentSessionId !== "") return true;
    if (typeof header.parent === "string" && header.parent !== "") return true;
    if (Number.isFinite(header.delegationDepth) && header.delegationDepth > 0) return true;
    return false;
  } catch {
    return false;
  }
}

/** 读取会话事件（兼容同步快照 API 的变化）。 */
function sessionEvents(session) {
  try {
    if (typeof session?.ownEvents === "function") return session.ownEvents();
  } catch {
    /* 继续尝试其它读法 */
  }
  try {
    if (typeof session?.snapshotEvents === "function") return session.snapshotEvents();
  } catch {
    /* ignore */
  }
  if (Array.isArray(session?.events)) return session.events;
  return [];
}

/** 找到会话中最后一条「真人输入」。 */
function lastHumanQuery(session, maxScan = 800) {
  const events = sessionEvents(session);
  const from = Math.max(0, events.length - maxScan);
  for (let i = events.length - 1; i >= from; i -= 1) {
    const event = events[i];
    if (event?.type !== "user/message") continue;
    const source = event.data?.source;
    if (source !== undefined && source !== null && typeof source.kind === "string" && source.kind !== "user") continue;
    const text = textOfBlocks(event.data?.content).trim();
    if (text !== "") return { text, seq: Number(event.seq) || 0 };
  }
  return null;
}

/** 抽出一整轮（用户 + 助手）的文本。 */
function extractTurn(session, turn) {
  const events = sessionEvents(session);
  let endIndex = -1;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.type === "turn/end" && event.data?.turn === turn) {
      endIndex = i;
      break;
    }
  }
  if (endIndex < 0) return null;
  let startIndex = 0;
  for (let i = endIndex - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.type === "turn/start" && event.data?.turn === turn) {
      startIndex = i;
      break;
    }
  }
  const users = [];
  const assistants = [];
  let time = 0;
  for (let i = startIndex; i <= endIndex; i += 1) {
    const event = events[i];
    if (event?.type === "user/message") {
      const source = event.data?.source;
      if (source !== undefined && source !== null && typeof source.kind === "string" && source.kind !== "user") continue;
      const text = textOfBlocks(event.data?.content).trim();
      if (text !== "") {
        users.push(text);
        time = time === 0 ? Number(event.time) || 0 : time;
      }
    } else if (event?.type === "assistant/message") {
      const text = textOfBlocks(event.data?.message?.content).trim();
      if (text !== "") assistants.push(text);
    }
  }
  if (users.length === 0 && assistants.length === 0) return null;
  return {
    user: clampText(users.join("\n"), 6000),
    assistant: clampText(assistants.join("\n"), 6000),
    t: time > 0 ? time : Date.now(),
  };
}

/** 会话标题（优先用 sessionTitle 服务的折叠结果，取不到退回 header）。 */
function sessionTitleOf(session, titleService) {
  try {
    const snapshot = titleService?.get?.(session);
    const title = snapshot?.title;
    if (typeof title === "string" && title.trim() !== "") return clampText(title.trim(), TITLE_MAX);
  } catch {
    /* 服务缺席或会话不可读，继续尝试 header */
  }
  try {
    const header = session?.header;
    if (header === null || header === undefined) return "";
    const candidate = header.title ?? header.name;
    if (typeof candidate === "string" && candidate.trim() !== "") return clampText(candidate.trim(), TITLE_MAX);
  } catch {
    /* ignore */
  }
  return "";
}

export function apply(ctx, rawConfig) {
  const cfg = readConfig(rawConfig);
  const logger = ctx.logger ?? { info() {}, warn() {}, debug() {} };
  const root = cfg.dataDir !== "" ? cfg.dataDir : join(resolveDshHome(), "mnemosyne");
  const store = createStore(root, { maxEntries: cfg.maxEntries, logger });
  const recall = createRecall({ maxRecall: cfg.maxRecall });

  let profile = emptyProfile();
  let ready = false;
  /** 已处理的 sessionId:turn，避免重复归档。 */
  const captured = new Set();
  /** 总结队列：串行，避免并发打爆模型。 */
  const summarizeQueue = [];
  let summarizing = false;
  /** 注入渲染缓存：key → { at, text }。 */
  const injectionCache = new Map();
  /** 进行中的总结任务数（面板可展示）。 */
  let pendingSummaries = 0;
  /** 话题索引：惰性构建，任何写入都让它失效。 */
  let topicsIndex = null;
  /** 历史回填任务状态。 */
  let backfillState = { running: false, index: 0, total: 0, written: 0, skipped: 0, error: null, startedAt: 0, finishedAt: 0 };

  const ensureTopics = () => {
    if (topicsIndex === null) {
      try {
        topicsIndex = buildTopics(store.listEntries());
      } catch (error) {
        logger.warn(`mnemosyne: 话题聚类失败：${String(error)}`);
        topicsIndex = { topics: [], byEntryId: new Map(), list: new Map() };
      }
    }
    return topicsIndex;
  };

  // ── 初始化 ────────────────────────────────────────────────────────────────
  const init = () => {
    if (ready) return;
    try {
      store.ensure();
      profile = store.readProfile();
      const entries = store.load();
      recall.rebuild(entries);
      ready = true;
      logger.info?.(`mnemosyne: 就绪，${entries.length} 条记忆 @ ${root}`);
      // 启动后如果记忆已经涨够一个周期，自动归纳一次框架（不用用户点按钮）
      setTimeout(() => {
        try {
          maybeRebuildPersona();
        } catch {
          /* 归纳失败不影响记忆本身 */
        }
      }, 3000);
      // 启动后检查一次是否需要压缩（追加式日志会累积历史版本）
      setTimeout(() => {
        try {
          if (store.needsCompaction()) runCompaction();
        } catch {
          /* 压缩失败不影响读写 */
        }
      }, 25000);
    } catch (error) {
      logger.warn(`mnemosyne: 初始化失败：${String(error)}`);
    }
  };
  // 不阻塞启动：下一轮事件循环再读盘
  const initTimer = setTimeout(init, 0);
  ctx.effect(() => () => clearTimeout(initTimer), "mnemosyne:init-timer");

  /** 把本轮召回计数回写磁盘（记忆强度），低频批量，避免写放大。 */
  const flushHits = () => {
    try {
      const touched = recall.drainHits();
      for (const entry of touched) store.put(entry);
    } catch (error) {
      logger.warn(`mnemosyne: 回写召回计数失败：${String(error)}`);
    }
  };
  const hitsTimer = setInterval(flushHits, 60000);
  ctx.effect(() => () => {
    clearInterval(hitsTimer);
    flushHits();
  }, "mnemosyne:hits-flush");

  // ── 记忆写入 ──────────────────────────────────────────────────────────────
  const putEntry = (entry) => {
    const saved = store.put(entry);
    recall.add(saved);
    injectionCache.clear();
    topicsIndex = null;
    return saved;
  };

  const activeFacts = () => store.listFacts().filter((fact) => isActive(fact));
  const allFacts = () => store.listFacts();

  /**
   * 写入一批事实，自动做冲突消解：
   * 同槽位不同值 → 旧值失效；相同值 → 只刷新 lastSeen；否定极性 → 让匹配值失效。
   * @param {Array} incoming
   * @param {{entryId?: string, source?: string}} [context]
   */
  const assertFacts = (incoming, context = {}) => {
    if (!Array.isArray(incoming) || incoming.length === 0) return { puts: 0, retires: 0, touches: 0 };
    const now = Date.now();
    const { puts, retires, touches } = resolveFacts(activeFacts(), incoming, now);
    for (const item of retires) {
      store.retireFact(item.fact.id, { supersededBy: item.supersededBy, validUntil: now });
      logger.info?.(`mnemosyne: 事实失效 ${item.fact.slot}（${item.reason}）`);
    }
    for (const item of touches) store.touchFact(item.id);
    for (const fact of puts) {
      store.putFact({
        ...fact,
        source: context.source ?? fact.source ?? "llm",
        sourceEntryIds: Array.isArray(fact.sourceEntryIds) && fact.sourceEntryIds.length > 0
          ? fact.sourceEntryIds
          : context.entryId !== undefined ? [context.entryId] : [],
        t: now,
      });
      logger.info?.(`mnemosyne: 事实写入 ${fact.slot} = ${fact.value}${fact.polarity === "-" ? "（否定）" : ""}`);
    }
    injectionCache.clear();
    return { puts: puts.length, retires: retires.length, touches: touches.length };
  };
  const applyProfileHints = (hints, t) => {

    if (hints === null || hints === undefined) return;
    let changed = false;
    const next = { ...profile, user: { ...profile.user }, self: { ...profile.self }, personality: [...profile.personality], preferences: [...profile.preferences], events: [...profile.events] };
    if (typeof hints.userName === "string" && hints.userName !== "" && next.user.name !== hints.userName) {
      next.user.name = hints.userName;
      changed = true;
    }
    if (typeof hints.nickname === "string" && hints.nickname !== "" && !next.user.nicknames.includes(hints.nickname)) {
      next.user.nicknames = [...next.user.nicknames, hints.nickname].slice(-12);
      changed = true;
    }
    if (typeof hints.calledBy === "string" && hints.calledBy !== "" && next.user.calledBy !== hints.calledBy) {
      next.user.calledBy = hints.calledBy;
      changed = true;
    }
    for (const item of hints.personality ?? []) {
      if (!next.personality.includes(item)) {
        next.personality = [...next.personality, item].slice(-30);
        changed = true;
      }
    }
    for (const item of hints.preference ?? []) {
      if (!next.preferences.includes(item)) {
        next.preferences = [...next.preferences, item].slice(-50);
        changed = true;
      }
    }
    if (typeof hints.event === "string" && hints.event !== "") {
      next.events = [...next.events, { t: Number(t) || Date.now(), text: clampText(hints.event, 200), kind: "event" }].slice(-500);
      changed = true;
    }
    if (changed) {
      profile = store.writeProfile(next);
      injectionCache.clear();
      logger.info?.("mnemosyne: 人设框架已更新");
    }
  };

  /** 用模型总结一条记忆，成功后替换摘要并回填人设线索。 */
  /**
   * 解析用于总结 / 生成人设的模型路由。
   * 优先用配置里显式指定的 provider+model，否则跟随当前会话的默认模型。
   */
  const resolveModelRoute = () => {
    if (cfg.summarizeProvider !== "" && cfg.summarizeModel !== "") {
      return { provider: cfg.summarizeProvider, model: cfg.summarizeModel };
    }
    try {
      const selection = ctx.get?.("agentDefaultModel")?.currentSelection?.();
      if (selection !== null && selection !== undefined) {
        return { provider: selection.provider, model: selection.model };
      }
    } catch {
      /* 没有默认模型：调用方走规则兜底 */
    }
    return null;
  };

  const summarizeOne = async (entry) => {
    const llm = ctx.get?.("llm");
    if (llm === undefined || llm === null || typeof llm.stream !== "function") return;
    const route = resolveModelRoute();
    if (route === null) return;
    pendingSummaries += 1;
    try {
      const result = await summarizeWithLlm({
        route,
        stream: (options) => llm.stream(options),
        turn: { user: entry.user, assistant: entry.assistant, t: entry.t },
        timeoutMs: cfg.summarizeTimeoutMs,
      });
      if (result === null) return;
      const updated = {
        ...entry,
        summary: result.summary,
        keywords: result.keywords,
        entities: result.entities,
        kind: result.kind,
        source: result.source,
        updatedAt: Date.now(),
      };
      putEntry(updated);
      applyProfileHints(result.profile, entry.t);
      if (Array.isArray(result.facts) && result.facts.length > 0) {
        assertFacts(result.facts, { entryId: entry.id, source: "llm" });
      }
      logger.debug?.(`mnemosyne: 已总结 ${entry.id}`);
    } catch (error) {
      logger.warn(`mnemosyne: 总结失败 ${entry.id}：${String(error)}`);
    } finally {
      pendingSummaries = Math.max(0, pendingSummaries - 1);
    }
  };

  const drainSummaries = async () => {
    if (summarizing) return;
    summarizing = true;
    try {
      while (summarizeQueue.length > 0) {
        const entry = summarizeQueue.shift();
        if (entry === undefined) break;
        await summarizeOne(entry);
      }
    } finally {
      summarizing = false;
    }
  };

  /** 归档一轮对话。 */
  /** 人设框架重建状态（面板可显示）。 */
  let personaState = { running: false, lastAt: 0, error: null, summary: "", facts: 0 };

  /**
   * 从记忆里重建人设框架 —— 「框架随对话自行生成」的引擎。
   *
   * 走的是同一条事实管道：模型归纳出 facts → 冲突消解 → 注入时自动投影成框架。
   * 所以改口、纠正、补充都是自然发生的，不需要用户填表。
   * events 和一句话概括写进 profile，因为那是给人看的部分。
   */
  const rebuildPersona = async () => {
    if (personaState.running) return { ok: false, error: "正在生成中，请稍候" };
    const llm = ctx.get?.("llm");
    if (llm === undefined || llm === null || typeof llm.stream !== "function") {
      return { ok: false, error: "当前环境没有可用的模型" };
    }
    const route = resolveModelRoute();
    if (route === null) return { ok: false, error: "没有配置默认模型" };
    const entries = store.listEntries().slice(0, 60);
    if (entries.length === 0) return { ok: false, error: "还没有记忆可以归纳" };

    personaState = { ...personaState, running: true, error: null };
    try {
      const draft = await buildPersonaWithLlm({
        route,
        stream: (options) => llm.stream(options),
        entries,
        facts: activeFacts(),
        timeoutMs: Math.max(cfg.summarizeTimeoutMs, 30000),
      });
      if (draft === null) {
        personaState = { ...personaState, running: false, error: "模型没有返回有效结果" };
        return { ok: false, error: "模型没有返回有效结果" };
      }
      // 性格先入库，偏好里剔除与性格重复的短语：模型常把「需求推进快」两处都填，
      // 只靠渲染层去重的话，事实库里仍会留两条同义项，越攒越多。
      const traitValues = draft.personality;
      const preferenceValues = draft.preferences.filter(
        (value) => !traitValues.some((trait) => sameFactValue(trait, value)),
      );
      const result = assertFacts(
        [
          ...draft.facts,
          ...traitValues.map((value) => ({ subject: "user", predicate: "personality", value })),
          ...preferenceValues.map((value) => ({ subject: "user", predicate: "preference", value })),
        ],
        { source: "persona" },
      );
      if (draft.events.length > 0 || draft.summary !== "") {
        const next = { ...profile, user: { ...profile.user }, self: { ...profile.self } };
        if (draft.events.length > 0) {
          // 按「同一件事」判重，而不是精确文本：每次归纳的措辞都会有差异，
          // 只比字符串会让同一件事每轮都追加一条，几十轮后把框架撑满。
          const merged = [...(next.events ?? [])];
          for (const event of draft.events) {
            const twin = merged.find((existing) => sameEvent(existing.text, event.text));
            if (twin === undefined) {
              merged.push({ t: event.t > 0 ? event.t : Date.now(), text: event.text, kind: "event" });
            } else if (event.text.length > String(twin.text ?? "").length) {
              // 新说法信息更全就替换，保留最新纪要
              twin.text = event.text;
            }
          }
          // 有上限：框架是"精要"，不是流水账
          next.events = merged.sort((a, b) => Number(a.t) - Number(b.t)).slice(-12);
        }
        if (draft.summary !== "") next.notes = draft.summary;
        profile = normalizeProfile(next);
        store.writeProfile(profile);
      }
      personaState = { running: false, lastAt: Date.now(), error: null, summary: draft.summary, facts: result.puts };
      injectionCache.clear();
      logger.info?.(`mnemosyne: 人设框架已重建（事实 +${result.puts} / -${result.retires}）`);
      return { ok: true, ...result, draft, profile: normalizeProfile(profile) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      personaState = { ...personaState, running: false, error: message };
      logger.warn(`mnemosyne: 人设重建失败：${message}`);
      return { ok: false, error: message };
    } finally {
      personaState = { ...personaState, running: false };
    }
  };

  /** 记忆增长到一定量就自动重建一次框架（这就是"随对话自行生成"）。 */
  const maybeRebuildPersona = () => {
    if (!cfg.autoPersona) return;
    try {
      const snapshot = store.stats();
      const count = snapshot.count;
      const state = store.readState();
      const lastCount = Number(state.personaCount ?? 0);
      if (count - lastCount < cfg.personaEvery) return;
      // 先在状态里记下水位，避免并发重复触发
      store.writeState({ ...state, personaCount: count, personaAt: Date.now() });
      void rebuildPersona();
    } catch (error) {
      logger.warn(`mnemosyne: 自动重建框架失败：${String(error)}`);
    }
  };

  /** 压缩状态（面板可显示）。 */
  let compactState = { lastAt: 0, error: null, result: null };

  /**
   * 压缩存储：把追加式操作流重写成「每条一行最终状态」。
   * 语义不变（回放结果完全一致），只是丢掉被覆盖的中间版本。
   */
  const runCompaction = () => {
    try {
      const result = store.compact();
      const facts = store.compactFacts();
      compactState = { lastAt: Date.now(), error: null, result: { ...result, facts } };
      logger.info?.(
        `mnemosyne: 压缩完成（条目 ${result.before} → ${result.after} 行，事实 ${facts.before} → ${facts.after} 行）`,
      );
      return { ok: true, ...result, facts };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      compactState = { ...compactState, error: message };
      logger.warn(`mnemosyne: 压缩失败：${message}`);
      return { ok: false, error: message };
    }
  };

  /** 固化运行状态。 */
  let consolidateState = { running: false, lastAt: 0, error: null, stats: null };

  /**
   * 执行记忆固化：合并近似重复、把大话题压成摘要、归档低价值旧条目。
   * 全部操作**只打标签、只新增**，原文永不删除 —— 误判可以撤销。
   */
  const runConsolidation = async (options = {}) => {
    if (consolidateState.running) return { ok: false, error: "正在固化中，请稍候" };
    init();
    const now = Date.now();
    try {
      const entries = store.listEntries();
      const plan = planConsolidation({
        entries,
        topics: ensureTopics(),
        now,
        options: {
          dedupeThreshold: options.dedupeThreshold,
          archiveMinAgeDays: options.minAgeDays ?? cfg.consolidateMinAgeDays,
          digestMinAgeDays: cfg.consolidateDigestAgeDays,
          minTurns: options.minTurns,
        },
      });
      if (options.dryRun === true) {
        return {
          ok: true,
          dryRun: true,
          stats: plan.stats,
          groups: plan.groups.slice(0, 10),
          digests: plan.digests.map((item) => ({ title: item.topic.title, count: item.topic.count })),
        };
      }

      consolidateState = { ...consolidateState, running: true, error: null };
      const stats = { merged: 0, digests: 0, archived: 0 };
      const tagArchived = (entry, extra = {}) => {
        putEntry({
          ...entry,
          ...extra,
          tags: [...new Set([...(entry.tags ?? []), "archived"])],
          updatedAt: now,
        });
      };

      // 1) 合并近似重复：保留信息最全的一条，其余打 archived + mergedInto
      for (const group of plan.groups) {
        const keep = store.getEntry(group.keepId);
        if (keep === null) continue;
        putEntry({
          ...keep,
          tags: [...new Set([...(keep.tags ?? []), "merged"])],
          mergedFrom: [...new Set([...(keep.mergedFrom ?? []), ...group.dropIds])].slice(-40),
          updatedAt: now,
        });
        for (const dropId of group.dropIds) {
          const drop = store.getEntry(dropId);
          if (drop === null) continue;
          tagArchived(drop, { mergedInto: group.keepId });
          stats.merged += 1;
        }
      }

      // 2) 大话题压成一条 digest，原始轮次归档（细节仍可 memory_recall 展开）
      for (const item of plan.digests) {
        const entry = putEntry({ id: newEntryId(now), ...item.draft });
        for (const id of item.archiveIds) {
          const target = store.getEntry(id);
          if (target === null) continue;
          tagArchived(target, { mergedInto: entry.id });
        }
        stats.digests += 1;
      }

      // 3) 低价值旧条目归档（退出自动召回，手动可搜）
      for (const id of plan.archived) {
        const target = store.getEntry(id);
        if (target === null) continue;
        tagArchived(target);
        stats.archived += 1;
      }

      topicsIndex = null;
      injectionCache.clear();
      consolidateState = { running: false, lastAt: now, error: null, stats };
      logger.info?.(`mnemosyne: 固化完成（合并 ${stats.merged} / 摘要 ${stats.digests} / 归档 ${stats.archived}）`);
      return { ok: true, ...stats };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      consolidateState = { ...consolidateState, running: false, error: message };
      logger.warn(`mnemosyne: 固化失败：${message}`);
      return { ok: false, error: message };
    }
  };

  /** 定时固化：启动 1 分钟后一次，之后每 12 小时一次。 */
  const scheduleConsolidation = () => {
    if (!cfg.autoConsolidate) return;
    const run = () => {
      void runConsolidation({ minAgeDays: cfg.consolidateMinAgeDays });
    };
    const firstTimer = setTimeout(run, 60 * 1000);
    const interval = setInterval(run, 12 * 60 * 60 * 1000);
    ctx.effect(() => () => {
      clearTimeout(firstTimer);
      clearInterval(interval);
    }, "mnemosyne:consolidate-timer");
  };

  const captureTurn = (session, turn) => {
    init();
    const key = `${session?.id ?? "?"}:${turn}`;
    if (captured.has(key)) return;
    captured.add(key);
    if (captured.size > 5000) captured.clear();

    if (!cfg.recordSubagents && isSubagentSession(session)) return;
    const data = extractTurn(session, turn);
    if (data === null) return;
    const fallback = fallbackSummary(data);
    // 来源识别：QQ 桥接进来的会话在 ingress 的 sessions.json 里有反查表，
    // 命中就打上 qq 相关标签并记下 umo（群号/用户号），供检索隔离与筛选。
    const sessionId = typeof session?.id === "string" ? session.id : "";
    const originInfo = resolveOrigin(sessionId, resolveDshHome());
    const tags = originInfo.tags.length > 0 ? [...originInfo.tags] : [];
    const entry = {
      id: newEntryId(data.t),
      t: data.t,
      sessionId,
      sessionTitle: sessionTitleOf(session, ctx.get?.("sessionTitle")) || (originInfo.umo !== "" ? describeUmo(originInfo.umo) : ""),
      turn,
      kind: fallback.kind,
      user: data.user,
      assistant: data.assistant,
      summary: fallback.summary,
      keywords: fallback.keywords,
      entities: fallback.entities,
      tags,
      origin: originInfo.origin,
      umo: originInfo.umo,
      source: "rule",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    putEntry(entry);
    // 规则层也能抓到称呼/偏好这类人设线索，先落框架；模型总结若给出更准的会覆盖
    if (fallback.profile !== null) applyProfileHints(fallback.profile, entry.t);
    if (Array.isArray(fallback.facts) && fallback.facts.length > 0) {
      assertFacts(fallback.facts, { entryId: entry.id, source: "rule" });
    }
    // 记忆攒够一定量就顺手把框架重建一次（随对话自行生成）
    maybeRebuildPersona();
    logger.info?.(`mnemosyne: 归档一轮 ${entry.id}（${kindLabel(entry.kind)}，${entry.user.length} 字）`);
    if (cfg.autoSummarize) {
      summarizeQueue.push(entry);
      void drainSummaries();
    }
  };

  // 监听会话事件：一轮结束即归档
  ctx.on("session/event", (session, event) => {
    try {
      if (event?.type !== "turn/end") return;
      const reason = event.data?.reason;
      if (reason?.kind !== "completed") return;
      const turn = Number(event.data?.turn);
      if (!Number.isFinite(turn)) return;
      // 让本轮事件先落定，下一拍再读日志
      setTimeout(() => {
        try {
          captureTurn(session, turn);
        } catch (error) {
          logger.warn(`mnemosyne: 归档异常：${String(error)}`);
        }
      }, 0);
    } catch (error) {
      logger.warn(`mnemosyne: session/event 处理异常：${String(error)}`);
    }
  });

  // ── 上下文注入 ────────────────────────────────────────────────────────────
  const agentsService = () => ctx.get?.("agents");

  const renderFor = (assembly) => {
    if (!cfg.inject) return "";
    init();
    let agent = assembly?.agent;
    if (agent === undefined || agent === null) {
      try {
        agent = agentsService()?.currentInitiator?.();
      } catch {
        agent = undefined;
      }
    }
    if (agent === undefined || agent === null) return "";
    if (!cfg.recordSubagents && isSubagentSession(agent.session)) return "";
    const session = agent.session;
    const query = lastHumanQuery(session);
    const sessionId = typeof session?.id === "string" ? session.id : "";
    // 单向隔离：QQ 会话只召回 QQ 自己的记忆，看不到 DSH 网页里的对话。
    // 反过来（DSH 侧）不设限，所以是单向的 —— 网页里能翻到群里说过什么，群里看不到你在网页里的工作。
    const originInfo = resolveOrigin(sessionId, resolveDshHome());
    const originScope = originInfo.origin === ORIGIN.QQ ? ORIGIN.QQ : null;
    const cacheKey = `${sessionId}:${query?.seq ?? 0}:${recall.size()}:${originScope ?? "all"}`;
    const cached = injectionCache.get(cacheKey);
    const now = Date.now();
    if (cached !== undefined && now - cached.at < 30000) return cached.text;

    let text = "";
    try {
      if (query !== null) {
        const result = recall.recall(query.text, { now, limit: cfg.maxRecall, originScope });
        text = renderInjection({
          profile,
          recall: result,
          topics: ensureTopics(),
          facts: activeFacts(),
          maxChars: cfg.maxInjectChars,
          sessionTitle: sessionTitleOf(session, ctx.get?.("sessionTitle")),
        });
      } else {
        // 新会话、还没有提问：给人设框架 + 最近记忆（标了 test 的自检数据不注入）
        // 同样受单向隔离约束：QQ 新会话不该看到 DSH 网页里的最近对话
        const recent = store.listEntries()
          .filter((entry) => !(entry.tags ?? []).includes("test"))
          .filter((entry) => originScope === null || (entry.origin ?? ORIGIN.LOCAL) === originScope)
          .slice(0, 5);
        text = renderInjection({
          profile,
          recent,
          topics: ensureTopics(),
          facts: activeFacts(),
          maxChars: cfg.maxInjectChars,
          sessionTitle: sessionTitleOf(session, ctx.get?.("sessionTitle")),
        });
      }
    } catch (error) {
      logger.warn(`mnemosyne: 注入渲染失败：${String(error)}`);
      return "";
    }
    if (injectionCache.size > 64) injectionCache.clear();
    injectionCache.set(cacheKey, { at: now, text });
    return text;
  };

  ctx.effect(() => ctx.systemPrompt.context({
    name: "mnemosyne:recall",
    order: 105,
    text: renderFor,
  }), "mnemosyne:prompt-context");

  // ── 工具 ──────────────────────────────────────────────────────────────────
  const hitToJson = (hit) => ({
    id: hit.entry.id,
    time: hit.entry.t,
    kind: hit.entry.kind,
    summary: hit.entry.summary || clampText(hit.entry.user, 120),
    keywords: hit.entry.keywords.slice(0, 6),
    entities: hit.entry.entities.slice(0, 6),
    sessionTitle: hit.entry.sessionTitle,
    // 来源：让模型和面板都知道这条记忆是从哪来的（DSH 网页 / QQ 桥）
    origin: hit.entry.origin ?? ORIGIN.LOCAL,
    umo: hit.entry.umo ?? "",
    umoLabel: describeUmo(hit.entry.umo ?? ""),
    tags: hit.entry.tags ?? [],
    reasons: hit.reasons,
  });

  ctx.effect(() => ctx.tools.register({
    name: "memory_search",
    description:
      "在长期记忆里检索过去的对话。返回按相关度排序的记忆索引（时间、类型、摘要、关键词、id），不含全文；需要细节再用 memory_recall(id) 取原文。可用于回答「上次说的那个」「之前那个项目」之类的问题。记忆可能来自不同入口（DSH 网页对话、经 AstrBot 桥接的 QQ 会话）；在 QQ 会话里默认只搜 QQ 自己的记忆，要翻网页里的对话需显式传 scope=all。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "检索内容：关键词、项目名、事件描述都可以，中文原文即可。" },
        limit: { type: "integer", description: "返回条数，默认 8，最大 20。" },
        scope: {
          type: "string",
          enum: ["all", "local", "qq"],
          description: "来源范围：all 全部（默认）；local 只搜 DSH 网页里的对话；qq 只搜 QQ 桥接进来的对话。",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: {
          hits: { type: "array", items: { type: "object" } },
          total: { type: "integer" },
          query: { type: "string" },
        },
        required: ["hits", "total"],
        additionalProperties: false,
      },
      render: (args, value) => {
        if (!value || !Array.isArray(value.hits) || value.hits.length === 0) {
          return [{ type: "text", text: "记忆里没有找到相关内容。" }];
        }
        // 按话题归并：同一件事的多轮只占一行
        const asHits = value.hits.map((hit) => ({
          entry: {
            id: hit.id,
            t: hit.time,
            kind: hit.kind,
            summary: hit.summary,
            keywords: hit.keywords ?? [],
            entities: hit.entities ?? [],
            sessionTitle: hit.sessionTitle ?? "",
            tags: [],
            user: "",
            assistant: "",
          },
          score: 1,
          reasons: hit.reasons ?? [],
        }));
        const lines = renderHitLines(asHits, ensureTopics());
        return [{ type: "text", text: `记忆命中 ${value.hits.length} 条：\n${lines.join("\n")}` }];
      },
    },
    async execute(args) {
      init();
      const query = typeof args?.query === "string" ? args.query : "";
      const limit = Math.min(20, Math.max(1, Number(args?.limit) || cfg.maxRecall));
      // scope 允许手动跨来源检索：默认在 QQ 会话里只搜 QQ 记忆（单向隔离），
      // 显式传 all 才能翻到 DSH 网页里的对话。DSH 侧默认就是 all。
      const scope = typeof args?.scope === "string" ? args.scope : "";
      const originScope = scope === "qq" ? ORIGIN.QQ : scope === "local" ? ORIGIN.LOCAL : null;
      const result = recall.recall(query, { limit, originScope });
      return {
        query,
        total: result.all.length,
        hits: result.all.map(hitToJson),
      };
    },
  }), "mnemosyne:tool-search");

  ctx.effect(() => ctx.tools.register({
    name: "memory_recall",
    description: "按 id 取回一条（或多条）记忆的原文，包括用户原话与 AI 当时的回应。配合 memory_search 使用。",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "记忆 id（memory_search 返回的 id 字段，或形如 mv-xxxx）。" },
        ids: { type: "array", items: { type: "string" }, description: "一次取多条时使用。" },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: { entries: { type: "array", items: { type: "object" } }, missing: { type: "array", items: { type: "string" } } },
        required: ["entries"],
        additionalProperties: false,
      },
      render: (args, value) => {
        const list = Array.isArray(value?.entries) ? value.entries : [];
        if (list.length === 0) return [{ type: "text", text: "没有找到对应的记忆条目。" }];
        const blocks = list.map((entry) => {
          const d = new Date(entry.time);
          const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
          const related = Array.isArray(entry.related) ? entry.related : [];
          const relatedBlock = related.length > 0
            ? `\n**这个摘要覆盖的原始轮次**（共 ${entry.digestCount ?? related.length} 条，这里是要点；需要某轮原文可在 memory_search 里用关键词精确检索）：\n${related.map((item) => `- [${kindLabel(item.kind)}] ${item.summary}`).join("\n")}`
            : "";
          const user = entry.user !== "" ? entry.user : entry.source === "digest" ? entry.summary : "（空）";
          const assistant = entry.assistant !== "" ? entry.assistant : "（这条是话题摘要，没有单独的单轮回复）";
          return `### ${stamp} · ${kindLabel(entry.kind)} · ${entry.id}\n**用户**：${user}\n**AI**：${assistant}${relatedBlock}`;
        });
        return [{ type: "text", text: blocks.join("\n\n") }];
      },
    },
    async execute(args) {
      init();
      const ids = [];
      if (typeof args?.id === "string" && args.id.trim() !== "") ids.push(args.id.trim());
      if (Array.isArray(args?.ids)) for (const id of args.ids) if (typeof id === "string" && id.trim() !== "") ids.push(id.trim());
      const entries = [];
      const missing = [];
      for (const id of ids.slice(0, 20)) {
        const entry = store.getEntry(id);
        if (entry === null) {
          missing.push(id);
          continue;
        }
        // 摘要条目：把被压缩的原始轮次要点一起带出来，避免细节彻底丢失
        const related = [];
        if (entry.source === "digest" && Array.isArray(entry.digestOf)) {
          for (const sourceId of entry.digestOf.slice(0, 8)) {
            const source = store.getEntry(sourceId);
            if (source === null) continue;
            related.push({ id: source.id, time: source.t, kind: source.kind, summary: source.summary });
          }
        }
        entries.push({
          id: entry.id,
          time: entry.t,
          kind: entry.kind,
          summary: entry.summary,
          keywords: entry.keywords,
          user: entry.user,
          assistant: entry.assistant,
          sessionTitle: entry.sessionTitle,
          source: entry.source ?? "turn",
          digestCount: Array.isArray(entry.digestOf) ? entry.digestOf.length : 0,
          related,
        });
      }
      return { entries, missing };
    },
  }), "mnemosyne:tool-recall");

  ctx.effect(() => ctx.tools.register({
    name: "memory_note",
    description:
      "把一件值得长期记住的事写进记忆（不依赖自动归档）。适合：用户明确要求记住、关键结论、重要决定、用户偏好。写入后立即可被后续对话召回。",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "要记住的内容，一到两句话，自包含。" },
        kind: {
          type: "string",
          enum: ["identity", "decision", "event", "task", "emotion", "knowledge", "chat"],
          description: "事件类型：identity=人设/称呼；decision=决策；event=发生的事；task=任务；emotion=情绪；knowledge=知识；chat=其它。",
        },
        keywords: { type: "array", items: { type: "string" }, description: "可选检索关键词。" },
        tags: { type: "array", items: { type: "string" }, description: "可选标签。标了 test 的条目不会自动注入上下文（手动搜索仍可见）。" },
      },
      required: ["text"],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: {
          id: { type: "string" },
          time: { type: "integer" },
          kind: { type: "string" },
          summary: { type: "string" },
        },
        required: ["id", "time", "kind", "summary"],
        additionalProperties: false,
      },
      render: (args, value) => [{ type: "text", text: `已记入记忆（${kindLabel(value.kind)}，id=${value.id}）：${value.summary}` }],
    },
    async execute(args) {
      init();
      const text = typeof args?.text === "string" ? args.text.trim() : "";
      if (text === "") throw new Error("memory_note: text 不能为空");
      const now = Date.now();
      const kind = typeof args?.kind === "string" && args.kind !== "" ? args.kind : detectKind(text);
      const keywords = Array.isArray(args?.keywords) && args.keywords.length > 0
        ? args.keywords.filter((k) => typeof k === "string").slice(0, 10)
        : topKeywords(text, 6);
      const tags = Array.isArray(args?.tags) ? args.tags.filter((tag) => typeof tag === "string" && tag !== "").slice(0, 8) : [];
      const entry = {
        id: newEntryId(now),
        t: now,
        sessionId: "",
        sessionTitle: "",
        turn: 0,
        kind,
        user: clampText(text, 4000),
        assistant: "",
        summary: clampText(text, 160),
        keywords,
        entities: extractEntities(text).slice(0, 10),
        tags,
        source: "manual",
        createdAt: now,
        updatedAt: now,
      };
      putEntry(entry);
      return { id: entry.id, time: entry.t, kind: entry.kind, summary: entry.summary };
    },
  }), "mnemosyne:tool-note");

  ctx.effect(() => ctx.tools.register({
    name: "memory_profile",
    description:
      "读取或更新「人设框架」：用户的称呼/昵称、AI 的自我设定、用户性格与偏好、重要事件节点。read 返回当前框架；update 按字段合并。调用方不需要知道存储路径。",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["read", "update"], description: "read 读取；update 更新。" },
        patch: {
          type: "object",
          description: "update 时提供的字段（只写需要改的）：userName/nicknames/calledBy/tone/persona/role/personality/preferences/notes/event",
          additionalProperties: true,
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: { profile: { type: "object" } },
        required: ["profile"],
        additionalProperties: false,
      },
      render: (args, value) => {
        const p = value.profile ?? {};
        const lines = [];
        if (p.user?.name) lines.push(`用户：${p.user.name}`);
        if (p.user?.nicknames?.length) lines.push(`昵称：${p.user.nicknames.join("、")}`);
        if (p.user?.calledBy) lines.push(`称呼：${p.user.calledBy}`);
        if (p.user?.tone) lines.push(`基调：${p.user.tone}`);
        if (p.self?.persona) lines.push(`AI 人设：${p.self.persona}`);
        if (p.personality?.length) lines.push(`性格：${p.personality.join("、")}`);
        if (p.preferences?.length) lines.push(`偏好：${p.preferences.join("、")}`);
        if (p.events?.length) lines.push(`重要事件：${p.events.slice(-5).map((e) => e.text).join("；")}`);
        return [{ type: "text", text: lines.length > 0 ? lines.join("\n") : "人设框架还是空的。" }];
      },
    },
    async execute(args) {
      init();
      if (args?.action === "update") {
        const patch = args?.patch !== null && typeof args?.patch === "object" ? args.patch : {};
        const current = { ...profile };
        const next = {
          ...current,
          user: { ...current.user },
          self: { ...current.self },
          personality: [...current.personality],
          preferences: [...current.preferences],
          events: [...current.events],
        };
        if (typeof patch.userName === "string") next.user.name = patch.userName;
        if (typeof patch.calledBy === "string") next.user.calledBy = patch.calledBy;
        if (typeof patch.tone === "string") next.user.tone = patch.tone;
        if (typeof patch.persona === "string") next.self.persona = patch.persona;
        if (typeof patch.role === "string") next.self.role = patch.role;
        if (typeof patch.notes === "string") next.notes = patch.notes;
        if (Array.isArray(patch.nicknames)) next.user.nicknames = patch.nicknames.filter((v) => typeof v === "string");
        if (Array.isArray(patch.personality)) {
          for (const item of patch.personality) if (typeof item === "string" && item !== "" && !next.personality.includes(item)) next.personality.push(item);
        }
        if (Array.isArray(patch.preferences)) {
          for (const item of patch.preferences) if (typeof item === "string" && item !== "" && !next.preferences.includes(item)) next.preferences.push(item);
        }
        if (typeof patch.event === "string" && patch.event !== "") {
          next.events.push({ t: Date.now(), text: clampText(patch.event, 200), kind: "event" });
        }
        profile = store.writeProfile(next);
        injectionCache.clear();
      }
      return { profile: normalizeProfile(profile) };
    },
  }), "mnemosyne:tool-profile");

  ctx.effect(() => ctx.tools.register({
    name: "memory_facts",
    description:
      "语义记忆：读取或维护**稳定事实**（称呼、名字、偏好、人设、路径、模型等）。与按轮次归档的情景记忆分开——同一槽位写入新值会自动让旧值失效，所以用户改口后不会同时召回两个矛盾答案。",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["read", "assert", "retract"],
          description: "read 读取当前生效的事实；assert 断言新事实（同槽位冲突时旧值失效）；retract 让某条事实失效。",
        },
        facts: {
          type: "array",
          description: "assert 时提供，每项 {subject, predicate, value, polarity?}。subject: user|assistant|env；predicate: nickname|name|calledBy|persona|role|preference|personality|path|model|language|tag；polarity: \"+\"（默认断言）或 \"-\"（否定，例如「以后别叫我老王」）。",
          items: { type: "object" },
        },
        id: { type: "string", description: "retract 时的事实 id。" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: {
          facts: { type: "array", items: { type: "object" } },
          result: { type: "object" },
        },
        additionalProperties: false,
      },
      render: (args, value) => {
        if (value.result !== undefined && value.result !== null) {
          return [{
            type: "text",
            text: `事实库已更新：断言 ${value.result.puts ?? 0} 条，失效 ${value.result.retires ?? 0} 条。`,
          }];
        }
        const list = Array.isArray(value.facts) ? value.facts : [];
        if (list.length === 0) return [{ type: "text", text: "还没有记录任何稳定事实。" }];
        return [{ type: "text", text: list.map((fact) => renderFactLine(fact)).join("\n") }];
      },
    },
    async execute(args) {
      init();
      const action = typeof args?.action === "string" ? args.action : "read";
      if (action === "assert") {
        const result = assertFacts(Array.isArray(args?.facts) ? args.facts : [], { source: "agent" });
        return { result, facts: activeFacts().slice(0, 40) };
      }
      if (action === "retract") {
        const id = typeof args?.id === "string" ? args.id : "";
        const removed = id !== "" ? store.retireFact(id, {}) : null;
        return { result: { puts: 0, retires: removed === null ? 0 : 1, touches: 0 }, facts: activeFacts().slice(0, 40) };
      }
      return { facts: activeFacts().slice(0, 60) };
    },
  }), "mnemosyne:tool-facts");

  // ── 面板 API ──────────────────────────────────────────────────────────────
  const json = (res, code, value) => {
    const body = JSON.stringify(value);
    res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(body);
  };

  const readBody = async (req, limitBytes = 512 * 1024) => {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > limitBytes) throw new Error("请求体过大");
      chunks.push(Buffer.from(chunk));
    }
    const raw = Buffer.concat(chunks).toString("utf8").trim();
    if (raw === "") return {};
    return JSON.parse(raw);
  };

  const summaryPayload = () => {
    init();
    const stats = store.stats();
    const entries = store.listEntries();
    // 来源分布：面板要显示"这些记忆分别来自哪里"
    const byOrigin = {};
    for (const entry of entries) {
      const origin = entry.origin ?? ORIGIN.LOCAL;
      byOrigin[origin] = (byOrigin[origin] ?? 0) + 1;
    }
    return {
      ok: true,
      stats: { ...stats, byOrigin },
      dir: root,
      profile: normalizeProfile(profile),
      persona: personaState,
      consolidate: consolidateState,
      compact: compactState,
      facts: activeFacts().map((fact) => ({ ...fact, line: renderFactLine(fact) })),
      pendingSummaries,
      recent: entries.slice(0, 30).map((entry) => ({
        id: entry.id,
        time: entry.t,
        kind: entry.kind,
        summary: entry.summary,
        keywords: entry.keywords.slice(0, 6),
        sessionTitle: entry.sessionTitle,
        source: entry.source,
        origin: entry.origin ?? ORIGIN.LOCAL,
        umo: entry.umo ?? "",
      })),
    };
  };

  ctx.effect(() => ctx.webServer.register({
    kind: "prefix",
    path: API_PREFIX,
    handler: async (req, res) => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        const sub = url.pathname.startsWith(API_PREFIX) ? url.pathname.slice(API_PREFIX.length) || "/" : "/";

        if (req.method === "GET" && (sub === "/summary" || sub === "/")) {
          return json(res, 200, summaryPayload());
        }

        if (req.method === "GET" && sub === "/entries") {
          init();
          const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 30));
          const kind = url.searchParams.get("kind") ?? "";
          // 面板可按来源筛选：all（默认）| local | qq
          const scope = url.searchParams.get("scope") ?? "";
          const entries = store.listEntries()
            .filter((entry) => kind === "" || entry.kind === kind)
            .filter((entry) => scope === "" || scope === "all" || (entry.origin ?? ORIGIN.LOCAL) === scope)
            .slice(0, limit);
          return json(res, 200, {
            ok: true,
            entries: entries.map((entry) => ({
              id: entry.id,
              time: entry.t,
              kind: entry.kind,
              summary: entry.summary,
              keywords: entry.keywords.slice(0, 6),
              entities: entry.entities.slice(0, 6),
              sessionTitle: entry.sessionTitle,
              source: entry.source,
              origin: entry.origin ?? ORIGIN.LOCAL,
              umo: entry.umo ?? "",
              umoLabel: describeUmo(entry.umo ?? ""),
              tags: entry.tags ?? [],
              user: clampText(entry.user, 400),
              assistant: clampText(entry.assistant, 400),
            })),
          });
        }

        if (req.method === "POST" && sub === "/search") {
          const body = await readBody(req);
          init();
          const query = typeof body.query === "string" ? body.query : "";
          const limit = Math.min(50, Math.max(1, Number(body.limit) || cfg.maxRecall));
          const scope = typeof body.scope === "string" ? body.scope : "";
          const originScope = scope === "qq" ? ORIGIN.QQ : scope === "local" ? ORIGIN.LOCAL : null;
          const result = recall.recall(query, { limit, originScope });
          return json(res, 200, {
            ok: true,
            total: result.all.length,
            hits: result.all.map(hitToJson),
          });
        }

        if (req.method === "POST" && sub === "/get") {
          const body = await readBody(req);
          init();
          const entry = store.getEntry(String(body.id ?? ""));
          if (entry === null) return json(res, 404, { ok: false, error: "记忆不存在" });
          return json(res, 200, { ok: true, entry });
        }

        if (req.method === "POST" && sub === "/profile") {
          const body = await readBody(req);
          init();
          profile = store.writeProfile(body.profile ?? {});
          injectionCache.clear();
          return json(res, 200, { ok: true, profile: normalizeProfile(profile) });
        }

        if (req.method === "POST" && sub === "/note") {
          const body = await readBody(req);
          init();
          const text = typeof body.text === "string" ? body.text.trim() : "";
          if (text === "") return json(res, 400, { ok: false, error: "内容不能为空" });
          const now = Date.now();
          const entry = {
            id: newEntryId(now),
            t: now,
            sessionId: "",
            sessionTitle: "",
            turn: 0,
            kind: typeof body.kind === "string" && body.kind !== "" ? body.kind : detectKind(text),
            user: clampText(text, 4000),
            assistant: "",
            summary: clampText(text, 160),
            keywords: topKeywords(text, 6),
            entities: extractEntities(text).slice(0, 10),
            tags: Array.isArray(body.tags) ? body.tags.filter((tag) => typeof tag === "string" && tag !== "").slice(0, 8) : [],
            source: "manual",
            createdAt: now,
            updatedAt: now,
          };
          putEntry(entry);
          return json(res, 200, { ok: true, entry });
        }

        if (req.method === "POST" && sub === "/delete") {
          const body = await readBody(req);
          init();
          const id = typeof body.id === "string" ? body.id : "";
          const removed = store.remove(id);
          if (removed) {
            recall.drop(id);
            injectionCache.clear();
          }
          return json(res, 200, { ok: true, removed });
        }

        if (req.method === "POST" && sub === "/backfill") {
          if (backfillState.running) return json(res, 409, { ok: false, error: "已经有一次导入在进行中" });
          const body = await readBody(req);
          init();
          const maxSessions = Math.min(500, Math.max(1, Number(body.maxSessions) || 60));
          const maxTurns = Math.min(200, Math.max(1, Number(body.maxTurns) || 30));
          // 已经导过的会话轮次不重复导入
          const existing = new Set();
          for (const entry of store.listEntries()) {
            if (typeof entry.sessionId === "string" && entry.sessionId !== "" && Number.isFinite(entry.turn) && entry.turn > 0) {
              existing.add(`${entry.sessionId}:${entry.turn}`);
            }
          }
          backfillState = { running: true, index: 0, total: 0, written: 0, skipped: 0, error: null, startedAt: Date.now(), finishedAt: 0 };
          void (async () => {
            try {
              const result = await runBackfill({
                sessionsRoot: [join(resolveDshHome(), "sessions")],
                existing,
                maxSessions,
                maxTurns,
                write: (entry) => putEntry(entry),
                onProgress: (progress) => {
                  backfillState = {
                    ...backfillState,
                    index: progress.index ?? backfillState.index,
                    total: progress.total ?? backfillState.total,
                    written: progress.written ?? backfillState.written,
                    skipped: progress.skipped ?? backfillState.skipped,
                  };
                },
              });
              injectionCache.clear();
              topicsIndex = null;
              backfillState = {
                ...backfillState,
                running: false,
                written: result.written,
                skipped: result.skipped,
                sessions: result.sessions,
                turns: result.turns,
                finishedAt: Date.now(),
              };
              logger.info?.(`mnemosyne: 历史回填完成，写入 ${result.written} 条（跳过 ${result.skipped}）`);
            } catch (error) {
              backfillState = {
                ...backfillState,
                running: false,
                error: error instanceof Error ? error.message : String(error),
                finishedAt: Date.now(),
              };
              logger.warn(`mnemosyne: 历史回填失败：${String(error)}`);
            }
          })();
          return json(res, 200, { ok: true, started: true, maxSessions, maxTurns });
        }

        if (req.method === "GET" && sub === "/backfill/status") {
          init();
          return json(res, 200, { ok: true, ...backfillState, count: store.stats().count });
        }

        if (req.method === "GET" && sub === "/topics") {
          init();
          const index = ensureTopics();
          const limit = Math.min(300, Math.max(1, Number(url.searchParams.get("limit")) || 40));
          return json(res, 200, {
            ok: true,
            total: index.topics.length,
            topics: index.topics.slice(0, limit).map((topic) => ({
              id: topic.id,
              t0: topic.t0,
              t1: topic.t1,
              count: topic.count,
              kind: topic.kind,
              title: topic.title,
              keywords: topic.keywords.slice(0, 4),
              entities: topic.entities.slice(0, 4),
              leadId: topic.leadId,
              sessionTitle: topic.sessionTitle,
            })),
          });
        }


        if (req.method === "GET" && sub === "/facts") {
          init();
          const includeRetired = url.searchParams.get("all") === "1";
          const list = includeRetired ? allFacts() : activeFacts();
          return json(res, 200, {
            ok: true,
            total: list.length,
            facts: list.slice(0, 200).map((fact) => ({ ...fact, line: renderFactLine(fact) })),
          });
        }

        if (req.method === "POST" && sub === "/facts") {
          const body = await readBody(req);
          init();
          if (body.action === "retract") {
            const removed = store.retireFact(String(body.id ?? ""), {});
            return json(res, 200, {
              ok: true,
              retires: removed === null ? 0 : 1,
              facts: activeFacts().slice(0, 200).map((fact) => ({ ...fact, line: renderFactLine(fact) })),
            });
          }
          const result = assertFacts(Array.isArray(body.facts) ? body.facts : [], { source: "manual" });
          return json(res, 200, {
            ok: true,
            ...result,
            facts: activeFacts().slice(0, 200).map((fact) => ({ ...fact, line: renderFactLine(fact) })),
          });
        }

        if (req.method === "POST" && sub === "/persona/probe") {
          // 诊断用：在 Host 内用与 summarize 完全相同的参数调一次模型，
          // 再逐步加上 persona 的差异（system 内容、payload 大小），定位哪一步被拒。
          init();
          const llm = ctx.get?.("llm");
          const route = resolveModelRoute();
          if (llm === null || llm === undefined || route === null) {
            return json(res, 200, { ok: false, error: "没有可用模型或路由" });
          }
          const entries = store.listEntries().slice(0, 60);
          const input = buildPersonaInput({ entries, facts: activeFacts() });
          const payload = JSON.stringify({ timeline: input.timeline, knownFacts: input.facts });
          const probes = [
            { name: "极简（只有 messages）", options: { messages: [{ role: "user", content: [{ type: "text", text: "说一个字：好" }] }] } },
            { name: "加 system（短）", options: { system: "你是助手。", messages: [{ role: "user", content: [{ type: "text", text: "说一个字：好" }] }] } },
            { name: "加 maxTokens 900", options: { system: "你是助手。", maxTokens: 900, messages: [{ role: "user", content: [{ type: "text", text: "说一个字：好" }] }] } },
            { name: "用 PERSONA_PROMPT", options: { system: PERSONA_PROMPT, maxTokens: 900, messages: [{ role: "user", content: [{ type: "text", text: "说一个字：好" }] }] } },
            { name: "真实 payload + 900", options: { system: PERSONA_PROMPT, maxTokens: 900, messages: [{ role: "user", content: [{ type: "text", text: payload }] }] } },
            { name: "真实 payload + 2400", options: { system: PERSONA_PROMPT, maxTokens: 2400, messages: [{ role: "user", content: [{ type: "text", text: payload }] }] } },
            { name: "真实 payload + 2400（再跑一次）", options: { system: PERSONA_PROMPT, maxTokens: 2400, messages: [{ role: "user", content: [{ type: "text", text: payload }] }] } },
          ];
          const results = [];
          for (const probe of probes) {
            const collected = { chunks: 0, text: "", finish: null, error: null };
            try {
              const controller = new AbortController();
              const timer = setTimeout(() => controller.abort(new Error("probe timeout")), 25000);
              try {
                for await (const chunk of llm.stream({ provider: route.provider, model: route.model, signal: controller.signal, ...probe.options })) {
                  if (chunk === null || chunk === undefined) continue;
                  collected.chunks += 1;
                  if (chunk.type === "text-delta" && typeof chunk.text === "string") collected.text += chunk.text;
                  if (chunk.type === "finish") {
                    collected.finish = chunk.reason?.kind ?? "?";
                    break;
                  }
                }
              } finally {
                clearTimeout(timer);
              }
            } catch (error) {
              collected.error = error instanceof Error ? error.message : String(error);
            }
            results.push({
              name: probe.name,
              chunks: collected.chunks,
              finish: collected.finish,
              textLen: collected.text.length,
              text: collected.text.slice(0, 60),
              error: collected.error,
            });
          }
          return json(res, 200, { ok: true, route, payloadChars: payload.length, results });
        }

        if (req.method === "POST" && sub === "/persona/rebuild") {
          init();
          const result = await rebuildPersona();
          return json(res, 200, {
            ok: result.ok === true,
            error: result.error ?? null,
            puts: result.puts ?? 0,
            retires: result.retires ?? 0,
            draft: result.draft ?? null,
            state: personaState,
            profile: normalizeProfile(profile),
            facts: activeFacts().map((fact) => ({ ...fact, line: renderFactLine(fact) })),
          });
        }

        if (req.method === "GET" && sub === "/persona/status") {
          init();
          return json(res, 200, {
            ok: true,
            ...personaState,
            autoPersona: cfg.autoPersona,
            personaEvery: cfg.personaEvery,
          });
        }

        if (req.method === "POST" && sub === "/compact") {
          init();
          const result = runCompaction();
          return json(res, 200, { ...result, state: compactState, stats: store.stats() });
        }

        if (req.method === "POST" && sub === "/consolidate") {
          const body = await readBody(req);
          init();
          const result = await runConsolidation({
            dryRun: body.dryRun === true,
            minAgeDays: Number.isFinite(Number(body.minAgeDays)) ? Number(body.minAgeDays) : undefined,
            minTurns: Number.isFinite(Number(body.minTurns)) ? Number(body.minTurns) : undefined,
            dedupeThreshold: Number.isFinite(Number(body.dedupeThreshold)) ? Number(body.dedupeThreshold) : undefined,
          });
          return json(res, 200, { ...result, state: consolidateState, stats: store.stats() });
        }

        if (req.method === "GET" && sub === "/consolidate/status") {
          init();
          return json(res, 200, {
            ok: true,
            ...consolidateState,
            autoConsolidate: cfg.autoConsolidate,
            consolidateMinAgeDays: cfg.consolidateMinAgeDays,
          });
        }

        if (req.method === "POST" && sub === "/preview") {
          const body = await readBody(req);
          init();
          const query = typeof body.query === "string" ? body.query : "";
          const result = recall.recall(query, { limit: cfg.maxRecall });
          const text = renderInjection({
            profile,
            recall: result,
            topics: ensureTopics(),
            facts: activeFacts(),
            recent: store.listEntries().slice(0, 5),
            maxChars: cfg.maxInjectChars,
          });
          return json(res, 200, { ok: true, text, chars: text.length });
        }

        return json(res, 404, { ok: false, error: `未知接口：${req.method} ${sub}` });
      } catch (error) {
        logger.warn(`mnemosyne: API 异常 ${req.method} ${req.url}：${String(error)}`);
        return json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    },
  }), "mnemosyne:http-api");

  // 定时固化（合并重复 / 生成摘要 / 归档低价值旧条目）
  scheduleConsolidation();

  logger.info?.(`mnemosyne: 已挂载（数据目录 ${root}）`);
}
