/**
 * 记忆总结层：优先用当前模型把一轮对话压成「摘要 + 关键词 + 实体 + 类型 + 人设线索」，
 * 模型不可用或超时则降级为规则摘要，保证记忆从不丢空。
 *
 * 同时负责把「人设框架 + 记忆索引卡片」渲染成注入上下文的文本（带字符预算）。
 */
import { clampText, detectKind, extractEntities, extractFacts, extractProfileHints, kindLabel, ruleSummary, topKeywords } from "./text.js";
import { renderCard, renderTimeline } from "./recall.js";
import { renderTopicCard } from "./topics.js";
import { composeFrame } from "./facts.js";

const KIND_SET = new Set(["identity", "decision", "event", "task", "emotion", "knowledge", "chat"]);

const SYSTEM_PROMPT = [
  "你是记忆女神的归档员。给定一轮人与 AI 的对话，抽取值得长期记住的信息。",
  "只输出一个 JSON 对象，不要 Markdown 代码块、不要解释。字段：",
  '{"summary":"一句话总结，≤60字","keywords":["3-6个检索关键词"],"entities":["人名/项目/文件名/技术名词等具体对象"],"kind":"identity|decision|event|task|emotion|knowledge|chat","facts":[{"subject":"user","predicate":"nickname","value":"老王","polarity":"+"}],"profile":{"userName":"","nickname":"","calledBy":"","personality":[],"preference":[],"event":""}}',
  "要求：",
  "1. summary 用第三人称陈述这轮发生了什么、用户要什么、结论是什么。",
  "2. keywords 用对话里出现过的词，中文为主，便于日后检索。",
  "3. kind 选最贴近的一个：身份/称呼/性格信息=identity；做出选择=decision；完成或发生了某事=event；计划待办=task；情绪表达=emotion；知识技术讨论=knowledge；其余=chat。",
  "4. facts 只收录**稳定的状态性事实**（用户怎么被称呼、用户的名字、用户偏好、用户性格、AI 的人设设定、环境约定），不收录一次性事件。",
  "   - subject：user（用户）| assistant（AI）| env（环境/项目约定）",
  "   - predicate：nickname 昵称 | name 名字 | calledBy AI 对用户的称呼 | persona AI 人设 | role AI 角色 | preference 偏好 | personality 性格 | path 路径 | model 模型 | language 语言 | tag 标签",
  "   - polarity：\"+\" 表示断言成立；\"-\" 表示否定（例如用户说「以后别叫我老王」→ {subject:user,predicate:nickname,value:老王,polarity:\"-\"}）",
  "   - 没有稳定事实时填空数组 []，不要凑数。",
  "5. profile 只在对话里出现明确的人设信息时才填；其它情况全部留空，不要编造。",
  "6. 不臆测，不补充对话里没有的事实。",
].join("\n");

/** 把一轮对话打包成模型输入（JSON 包裹，避免用户文本破坏结构）。 */
function frameInput(turn) {
  const payload = {
    time: new Date(turn.t).toISOString(),
    user: clampText(turn.user, 6000),
    assistant: clampText(turn.assistant, 6000),
  };
  return `归档这一轮对话：\n${JSON.stringify(payload)}`;
}

/** 从模型输出里解析 JSON（容忍代码块包裹与前后废话）。 */
export function parseSummaryJson(text) {
  if (typeof text !== "string") return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let candidate = text.slice(start, end + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    // 常见问题：尾逗号、单引号
    candidate = candidate.replace(/,\s*([}\]])/g, "$1").replace(/'/g, '"');
    try {
      return JSON.parse(candidate);
    } catch {
      return null;
    }
  }
}

/** 规则降级摘要（同时用正则抓一遍人设线索与事实，补模型缺席的空档）。 */
export function fallbackSummary(turn) {
  const summary = ruleSummary(turn.user, turn.assistant);
  const keywords = topKeywords(`${turn.user}\n${turn.assistant}`, 6);
  const entities = extractEntities(`${turn.user}\n${turn.assistant}`).slice(0, 10);
  return {
    summary,
    keywords,
    entities,
    kind: detectKind(`${turn.user}\n${turn.assistant}`),
    profile: extractProfileHints(turn.user),
    facts: extractFacts(turn.user),
    source: "rule",
  };
}

