/**
 * 主题聚合：把「每轮一条流水」聚成「一个话题」。
 *
 * 记忆的检索单位不该是「某一轮说了什么」，而是「这件事的来龙去脉」。
 * 聚到话题层后，一次注入只占一行，而不是同一件事铺开五张卡。
 *
 * 聚类规则（可预测、无模型依赖）：
 *  1. 同一会话内按时间排序，相邻间隔超过 gapMs 就切成新话题；
 *  2. 话题至少 1 条，多轮话题保留首尾时间；
 *  3. 话题的标题取成员关键词并集里最具体的几个，避免纯数字/碎片。
 *
 * 跨会话合并故意不做：误合并会把两件不相干的事糊在一起，
 * 比"分成两个话题"更难纠正。
 */
import { clampText, kindLabel, traceToArrow } from "./text.js";

const DEFAULT_GAP_MS = 2 * 60 * 60 * 1000; // 2 小时

/** 关键词并集按出现次数排序，取最具体的几个。 */
function mergeTop(entries, field, limit) {
  const counts = new Map();
  for (const entry of entries) {
    for (const value of entry[field] ?? []) {
      const key = String(value).trim();
      if (key.length < 2) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => {
      const weight = (token) => (token.length >= 3 ? 1.3 : 1) * (token.length >= 4 ? 1.1 : 1);
      return b[1] * weight(b[0]) - a[1] * weight(a[0]);
    })
    .slice(0, limit)
    .map(([value]) => value);
}

/** 众数事件类型（话题整体属于什么性质）。 */
function dominantKind(entries) {
  const counts = new Map();
  for (const entry of entries) counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1);
  let best = "chat";
  let bestCount = -1;
  for (const [kind, count] of counts) {
    if (count > bestCount) {
      best = kind;
      bestCount = count;
    }
  }
  return best;
}

/** 话题标题用词的挑选：实体比关键词更像"东西"，但路径/纯数字不适合当标题。 */
function pickTitleWords(entities, keywords) {
  const usableEntities = entities.filter(
    (entity) => !/[\\/\s]/.test(entity) && entity.length >= 2 && entity.length <= 14 && !/^\d+$/.test(entity),
  );
  if (usableEntities.length > 0) return usableEntities.slice(0, 2);
  return keywords.slice(0, 3);
}

/** 话题标题：优先实体，其次关键词，最后退回首条摘要。 */
function topicTitle(entries, entities, keywords) {
  const words = pickTitleWords(entities, keywords);
  if (words.length > 0) return words.join(" / ");
  const first = entries[0];
  return clampText(first.summary || first.user || "未命名话题", 24);
}

/**
 * 构建话题索引。
 * @param {Array} entries 归一化后的记忆条目（任意顺序）
 * @param {{gapMs?: number}} [options]
 * @returns {{ topics: Array, byEntryId: Map<string, string>, list: Map<string, object> }}
 */
export function buildTopics(entries, options = {}) {
  const gapMs = Number.isFinite(options.gapMs) ? Number(options.gapMs) : DEFAULT_GAP_MS;
  const list = entries.filter((entry) => entry !== null && entry !== undefined);

  // 按会话分桶；无会话的手动记忆各自成话题
  const buckets = new Map();
  for (const entry of list) {
    const key = entry.sessionId !== "" ? `s:${entry.sessionId}` : `m:${entry.id}`;
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = [];
      buckets.set(key, bucket);
    }
    bucket.push(entry);
  }

  const topics = [];
  const byEntryId = new Map();

  for (const [key, bucket] of buckets) {
    bucket.sort((a, b) => a.t - b.t);
    let segment = [];
    let lastT = 0;
    const flush = () => {
      if (segment.length === 0) return;
      const members = segment;
      segment = [];
      const id = `tp-${members[0].id}`;
      const keywords = mergeTop(members, "keywords", 6);
      const entities = mergeTop(members, "entities", 6);
      const kind = dominantKind(members);
      const t0 = members[0].t;
      const t1 = members[members.length - 1].t;
      const topic = {
        id,
        key,
        t0,
        t1,
        count: members.length,
        kind,
        title: topicTitle(members, entities, keywords),
        keywords,
        entities,
        sessionId: members[0].sessionId,
        sessionTitle: members[0].sessionTitle,
        entryIds: members.map((entry) => entry.id),
        // 代表条目：取摘要最长那条，作为「原文入口」
        leadId: members.slice().sort((a, b) => (b.summary?.length ?? 0) - (a.summary?.length ?? 0))[0].id,
      };
      topics.push(topic);
      for (const entry of members) byEntryId.set(entry.id, id);
    };

    for (const entry of bucket) {
      if (segment.length > 0 && entry.t - lastT > gapMs) flush();
      segment.push(entry);
      lastT = entry.t;
    }
    flush();
  }

  topics.sort((a, b) => b.t1 - a.t1);
  const byId = new Map(topics.map((topic) => [topic.id, topic]));
  return { topics, byEntryId, list: byId };
}

/** 话题卡片（注入用：一行说清一件事）。 */
export function renderTopicCard(topic, index, hits = []) {
  const d0 = new Date(topic.t0);
  const d1 = new Date(topic.t1);
  const pad = (n) => String(n).padStart(2, "0");
  const day0 = `${d0.getFullYear()}-${pad(d0.getMonth() + 1)}-${pad(d0.getDate())}`;
  const time0 = `${pad(d0.getHours())}:${pad(d0.getMinutes())}`;
  const sameDay = day0 === `${d1.getFullYear()}-${pad(d1.getMonth() + 1)}-${pad(d1.getDate())}`;
  const time1 = sameDay ? `${pad(d1.getHours())}:${pad(d1.getMinutes())}` : "…";
  const hitCount = hits.length;
  const hitNote = hitCount > 0 && hitCount < topic.count ? `（命中${hitCount}）` : "";
  const span = topic.count > 1 ? `${day0} ${time0}~${time1} · ${topic.count}轮${hitNote}` : `${day0} ${time0}`;
  // 话题里被命中的具体要点（最多两条），让模型知道是哪一轮对上了
  const highlights = hits
    .slice(0, 2)
    .map((hit) => clampText(traceToArrow(hit.entry.summary || hit.entry.user), 50))
    .filter((text) => text !== "");
  const parts = [
    `${index + 1}. ${span} · ${kindLabel(topic.kind)} — ${clampText(topic.title, 40)}`,
    `id=${topic.leadId}`,
  ];
  const head = parts[0];
  const tail = parts.slice(1).join(" ｜ ");
  const detail = highlights.length > 0 && topic.count > 1 ? `（含：${highlights.join("；")}）` : "";
  return `${head} ｜ ${tail}${detail}`;
}
