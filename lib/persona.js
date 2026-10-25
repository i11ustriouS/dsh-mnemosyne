/**
 * 人设框架生成：让 AI 从记忆里自己长出「你是谁、我是谁」。
 *
 * 手填表单的框架永远是空的 —— 用户不会去填。真正可靠的做法是从对话里推：
 * 把最近的记忆时间线 + 已生效的事实喂给模型，让它产出结构化 facts，
 * 再走事实层那套冲突消解（同槽位新值让旧值失效），框架就跟着对话自己更新了。
 *
 * 和「每轮顺带抽一句」的区别：这里看的是**一段时间的整体**，
 * 所以能归纳出单轮看不出来的东西（长期偏好、稳定的性格、反复出现的诉求）。
 */
import { clampText, kindLabel, tokenize } from "./text.js";
import { parseSummaryJson } from "./summarize.js";

export const PERSONA_PROMPT = [
  "你在维护一份「AI 对用户的长期认知档案」。给定一段对话记忆时间线和已知事实，归纳出稳定的人设信息。",
  "只输出一个 JSON 对象，不要 Markdown 代码块、不要解释。字段：",
  '{"facts":[{"subject":"user","predicate":"nickname","value":"老王"}],"personality":["直接","务实"],"preferences":["回答简洁","先给结论"],"events":[{"t":"2026-10-22","text":"完成 adb_lab 安卓测试工具的真机验证"}],"summary":"一句话概括这个人"}',
  "要求：",
  "1. facts 只放**能明确从对话里读出来的**稳定事实：",
  "   - subject：user（用户）| assistant（AI）| env（项目/环境约定）",
  "   - predicate：nickname 昵称 | name 名字 | calledBy AI 对他的称呼 | persona AI 人设 | role AI 角色 | preference 偏好 | personality 性格 | path 项目路径 | model 常用模型 | language 语言 | tag 标签",
  "   - 没有证据就不要编。宁可少，不可错。",
  "2. personality / preferences 用简短短语（≤8 字），描述**稳定倾向**，不要写一次性要求。",
  "   例：「喜欢直接给方案」而不是「这次要求先看目录」。",
  "3. events 只放**关于这个人/这个环境的里程碑**，最多 5 条，按时间正序，t 用 YYYY-MM-DD。",
  "   ✓ 该放：长期约束（「要求所有工具全程离线」）、重大转向（「从 X 方案改为 Y」）、踩过的重要事故",
  "   ✗ 不该放：开发过程与迭代细节（「实现某某功能」「修复某某 bug」「自检 N 项通过」「压缩到 N 行」）",
  "   判据：这条信息三个月后还有用吗？只记录「做了什么」而没有沉淀出约束或结论的，一律不要。",
  "4. summary 用一句话概括「用户是个什么样的人、在意什么」。",
  "5. 如果证据不足，对应字段给空数组，不要用「未知」「N/A」占位。",
  "6. path 谓词的值必须是真实的文件系统路径（如 D:\\workspace\\proj），描述性文字绝不是路径，不要填。",
].join("\n");

/**
 * 事件文本里出现这些，说明记的是"开发过程"而不是"长期约束"。
 * prompt 已经要求模型别写，但模型不总是听话 —— 这里兜底。
 */