/** 校验并归一化模型输出。 */
function normalizeModelSummary(raw, turn) {
  if (raw === null || typeof raw !== "object") return null;
  const summary = typeof raw.summary === "string" ? raw.summary.trim() : "";
  if (summary === "") return null;
  const keywords = Array.isArray(raw.keywords)
    ? raw.keywords.filter((k) => typeof k === "string" && k.trim() !== "").map((k) => k.trim()).slice(0, 10)
    : [];
  const entities = Array.isArray(raw.entities)
    ? raw.entities.filter((e) => typeof e === "string" && e.trim() !== "").map((e) => e.trim()).slice(0, 12)
    : [];
  const kind = typeof raw.kind === "string" && KIND_SET.has(raw.kind) ? raw.kind : detectKind(`${turn.user}\n${turn.assistant}`);
  const profileRaw = raw.profile !== null && typeof raw.profile === "object" ? raw.profile : null;
  const profile = profileRaw === null
    ? null
    : {
        userName: typeof profileRaw.userName === "string" ? profileRaw.userName.trim().slice(0, 80) : "",
        nickname: typeof profileRaw.nickname === "string" ? profileRaw.nickname.trim().slice(0, 80) : "",
        calledBy: typeof profileRaw.calledBy === "string" ? profileRaw.calledBy.trim().slice(0, 80) : "",
        personality: Array.isArray(profileRaw.personality)
          ? profileRaw.personality.filter((v) => typeof v === "string" && v.trim() !== "").map((v) => v.trim()).slice(0, 8)
          : [],
        preference: Array.isArray(profileRaw.preference)
          ? profileRaw.preference.filter((v) => typeof v === "string" && v.trim() !== "").map((v) => v.trim()).slice(0, 8)
          : [],
        event: typeof profileRaw.event === "string" ? profileRaw.event.trim().slice(0, 200) : "",
      };
  const empty =
    profile !== null
    && profile.userName === ""
    && profile.nickname === ""
    && profile.calledBy === ""
    && profile.personality.length === 0
    && profile.preference.length === 0
    && profile.event === "";
  return {
    summary: clampText(summary, 200),
    keywords: keywords.length > 0 ? keywords : topKeywords(`${turn.user}\n${turn.assistant}`, 6),
    entities: entities.length > 0 ? entities : extractEntities(`${turn.user}\n${turn.assistant}`).slice(0, 10),
    kind,
    profile: empty ? null : profile,
    facts: Array.isArray(raw.facts)
      ? raw.facts
          .filter((fact) => fact !== null && typeof fact === "object" && typeof fact.predicate === "string" && fact.value !== undefined && fact.value !== null)
          .slice(0, 12)
      : [],
    source: "llm",
  };
}

/**
 * 用模型总结一轮对话。
 * @param {object} params
 * @param {{ provider: string, model: string }} params.route
 * @param {(options: object) => AsyncIterable<object>} params.stream  ctx.llm.stream
 * @param {{ user: string, assistant: string, t: number }} params.turn
 * @param {number} [params.timeoutMs]
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<object|null>} 失败返回 null，由调用方降级
 */
