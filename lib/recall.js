/**
 * 记忆索引与召回。
 *
 * 设计目标（对应需求）：
 *  1. 多维索引：内容（分词倒排）、对象（实体）、时间、事件类型、会话。
 *  2. 索引只回「卡片」（时间/类型/摘要/关键词），全文留在库里按需展开。
 *  3. 召回时做「思考延伸」：主命中之外，自动带出同会话相邻、共享对象、
 *     同期同类的条目，尽量一次给全用户可能需要的上下文。
 */
import { clampText, extractEntities, kindLabel, tokenize, tokenWeight, detectKind, traceToArrow } from "./text.js";

const KIND_WEIGHT = {
  identity: 1.25,
  decision: 1.2,
  event: 1.1,
  task: 1.05,
  knowledge: 1.0,
  emotion: 0.95,
  chat: 0.85,
};

/** 相对/绝对时间词 → 时间窗口。 */
export function parseTimeHint(text) {
  if (typeof text !== "string" || text.length === 0) return null;
  const now = Date.now();
  const day = 86400000;
  const rules = [
    [/昨天|昨日/, 1, 2],
    [/前天/, 2, 3],
    [/今天|今日|刚才|刚刚/, 0, 1],
    [/上周|上个星期|上星期/, 7, 14],
    [/这周|本周|这星期/, 0, 7],
    [/上个月|上月/, 30, 60],
    [/这个月|本月/, 0, 31],
    [/去年/, 365, 730],
    [/今年/, 0, 365],
    [/最近|这几天|近期/, 0, 7],
  ];
  for (const [re, fromDays, toDays] of rules) {
    if (re.test(text)) return { from: now - toDays * day, to: now - fromDays * day + day, label: re.source };
  }
  const exact = text.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (exact !== null) {
    const start = new Date(Number(exact[1]), Number(exact[2]) - 1, Number(exact[3])).getTime();
    if (Number.isFinite(start)) return { from: start, to: start + day, label: exact[0] };
  }
  return null;
}

/** 归一化条目：补齐 keywords/entities/kind，容忍旧数据。 */
export function normalizeEntry(entry) {
  if (entry === null || typeof entry !== "object") return null;
  const user = typeof entry.user === "string" ? entry.user : "";
  const assistant = typeof entry.assistant === "string" ? entry.assistant : "";
  const summary = typeof entry.summary === "string" ? entry.summary : "";
  const haystack = [summary, user, assistant].filter(Boolean).join("\n");
  const keywords = Array.isArray(entry.keywords) && entry.keywords.length > 0
    ? entry.keywords.filter((k) => typeof k === "string").slice(0, 24)
    : [];
  const entities = Array.isArray(entry.entities) && entry.entities.length > 0
    ? entry.entities.filter((e) => typeof e === "string").slice(0, 32)
    : extractEntities(haystack).slice(0, 32);
  const kind = typeof entry.kind === "string" && entry.kind !== "" ? entry.kind : detectKind(haystack);
  return {
    ...entry,
    id: String(entry.id),
    t: Number.isFinite(entry.t) ? Number(entry.t) : Date.now(),
    kind,
    user,
    assistant,
    summary,
    keywords,
    entities,
    sessionId: typeof entry.sessionId === "string" ? entry.sessionId : "",
    sessionTitle: typeof entry.sessionTitle === "string" ? entry.sessionTitle : "",
    tags: Array.isArray(entry.tags) ? entry.tags.filter((tag) => typeof tag === "string").slice(0, 12) : [],
    hits: Number.isFinite(entry.hits) ? Number(entry.hits) : 0,
    pinned: entry.pinned === true,
  };
}

/**
 * 创建索引与检索器。
 * @param {{maxRecall?: number}} [options]
 */
