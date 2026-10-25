/**
 * 记忆固化（consolidation）：让库随时间变"密"，而不是变"吵"。
 *
 * 朴素地一直追加有两个后果：
 *  1. 同一件事反复说，索引里堆满近似条目，互相稀释；
 *  2. 几个月前的琐碎轮次和昨天的关键决定同权竞争。
 *
 * 固化做三件事，全部**可逆**（只打标签、只新增，从不删除原文）：
 *
 *  合并  —— 同话题内摘要高度相似的条目并成一条（保留信息最全的那条）
 *  归档  —— 又旧又没被召回过的低价值条目打 archived 标签，退出自动召回
 *  摘要  —— 足够大的旧话题压成一条 digest，细节留在原文里按需展开
 *
 * 阈值一律取保守值：误合并会丢信息，误归档只是少召回一条，
 * 后者可恢复，前者不可逆 —— 宁可漏。
 */
import { clampText, kindLabel, tokenize, traceToArrow } from "./text.js";

const DAY = 24 * 60 * 60 * 1000;

/** 条目用于比较的 token 集合（摘要为主，关键词补充权重）。 */
export function tokenSet(entry) {
  const text = `${entry.summary ?? ""} ${(entry.keywords ?? []).slice(0, 6).join(" ")}`;
  return new Set(tokenize(text));
}

/** 两个条目文本的 Jaccard 相似度。 */
export function similarity(setA, setB) {
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const token of setA) {
    if (setB.has(token)) shared += 1;
  }
  return shared / (setA.size + setB.size - shared);
}

/**
 * 找出同话题内的近似重复组。
 * @param {Array} entries
 * @param {{threshold?: number, byEntryId?: Map}} [options]
 * @returns {Array<{key: string, keepId: string, dropIds: string[]}>}
 */
export function findDuplicateGroups(entries, options = {}) {
  const threshold = Number.isFinite(options.threshold) ? options.threshold : 0.82;
  const byEntryId = options.byEntryId ?? null;

  // 只在同话题内比较：跨话题合并风险高，收益低
  const buckets = new Map();
  for (const entry of entries) {
    if (entry === null || entry === undefined) continue;
    if ((entry.tags ?? []).includes("archived")) continue;
    if ((entry.tags ?? []).includes("digest")) continue;
    const key = byEntryId?.get(entry.id) ?? `s:${entry.sessionId || entry.id}`;
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [entry]);
    else bucket.push(entry);
  }

  const groups = [];
  for (const [key, bucket] of buckets) {
    if (bucket.length < 2) continue;
    const sets = bucket.map((entry) => tokenSet(entry));
    const parent = bucket.map((_, index) => index);
    const find = (index) => {
      let root = index;
      while (parent[root] !== root) root = parent[root];
      let cursor = index;
      while (parent[cursor] !== root) {
        const next = parent[cursor];
        parent[cursor] = root;
        cursor = next;
      }
      return root;
    };
    const union = (a, b) => {
      const rootA = find(a);
      const rootB = find(b);
      if (rootA !== rootB) parent[rootB] = rootA;
    };

    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) {
        if (similarity(sets[i], sets[j]) >= threshold) union(i, j);
      }
    }

    const clusters = new Map();
    for (let i = 0; i < bucket.length; i += 1) {
      const root = find(i);
      const list = clusters.get(root);
      if (list === undefined) clusters.set(root, [bucket[i]]);
      else list.push(bucket[i]);
    }
    for (const list of clusters.values()) {
      if (list.length < 2) continue;
      // 保留信息最全的那条（摘要最长），其余标记为并入
      const sorted = list.slice().sort((a, b) => (b.summary?.length ?? 0) - (a.summary?.length ?? 0));
      groups.push({ key, keepId: sorted[0].id, dropIds: sorted.slice(1).map((entry) => entry.id) });
    }
  }
  return groups;
}

/**
 * 挑出可以归档的低价值旧条目。
 * 判据全部要同时满足：够旧、从没被召回、不是决策/身份类、不在 digest 里。
 * @param {Array} entries
 * @param {{now?: number, minAgeDays?: number, keepKinds?: string[]}} [options]
 */
export function pickArchiveCandidates(entries, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const minAgeDays = Number.isFinite(options.minAgeDays) ? options.minAgeDays : 30;
  const keepKinds = new Set(options.keepKinds ?? ["decision", "identity", "task"]);
  const cutoff = now - minAgeDays * DAY;
  return entries
    .filter((entry) => {
      if (entry === null || entry === undefined) return false;
      const tags = entry.tags ?? [];
      if (tags.includes("archived") || tags.includes("digest") || tags.includes("backfill")) return false;
      if (entry.pinned === true) return false;
      if (Number(entry.t) > cutoff) return false;
      if ((entry.hits ?? 0) > 0) return false;
      if (keepKinds.has(entry.kind)) return false;
      return true;
    })
    .map((entry) => entry.id);
}

/** 一个话题够不够格压成 digest：够大、够旧、够有价值。 */
export function isDigestCandidate(topic, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const minTurns = Number.isFinite(options.minTurns) ? options.minTurns : 5;
  const minAgeDays = Number.isFinite(options.minAgeDays) ? options.minAgeDays : 7;
  if (topic === null || topic === undefined) return false;
  if (topic.count < minTurns) return false;
  if (topic.t1 > now - minAgeDays * DAY) return false;
  return true;
}