const PROCESS_PATTERNS = [
  /自检\s*\d+\s*项?/u,
  /(?:通过|失败)\s*\d+\s*项/u,
  /\d+\s*\/\s*\d+\s*(?:通过|全绿)/u,
  /(?:自检|验收|测试)\s*(?:结果)?\s*(?:通过|全绿|绿了)/u,
  /修复了?(?:了)?[\u4e00-\u9fa5A-Za-z]{1,12}(?:空白|bug|问题|错误|异常)/iu,
  /(?:实现|完成|新增|添加|补齐|重构|改造)了?[\u4e00-\u9fa5A-Za-z0-9_./-]{2,20}(?:功能|插件|模块|链路|接口)/u,
  // 「完成了 X（N 条/N 个/N 项）」——交付流水
  /(?:完成|实现|落地)了?[^，。；]{2,24}[（(]\s*\d+\s*[条个项轮]/u,
  /压缩\s*\d+\s*→\s*\d+/u,
  /\d+\s*(?:条|行|KB|MB)\s*(?:→|->)\s*\d+/u,
  /(?:摘要|归档|合并)\s*\d+\s*条/u,
  // 「要求 X 改为 Y」「确定 A 分库」——带改造动词的需求记录，不是长期约束。
  // 真约束形如「要求全程离线不联网」（单一属性），不含这些改造动词。
  /(?:确定|定下|敲定|决定|要求|改为|改成|换成|重构|拆成|分库|接入|升级)[^，。；]{0,20}(?:改为|改成|换成|生成|分库|消解|实现|接入|升级|链路|自检|归纳)/u,
  // 「定位 X 为 Y，改挂 Z 修复」「删除七个扩展包…验收 12/12」——工程操作记录
  /(?:定位|排查|改挂|迁移|删除|移除|升级|降级)[^，。；]{2,30}(?:修复|解决|通过|完成|生效)/u,
  /验收\s*\d+\s*\/\s*\d+/u,
];

/** 这条事件是不是一段开发流水。 */
export function isProcessEvent(text) {
  const value = String(text ?? "");
  return PROCESS_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * 判断一段文本（或一条记忆）是不是"框架注入的回声"。
 *
 * 我们自己的注入文本（`## 记忆库\n### 框架 ...`）有时会被会话标题/摘要捕获，
 * 变成一条新记忆；再喂回人设归纳就成了自我强化的正反馈。
 * 这类内容不是"发生过的事"，要从归纳输入里剔除。
 *
 * 接受字符串或记忆对象两种入参：调用点既有「一条记忆」，也有「一个值」。
 */
export function isFrameworkEcho(input) {
  const text = typeof input === "string"
    ? input
    : `${input?.summary ?? ""}\n${input?.user ?? ""}`;
  if (text === "") return false;
  if (text.includes("### 框架") || text.includes("## 记忆库")) return true;
  // 整句都是注入里的行样式（多行模式下逐行匹配）
  if (/^- (?:性格|偏好|补充|事件|目录)[：:]/mu.test(text)) return true;
  return false;
}

/**
 * 路径事实必须是真路径：盘符开头（且不像句子）、或 / 开头的 POSIX 绝对路径（限长）。
 * 描述性文字（「记忆库面板挂载槽 shell.overlay」）一律拒绝。
 */
export function isPathLike(value) {
  const text = String(value ?? "").trim();
  if (text === "") return false;
  if (text.length > 120) return false;
  // Windows：C:\... 或 C:/...
  if (/^[A-Za-z]:[\\/]/u.test(text)) {
    return !/[\s，。；：、（）【】「」]/u.test(text);
  }
  // 相对/绝对 POSIX：只接受带路径分隔符且无空白的
  if (/^\/[^\s，。；：、（）*?"<>|]+/u.test(text)) return true;
  return false;
}

/**
 * 事件的"同一件事"判据 —— 归纳去重与一次性清理共用一套。
 *
 * 纯 Jaccard 对长度差异敏感：`定下设备测试工具全程离线不联网的硬性红线`
 * 和 `adb_lab 设备测试工具开发，明确「全程严禁联网」红线` 说的是同一件事，
 * 但用词不同、长度不同，Jaccard 只有 0.2。所以看「共享实词数」。
 */
const RED_LINE = /联网|离线/u;

function contentTokens(text) {
  return new Set(
    tokenize(String(text ?? "")).filter(
      (token) => /^[a-z0-9_.-]{2,}$/iu.test(token) || /^[\u4e00-\u9fa5]{2,}$/u.test(token),
    ),
  );
}

/** 两条事件是不是同一件事。 */
export function sameEvent(a, b) {
  const left = contentTokens(a);
  const right = contentTokens(b);
  if (left.size === 0 || right.size === 0) return false;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  if (shared >= 2) return true;
  // 「全程离线」与「全程严禁联网」用词不同但同指一条红线
  return RED_LINE.test(String(a ?? "")) && RED_LINE.test(String(b ?? "")) && shared >= 1;
}

/** 从模型输出里取出可用的框架草稿。 */
export function normalizePersonaDraft(raw) {
  if (raw === null || typeof raw !== "object") return null;
  const facts = Array.isArray(raw.facts)
    ? raw.facts
        .filter(
          (fact) =>
            fact !== null &&
            typeof fact === "object" &&
            typeof fact.predicate === "string" &&
            fact.predicate.trim() !== "",
        )
        .map((fact) => ({
          subject: typeof fact.subject === "string" ? fact.subject : "user",
          predicate: String(fact.predicate).trim(),
          value: String(fact.value ?? "").trim(),
          polarity: "+",
          confidence: 0.7,
        }))
        .filter((fact) => fact.value !== "")
        // 路径事实必须是真路径，否则会污染「目录」行
        .filter((fact) => (fact.predicate === "path" ? isPathLike(fact.value) : true))
        .slice(0, 24)
    : [];
  const list = (value, limit) =>
    Array.isArray(value)
      ? value.filter((item) => typeof item === "string" && item.trim() !== "").map((item) => clampText(item.trim(), 24)).slice(0, limit)
      : [];
  const rawEvents = Array.isArray(raw.events)
    ? raw.events
        .filter((event) => event !== null && typeof event === "object" && typeof event.text === "string" && event.text.trim() !== "")
        // 开发过程不算里程碑：自检通过、改了哪个 bug、压缩了多少行都不是
        .filter((event) => !isProcessEvent(event.text))
        .map((event) => {
          const parsed = Date.parse(String(event.t ?? ""));
          return { t: Number.isFinite(parsed) ? parsed : 0, text: clampText(event.text.trim(), 120), kind: "event" };
        })
    : [];
  // 同一件事被归纳多次（「全程离线」说了三遍）只留一条，长的优先（信息更全）
  const events = [];
  for (const event of rawEvents.slice().sort((a, b) => b.text.length - a.text.length)) {
    if (events.some((existing) => sameEvent(existing.text, event.text))) continue;
    events.push(event);
  }
  const ordered = events.sort((a, b) => a.t - b.t).slice(-5);
  return {
    facts,
    personality: list(raw.personality, 12),
    preferences: list(raw.preferences, 16),
    events: ordered,
    summary: typeof raw.summary === "string" ? clampText(raw.summary.trim(), 160) : "",
  };
}

/** 把记忆和事实铺成给模型看的时间线。 */
export function buildPersonaInput({ entries, facts, limit = 40 }) {
  const lines = entries
    // 框架注入的摘要不是"发生过的事"，喂回去会让人设自我强化，必须排除
    .filter((entry) => !isFrameworkEcho(entry))
    .slice(0, limit)
    .map((entry) => {
      const d = new Date(Number(entry.t) || Date.now());
      const pad = (n) => String(n).padStart(2, "0");
      const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      return `${stamp} [${kindLabel(entry.kind)}] ${clampText(entry.summary || entry.user || "", 90)}`;
    });
  const factLines = facts
    .filter((fact) => fact.predicate !== "path" || isPathLike(fact.value))
    .map((fact) => `${fact.subject}/${fact.predicate}=${fact.value}`);
  return {
    timeline: lines.join("\n"),
    facts: factLines.join("；"),
    count: lines.length,
  };
}

/**
 * 调用模型生成框架草稿。
 * @param {object} params
 * @param {{provider: string, model: string}} params.route
 * @param {(options: object) => AsyncIterable} params.stream
 * @param {Array} params.entries 记忆条目（新到旧）
 * @param {Array} params.facts 已生效事实
 * @param {number} [params.timeoutMs]
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<object|null>}
 */
export async function buildPersonaWithLlm({ route, stream, entries, facts, timeoutMs = 30000, signal }) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  if (route === null || route === undefined || typeof stream !== "function") return null;

  const input = buildPersonaInput({ entries, facts });
  if (input.count === 0) return null;

  // 实测这个模型路由的间歇故障率很高（探针 7 组里 5 组返回 finish=aborted，
  // 同一组参数重跑结果都不同）。成功一次就够，所以重试次数给足并加退避。
  let lastError = null;
  const maxAttempts = 5;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const draft = await attemptPersona({ route, stream, input, timeoutMs, signal });
      if (draft !== null) return draft;
      lastError = new Error("模型返回的草稿为空");
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      // 超时不必重试（已经等够了）
      if (String(lastError.message).includes("timeout")) break;
      // 退避一下再试：立刻重试容易撞上同一波故障
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
    }
  }
  throw lastError ?? new Error("模型没有返回有效结果");
}

/**
 * 单次尝试：调模型 → 收文本 → 解析成草稿。
 * 失败一律抛错（由调用方决定是否重试），不再静默返回 null —— 静默失败无法定位问题。
 */
async function attemptPersona({ route, stream, input, timeoutMs, signal }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("persona timeout")), timeoutMs);
  const onAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener?.("abort", onAbort, { once: true });

  let text = "";
  const debug = { chunks: 0, types: [], textLen: 0 };
  try {
    const iterator = stream({
      provider: route.provider,
      model: route.model,
      // content 必须是块数组（与 summarizeWithLlm 一致）：适配器不认裸字符串
      messages: [{
        role: "user",
        content: [{ type: "text", text: JSON.stringify({ timeline: input.timeline, knownFacts: input.facts }) }],
      }],
      system: PERSONA_PROMPT,
      // 归纳要输出 facts + personality + preferences + events + summary，
      // 实测 900 tokens 会在 236 字符处截断（finish=max-tokens），JSON 不完整。
      // 总结那边 900 够用（只要摘要+关键词），这里必须留足。
      maxTokens: 2400,
      signal: controller.signal,
    });
    for await (const chunk of iterator) {
      if (chunk === null || chunk === undefined) continue;
      debug.chunks += 1;
      if (debug.types.length < 8) debug.types.push(String(chunk.type));
      if (chunk.type === "text-delta" && typeof chunk.text === "string") text += chunk.text;
      if (chunk.type === "finish") {
        const kind = chunk.reason?.kind;
        if (kind !== "stop" && kind !== "max-tokens") {
          debug.finish = String(kind);
        }
        break;
      }
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      throw error instanceof Error ? error : new Error(String(error));
    }
    debug.aborted = true;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", onAbort);
  }
  debug.textLen = text.length;
  if (text.trim() === "") {
    // 空流通常是：模型不支持该调用方式、被限流、或 finish 原因异常
    throw new Error(`模型没有返回文本（chunks=${debug.chunks} types=${debug.types.join(",")} finish=${debug.finish ?? "-"})`);
  }

  const parsed = parseSummaryJson(text);
  if (parsed === null) {
    // 有输出但不是 JSON：把开头带出来，便于判断是"没按格式回"还是"被截断"
    throw new Error(`模型输出不是 JSON（${text.length} 字符）：${text.slice(0, 120)}`);
  }
  return normalizePersonaDraft(parsed);
}