export function createRecall(options = {}) {
  const maxRecall = Number.isFinite(options.maxRecall) ? Math.max(1, Number(options.maxRecall)) : 8;

  /** id → 归一化条目 */
  const byId = new Map();
  /** token → Map<id, weight> */
  const postings = new Map();
  /** entity → Set<id> */
  const entityIndex = new Map();
  /** kind → Set<id> */
  const kindIndex = new Map();
  /** sessionId → Set<id> */
  const sessionIndex = new Map();
  /** 构建时的语料规模，用于 idf */
  let docCount = 0;
  /** 本轮被召回过的条目 id，等调用方批量回写 hits（记忆强度）。 */
  const touched = new Set();

  const noteHit = (id) => {
    const entry = byId.get(id);
    if (entry === undefined) return;
    entry.hits = (entry.hits ?? 0) + 1;
    touched.add(id);
  };

  /** 取出并清空本轮累计的召回计数，供宿主回写磁盘。 */
  const drainHits = () => {
    const list = [...touched].map((id) => byId.get(id)).filter((entry) => entry !== undefined);
    touched.clear();
    return list;
  };

  const bump = (map, key, id) => {
    let set = map.get(key);
    if (set === undefined) {
      set = new Set();
      map.set(key, set);
    }
    set.add(id);
  };

  const indexEntry = (entry) => {
    const fields = [
      [entry.summary, 1.0],
      [entry.keywords.join(" "), 1.3],
      [entry.entities.join(" "), 1.6],
      [entry.sessionTitle, 0.8],
      [entry.user, 0.9],
      [entry.assistant, 0.55],
    ];
    const tf = new Map();
    for (const [text, fieldWeight] of fields) {
      if (typeof text !== "string" || text === "") continue;
      for (const token of tokenize(text)) {
        tf.set(token, (tf.get(token) ?? 0) + fieldWeight);
      }
    }
    for (const [token, weight] of tf) {
      let posting = postings.get(token);
      if (posting === undefined) {
        posting = new Map();
        postings.set(token, posting);
      }
      posting.set(entry.id, weight * tokenWeight(token));
    }
    for (const entity of entry.entities) bump(entityIndex, entity.toLowerCase(), entry.id);
    for (const keyword of entry.keywords) bump(entityIndex, keyword.toLowerCase(), entry.id);
    bump(kindIndex, entry.kind, entry.id);
    if (entry.sessionId !== "") bump(sessionIndex, entry.sessionId, entry.id);
  };

  const unindexEntry = (id) => {
    for (const posting of postings.values()) posting.delete(id);
    for (const set of entityIndex.values()) set.delete(id);
    for (const set of kindIndex.values()) set.delete(id);
    for (const set of sessionIndex.values()) set.delete(id);
  };

  const add = (rawEntry) => {
    const entry = normalizeEntry(rawEntry);
    if (entry === null) return null;
    if (byId.has(entry.id)) unindexEntry(entry.id);
    else docCount += 1;
    byId.set(entry.id, entry);
    indexEntry(entry);
    return entry;
  };

  const drop = (id) => {
    if (!byId.has(id)) return false;
    unindexEntry(id);
    byId.delete(id);
    docCount = Math.max(0, docCount - 1);
    return true;
  };

  const rebuild = (list) => {
    byId.clear();
    postings.clear();
    entityIndex.clear();
    kindIndex.clear();
    sessionIndex.clear();
    docCount = 0;
    for (const entry of list) add(entry);
    return byId.size;
  };

  const idf = (token) => {
    const df = postings.get(token)?.size ?? 0;
    return Math.log((docCount + 1) / (df + 0.5)) + 0.5;
  };

  /** 时间新鲜度：30 天内接近 1，一年后约 0.55，三年后约 0.4。 */
  const freshness = (t, now) => {
    const days = Math.max(0, (now - t) / 86400000);
    return 0.4 + 0.6 * Math.exp(-days / 220);
  };

  /**
   * 检索主命中。
   * @param {string} queryText
   * @param {{limit?: number, now?: number, kind?: string, originScope?: string|null}} [opts]
   *   originScope 为 'qq' 时只召回 QQ 桥接进来的记忆（单向隔离：群里看不到 DSH 网页里的对话）；
   *   为 null / undefined 时不限来源（DSH 侧默认如此，所以能翻到群里说过什么）。
   */
  const search = (queryText, opts = {}) => {
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const limit = Number.isFinite(opts.limit) ? Math.max(1, opts.limit) : maxRecall;
    const text = typeof queryText === "string" ? queryText : "";
    if (byId.size === 0) return { hits: [], queryTokens: [], timeHint: null };

    const timeHint = parseTimeHint(text);
    // test / archived 等标签的条目默认不参与自动召回（手动搜索仍可见）
    const skipTags = Array.isArray(opts.skipTags) ? opts.skipTags : ["test", "archived"];
    const originScope = typeof opts.originScope === "string" && opts.originScope !== "" ? opts.originScope : null;
    const hidden = (entry) => entry.tags.some((tag) => skipTags.includes(tag));
    // 来源过滤：未标 origin 的老数据按 local 处理，这样隔离对存量数据也成立
    const inScope = (entry) => originScope === null || (entry.origin ?? "local") === originScope;
    const visible = (entry) => !hidden(entry) && inScope(entry);
    const rawTokens = [...new Set(tokenize(text))];
    if (rawTokens.length === 0 && timeHint === null) {
      // 无有效检索词：退回最近若干条
      const recent = [...byId.values()]
        .filter(visible)
        .sort((a, b) => b.t - a.t)
        .slice(0, limit);
      return {
        hits: recent.map((entry) => ({ entry, score: 0.1, reasons: ["最近记录"] })),
        queryTokens: [],
        timeHint,
      };
    }
    const tokens = rawTokens
      .map((token) => ({ token, weight: tokenWeight(token) * idf(token) }))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 64);

    const scores = new Map();
    const matchedTokens = new Map();
    for (const { token, weight } of tokens) {
      const posting = postings.get(token);
      if (posting === undefined) continue;
      for (const [id, tfWeight] of posting) {
        scores.set(id, (scores.get(id) ?? 0) + tfWeight * weight);
        const list = matchedTokens.get(id);
        if (list === undefined) matchedTokens.set(id, [token]);
        else if (list.length < 6) list.push(token);
      }
    }

    // 实体命中：整体出现在查询里的实体给强加权
    const lowered = text.toLowerCase();
    for (const [entity, ids] of entityIndex) {
      if (entity.length < 2 || !lowered.includes(entity)) continue;
      for (const id of ids) {
        scores.set(id, (scores.get(id) ?? 0) + 3.2 * Math.min(3, entity.length / 6));
      }
    }

    const hits = [];
    for (const [id, base] of scores) {
      const entry = byId.get(id);
      if (entry === undefined) continue;
      if (!visible(entry)) continue;
      if (typeof opts.kind === "string" && opts.kind !== "" && entry.kind !== opts.kind) continue;
      let score = base * freshness(entry.t, now) * (KIND_WEIGHT[entry.kind] ?? 1);
      // 摘要条目代表一整段对话：同样命中一次，信息量远大于单轮，给固定加成
      if (entry.source === "digest") score *= 1.3;
      // 记忆强度：被反复召回说明重要，给一点对数加成（不会盖过内容相关性）
      if (entry.pinned) score *= 1.35;
      score *= 1 + Math.log(1 + Math.max(0, entry.hits ?? 0)) * 0.12;
      if (timeHint !== null && entry.t >= timeHint.from && entry.t <= timeHint.to) score *= 1.35;
      hits.push({
        entry,
        score,
        reasons: [`关键词：${(matchedTokens.get(id) ?? []).join("、")}`],
      });
    }
    hits.sort((a, b) => b.score - a.score);
    return { hits, queryTokens: rawTokens, timeHint };
  };

  /**
   * 思考延伸：把主命中周边「很可能相关」的条目一并带出。
   * @param {Array<{entry: object, score: number, reasons: string[]}>} primary
   * @param {{now?: number, timeHint?: object|null, maxExpand?: number}} [opts]
   */
  const expand = (primary, opts = {}) => {
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const maxExpand = Number.isFinite(opts.maxExpand) ? opts.maxExpand : maxRecall * 2;
    const seen = new Set(primary.map((hit) => hit.entry.id));
    const extra = [];

    const push = (entry, score, reason) => {
      if (entry === undefined || entry === null) return;
      if (seen.has(entry.id)) return;
      seen.add(entry.id);
      extra.push({ entry, score, reasons: [reason] });
    };

    for (const hit of primary) {
      const entry = hit.entry;

      // 1) 同会话相邻上下文（前后各一条）
      if (entry.sessionId !== "") {
        const siblings = [...(sessionIndex.get(entry.sessionId) ?? [])]
          .map((id) => byId.get(id))
          .filter((e) => e !== undefined && e.id !== entry.id)
          .sort((a, b) => Math.abs(a.t - entry.t) - Math.abs(b.t - entry.t));
        for (const sibling of siblings.slice(0, 2)) {
          push(sibling, hit.score * 0.42, `↳同会话${sibling.kind === entry.kind ? "" : `·${kindLabel(sibling.kind)}`}`);
        }
      }

      // 2) 共享对象（取前两个实体）
      for (const entity of entry.entities.slice(0, 2)) {
        const ids = entityIndex.get(entity.toLowerCase());
        if (ids === undefined) continue;
        const related = [...ids]
          .map((id) => byId.get(id))
          .filter((e) => e !== undefined && e.id !== entry.id)
          .sort((a, b) => b.t - a.t)
          .slice(0, 2);
        for (const relatedEntry of related) {
          push(relatedEntry, hit.score * 0.5, `↳共享:${clampText(entity, 16)}`);
        }
      }

      // 3) 同期同类（时间接近 7 天内的同 kind）
      const kindIds = kindIndex.get(entry.kind);
      if (kindIds !== undefined && hit.score > 0) {
        const near = [...kindIds]
          .map((id) => byId.get(id))
          .filter((e) => e !== undefined && Math.abs(e.t - entry.t) <= 7 * 86400000)
          .sort((a, b) => Math.abs(a.t - entry.t) - Math.abs(b.t - entry.t))
          .slice(0, 1);
        for (const nearEntry of near) {
          push(nearEntry, hit.score * 0.3, `↳同期同类·${kindLabel(entry.kind)}`);
        }
      }
    }

    let kept = extra;
    if (opts.timeHint !== null && opts.timeHint !== undefined) {
      const inWindow = extra.filter((hit) => hit.entry.t >= opts.timeHint.from && hit.entry.t <= opts.timeHint.to);
      kept = inWindow.length >= 2 ? inWindow : extra;
    }
    kept.sort((a, b) => b.score - a.score);
    return kept.slice(0, maxExpand);
  };

  /** 完整召回：主命中 + 延伸，去重并按分数排序。 */
  const recall = (queryText, opts = {}) => {
    const limit = Number.isFinite(opts.limit) ? Math.max(1, opts.limit) : maxRecall;
    const skipTags = Array.isArray(opts.skipTags) ? opts.skipTags : ["test", "archived"];
    // 延伸命中也必须过来源过滤，否则 QQ 会话能通过"顺带想起"漏看到 DSH 的记忆
    const originScope = typeof opts.originScope === "string" && opts.originScope !== "" ? opts.originScope : null;
    const allowed = (hit) => {
      if ((hit.entry.tags ?? []).some((tag) => skipTags.includes(tag))) return false;
      return originScope === null || (hit.entry.origin ?? "local") === originScope;
    };
    const { hits, queryTokens, timeHint } = search(queryText, { ...opts, limit });
    const primary = hits.filter(allowed).slice(0, limit);
    const extra = expand(primary, { now: opts.now, timeHint, maxExpand: limit * 2 }).filter(allowed);
    for (const hit of primary) noteHit(hit.entry.id);
    for (const hit of extra) noteHit(hit.entry.id);
    return {
      primary,
      extra,
      all: [...primary, ...extra],
      queryTokens,
      timeHint,
    };
  };

  const sessionEntries = (sessionId) =>
    [...(sessionIndex.get(sessionId) ?? [])]
      .map((id) => byId.get(id))
      .filter((entry) => entry !== undefined)
      .sort((a, b) => a.t - b.t);

  const get = (id) => byId.get(id) ?? null;

  const size = () => byId.size;

  return { add, drop, rebuild, search, expand, recall, get, size, sessionEntries, idf, drainHits };
}