/**
 * 要点是否有信息量：去掉标点、数字、空白后还剩多少字。
 * 「1 → 理解」「好的」这类不能进摘要 —— 摘要是给未来的自己看的，不是聊天记录。
 */
function isMeaningful(text) {
  const stripped = String(text).replace(/[\s\p{P}\p{N}]/gu, "");
  return stripped.length >= 6;
}

/** 从话题成员里挑出要点（用于 digest 摘要）。 */
export function digestPoints(members, limit = 4) {
  const scored = members.map((entry) => {
    let score = 0;
    if (entry.kind === "decision") score += 3;
    if (entry.kind === "task") score += 2;
    if (entry.kind === "event") score += 1;
    score += Math.min(2, Number(entry.hits ?? 0));
    return { entry, score };
  });
  scored.sort((a, b) => b.score - a.score || Number(a.entry.t) - Number(b.entry.t));
  const picked = [];
  const seen = new Set();
  for (const item of scored) {
    // 「用户：A｜回应：B」压成「A → B」，再剥掉空壳要点
    const raw = traceToArrow(item.entry.summary || item.entry.user || "");
    const text = clampText(raw, 60);
    if (text === "" || !isMeaningful(text)) continue;
    const fingerprint = text.slice(0, 24);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    picked.push(text);
    if (picked.length >= limit) break;
  }
  return picked;
}

/**
 * 生成一条话题摘要（digest）草稿。
 * @param {object} topic buildTopics 产出的话题
 * @param {Array} members 话题内的条目
 * @param {number} now
 */
export function buildDigest(topic, members, now = Date.now()) {
  const pad = (n) => String(n).padStart(2, "0");
  const d0 = new Date(topic.t0);
  const d1 = new Date(topic.t1);
  const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const points = digestPoints(members);
  const span = stamp(d0) === stamp(d1) ? stamp(d0) : `${stamp(d0)}~${stamp(d1)}`;
  const summary = clampText(
    `${topic.title}（${span} · ${topic.count}轮 · ${kindLabel(topic.kind)}）：${points.join("；")}`,
    240,
  );
  return {
    t: topic.t1,
    sessionId: topic.sessionId,
    sessionTitle: topic.sessionTitle,
    turn: 0,
    kind: topic.kind,
    user: "",
    assistant: "",
    summary,
    keywords: topic.keywords.slice(0, 6),
    entities: topic.entities.slice(0, 6),
    tags: ["digest"],
    source: "digest",
    digestOf: topic.entryIds.slice(0, 60),
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 一次性算出完整的固化计划（纯函数，不落盘）。
 * @param {object} params
 * @param {Array} params.entries 全部条目
 * @param {{ topics: Array, byEntryId: Map, list: Map }} params.topics
 * @param {number} [params.now]
 * @param {object} [params.options] { dedupeThreshold, minAgeDays, minTurns, dryRun }
 * @returns {{ groups: Array, digests: Array, archived: string[], merged: Array }}
 */
export function planConsolidation({ entries, topics, now = Date.now(), options = {} }) {
  const byEntryId = topics?.byEntryId ?? null;
  // 归档比摘要保守得多：归档要求"又旧又没人用"，摘要只要求"这段对话已经结束了"
  const archiveAge = Number.isFinite(options.archiveMinAgeDays)
    ? options.archiveMinAgeDays
    : Number.isFinite(options.minAgeDays)
      ? options.minAgeDays
      : 30;
  const digestAge = Number.isFinite(options.digestMinAgeDays) ? options.digestMinAgeDays : 3;
  const minTurns = Number.isFinite(options.minTurns) ? options.minTurns : 5;

  const groups = findDuplicateGroups(entries, { threshold: options.dedupeThreshold ?? 0.82, byEntryId });

  const archived = pickArchiveCandidates(entries, { now, minAgeDays: archiveAge });

  const digestCandidates = [];
  for (const topic of topics?.topics ?? []) {
    if (!isDigestCandidate(topic, { now, minTurns, minAgeDays: digestAge })) continue;
    const members = topic.entryIds
      .map((id) => entries.find((entry) => entry.id === id))
      .filter((entry) => entry !== undefined && entry !== null);
    if (members.length < minTurns) continue;
    digestCandidates.push({ topic, members });
  }

  // 已经固化过的话题（存在指向它的 digest）不重复生成
  const digested = new Set();
  for (const entry of entries) {
    if (entry.source === "digest" && Array.isArray(entry.digestOf)) {
      for (const id of entry.digestOf) digested.add(id);
    }
  }
  const digests = digestCandidates
    .filter(({ topic }) => !topic.entryIds.some((id) => digested.has(id)))
    .map(({ topic, members }) => ({
      topic,
      draft: buildDigest(topic, members, now),
      archiveIds: topic.entryIds.filter((id) => !digested.has(id)),
    }));

  return {
    groups,
    digests,
    archived,
    stats: {
      duplicates: groups.reduce((sum, group) => sum + group.dropIds.length, 0),
      digests: digests.length,
      archived: archived.length,
    },
  };
}