export async function summarizeWithLlm({ route, stream, turn, timeoutMs = 25000, signal }) {
  if (route === null || typeof route !== "object") return null;
  if (typeof route.provider !== "string" || typeof route.model !== "string") return null;
  if (route.provider === "" || route.model === "") return null;

  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Number(timeoutMs) : 25000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("summarize timeout")), timeout);
  const onAbort = () => controller.abort(signal?.reason);
  if (signal !== undefined) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    const options = {
      provider: route.provider,
      model: route.model,
      messages: [{ role: "user", content: [{ type: "text", text: frameInput(turn) }] }],
      system: SYSTEM_PROMPT,
      maxTokens: 900,
      signal: controller.signal,
    };
    let text = "";
    let failure = null;
    for await (const chunk of stream(options)) {
      if (chunk === null || typeof chunk !== "object") continue;
      if (chunk.type === "text-delta" && typeof chunk.text === "string") text += chunk.text;
      if (chunk.type === "finish") {
        const kind = chunk.reason?.kind;
        if (kind !== "stop" && kind !== "max-tokens") {
          failure = new Error(`模型结束原因异常：${String(kind)}${chunk.reason?.failure?.message !== undefined ? ` (${chunk.reason.failure.message})` : ""}`);
        }
      }
    }
    if (failure !== null) return null;
    const parsed = parseSummaryJson(text);
    return normalizeModelSummary(parsed, turn);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    if (signal !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

/**
 * 把命中的条目渲染成行：同一个话题合并成一行，零散条目各占一行。
 * 话题卡片按组内最高分参与排序，保证最相关的仍然排在最前。
 */
export function renderHitLines(hits, topicsIndex) {
  const groups = new Map();
  const items = [];

  for (const hit of hits) {
    const topicId = topicsIndex?.byEntryId?.get(hit.entry.id);
    if (topicId === undefined) {
      items.push({ score: hit.score ?? 0, kind: "entry", hit });
      continue;
    }
    const bucket = groups.get(topicId);
    if (bucket === undefined) groups.set(topicId, [hit]);
    else bucket.push(hit);
  }

  for (const [topicId, groupHits] of groups) {
    const topic = topicsIndex.list.get(topicId);
    // 单轮的话题没有"话题"可言，用普通卡片（能带上摘要）
    if (topic === undefined || topic.count <= 1) {
      items.push({ score: groupHits[0].score ?? 0, kind: "entry", hit: groupHits[0] });
      continue;
    }
    items.push({ score: Math.max(...groupHits.map((hit) => hit.score ?? 0)), kind: "topic", topic, hits: groupHits });
  }

  items.sort((a, b) => b.score - a.score);
  return items.map((item, index) =>
    item.kind === "topic" ? renderTopicCard(item.topic, index, item.hits) : renderCard(item.hit, index),
  );
}

/**
 * 渲染注入文本：人设框架（常驻） + 记忆索引卡片（按需）。
 * @param {object} params
 * @param {ReturnType<import('./store.js').normalizeProfile>} params.profile
 * @param {{ primary: Array, extra: Array, all?: Array, queryTokens: string[], timeHint: object|null }} [params.recall]
 * @param {Array} [params.recent] 无查询时的最近条目
 * @param {{ byEntryId: Map, list: Map }} [params.topics] 话题索引（可选）
 * @param {number} params.maxChars
 * @param {string} [params.sessionTitle]
 * @returns {string}
 */
export function renderInjection({ profile, facts, recall, recent, topics, maxChars, sessionTitle }) {
  const budget = Number.isFinite(maxChars) && maxChars > 0 ? Number(maxChars) : 2600;

  // 框架 = 手工维护的 profile + 生效中的事实（事实来自对话抽取，冲突已消解）
  const p = composeFrame(profile, Array.isArray(facts) ? facts : [], Date.now());
  const frameLines = [];

  // 用户身份压成一行（省 token，同时保持一眼可读）
  const userBits = [];
  if (p.user?.name) userBits.push(p.user.name);
  if ((p.user?.nicknames ?? []).length > 0) userBits.push(`昵称:${p.user.nicknames.join("/")}`);
  if (p.user?.calledBy) userBits.push(`称呼:${p.user.calledBy}`);
  if (p.user?.tone) userBits.push(`基调:${p.user.tone}`);
  if (userBits.length > 0) frameLines.push(`- 用户：${userBits.join(" ｜ ")}`);

  const traitBits = [];
  if ((p.personality ?? []).length > 0) traitBits.push(`性格:${p.personality.join("/")}`);
  if ((p.preferences ?? []).length > 0) traitBits.push(`偏好:${p.preferences.join("/")}`);
  if (traitBits.length > 0) frameLines.push(`- ${traitBits.join(" ｜ ")}`);

  const selfBits = [];
  if (p.self?.persona) selfBits.push(p.self.persona);
  if (p.self?.role) selfBits.push(`角色:${p.self.role}`);
  if (selfBits.length > 0) frameLines.push(`- 设定：${selfBits.join(" ｜ ")}`);

  if (p.notes) frameLines.push(`- 补充：${clampText(p.notes, 300)}`);

  const eventBits = (p.events ?? [])
    .slice(-6)
    .map((event) => {
      const d = new Date(Number(event.t) || Date.now());
      const stamp = `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      return `${stamp} ${clampText(event.text, 60)}`;
    });
  if (eventBits.length > 0) frameLines.push(`- 事件：${eventBits.join("；")}`);

  if (Array.isArray(p.paths) && p.paths.length > 0) {
    frameLines.push(`- 目录：${p.paths.map((path) => clampText(path, 60)).join("；")}`);
  }

  const frameText = frameLines.length === 0 ? "" : ["### 框架", ...frameLines].join("\n");

  const cards = [];
  const hitList = Array.isArray(recall?.all) && recall.all.length > 0
    ? recall.all
    : [...(recall?.primary ?? []), ...(recall?.extra ?? [])];
  const narrowed = recall !== undefined && recall !== null && (recall.primary?.length ?? 0) > 0;
  if (narrowed && hitList.length > 0) {
    cards.push(["### 相关记忆", ...renderHitLines(hitList, topics)].join("\n"));
  } else if (Array.isArray(recent) && recent.length > 0) {
    cards.push(["### 最近记忆", ...renderTimeline(recent, 5)].join("\n"));
  }

  const header = [typeof sessionTitle === "string" && sessionTitle !== ""
    ? `## 记忆女神 · ${clampText(sessionTitle, 40)}`
    : "## 记忆女神"];
  const footer = "> 只是索引：要原文用 memory_recall(id)，查不到用 memory_search(query)，值得长期记的事用 memory_note。";

  // 预算分配：框架最多占 50%，其余给索引卡片
  const reserve = clamps(header.join("\n") + footer, budget);
  let remaining = Math.max(0, budget - reserve.length);
  const frameBudget = Math.min(frameText.length, Math.floor(remaining * 0.5));
  const frameOut = frameText === "" ? "" : clampText(frameText, frameBudget);
  remaining -= frameOut.length;
  const cardsOut = cards.join("\n");
  const cardsTrimmed = cardsOut.length <= remaining ? cardsOut : clampText(cardsOut, Math.max(0, remaining));

  const body = [frameOut, cardsTrimmed].filter(Boolean).join("\n\n");
  if (body === "") return "";
  const text = [header.join("\n"), body, footer].join("\n\n");
  return text.length <= budget + reserve.length ? text : clampText(text, budget + reserve.length);
}

function clamps(text, max) {
  return text.length <= max ? text : clampText(text, max);
}