/** 一行索引卡片（给上下文注入用，只含定位信息，不含全文）。 */
export function renderCard(hit, index) {
  const entry = hit.entry;
  const d = new Date(entry.t);
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const summary = traceToArrow(entry.summary !== "" ? entry.summary : clampText(entry.user, 120));
  const keywords = entry.keywords.slice(0, 3).join("/");
  // 只保留延伸召回的短标签（同会话/共享对象/同期同类），主命中的内部匹配细节不展示
  const reason = (hit.reasons ?? []).filter((r) => r.startsWith("↳")).slice(0, 1).join("");
  const topic = entry.sessionTitle !== "" ? ` · ${clampText(entry.sessionTitle, 16)}` : "";
  const parts = [
    `${index + 1}. ${stamp} · ${kindLabel(entry.kind)}${topic} — ${clampText(summary, 140)}`,
    keywords,
    entry.id,
    reason,
  ].filter((part) => part !== "");
  return `${parts.slice(0, 1).join("")} ｜ ${parts.slice(1).join(" ｜ ")}`;
}

/** 固定顺序的时间线卡片（无查询时的最近记忆）。 */
export function renderTimeline(entries, limit = 6) {
  return entries.slice(0, limit).map((entry, i) => {
    const d = new Date(entry.t);
    const pad = (n) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const summary = entry.summary !== "" ? entry.summary : clampText(entry.user, 90);
    return `${i + 1}. [${stamp}·${kindLabel(entry.kind)}] ${clampText(summary, 130)} ｜ id=${entry.id}`;
  });
}
