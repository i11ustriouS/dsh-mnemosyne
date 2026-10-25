/**
 * 中文/英文混合文本处理：分词、关键词、实体抽取、事件类型判定、规则摘要。
 *
 * 设计取向：不引入任何第三方依赖，用 bigram + 停用词过滤做检索级分词，
 * 足够支撑「命中率优先」的记忆召回；需要语义级理解时交给 LLM 总结层。
 */

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/;

export const isCjk = (ch) => typeof ch === "string" && ch.length > 0 && CJK_RE.test(ch);

/** 中文停用词（单字 + 常见虚词组合）。 */
const STOP_CN = new Set([
  "的", "了", "是", "在", "我", "你", "他", "她", "它", "们", "这", "那", "个",
  "吗", "呢", "吧", "啊", "呀", "哦", "嗯", "哈", "就", "都", "也", "和", "与",
  "及", "但", "而", "为", "被", "把", "让", "给", "从", "到", "上", "下", "里",
  "中", "后", "前", "时", "候", "对", "会", "要", "能", "有", "没", "很", "太",
  "更", "最", "什", "么", "怎", "样", "如", "何", "请", "帮", "下", "一", "些",
  "可", "以", "需", "应", "该", "一", "个", "们", "自", "己", "还", "又", "再",
  "已", "经", "比", "较", "非", "常", "现", "在", "然", "后", "还", "是", "就",
  "不", "好", "想", "说", "做", "看", "用", "去", "来", "过", "吗", "嘛", "喔",
  "楼", "呗", "咱", "俺", "您", "它", "此", "其", "该", "另", "每", "各", "某",
]);

/** 英文停用词。 */
const STOP_EN = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "else", "for", "to", "of",
  "in", "on", "at", "by", "with", "from", "is", "are", "was", "were", "be",
  "been", "being", "do", "does", "did", "have", "has", "had", "i", "you", "he",
  "she", "it", "we", "they", "me", "my", "your", "this", "that", "these", "those",
  "what", "how", "why", "when", "where", "which", "can", "could", "should",
  "would", "will", "just", "not", "no", "yes", "please", "thanks", "ok", "okay",
  "let", "lets", "us", "our", "their", "them", "there", "here", "about", "into",
  "than", "too", "very", "so", "such", "also", "as", "up", "out", "all", "any",
]);

const EN_WORD_RE = /[a-z0-9][a-z0-9_+.#/-]{1,}/gi;
const CJK_RUN_RE = /[\u3400-\u4dbf\u4e00-\u9fff]{2,}/g;

/**
 * 把文本切成检索词。
 * - 英文/数字：整词（小写），长度 ≥ 2 且非停用词
 * - 中文：连续汉字段落按 2 字滑窗（长度 ≤ 4 的段落保留整词 + bigram）
 * @param {string} text
 * @returns {string[]} 去重前的 token 列表
 */
export function tokenize(text) {
  const out = [];
  if (typeof text !== "string" || text.length === 0) return out;
  const src = text.slice(0, 20000);

  for (const match of src.matchAll(EN_WORD_RE)) {
    const word = match[0].toLowerCase();
    if (word.length < 2) continue;
    if (STOP_EN.has(word)) continue;
    out.push(word);
  }

  for (const match of src.matchAll(CJK_RUN_RE)) {
    const run = match[0];
    if (run.length <= 4) {
      // 短段也要看首尾字：否则「你好」「可以」「还是」这类口语组合会整段进索引。
      const head = run[0];
      const tail = run[run.length - 1];
      if (!STOP_CN.has(run) && !STOP_CN.has(head) && !STOP_CN.has(tail)) out.push(run);
      if (run.length >= 3 && !STOP_CN.has(head) && !STOP_CN.has(tail)) {
        out.push(run.slice(0, 2), run.slice(-2));
      }
      continue;
    }
    for (let i = 0; i + 2 <= run.length; i += 1) {
      const bigram = run.slice(i, i + 2);
      if (STOP_CN.has(bigram[0]) || STOP_CN.has(bigram[1])) continue;
      out.push(bigram);
    }
    // 3-gram 提升专有名词（如「记忆库」「漏洞库」）的权重；
    // 含停用字的三字串一律丢弃，避免「的了是」这类组合污染索引。
    for (let i = 0; i + 3 <= run.length; i += 1) {
      const trigram = run.slice(i, i + 3);
      if (STOP_CN.has(trigram[0]) || STOP_CN.has(trigram[1]) || STOP_CN.has(trigram[2])) continue;
      out.push(trigram);
    }
  }

  return out.filter((t) => t.length > 0);
}

/** token 的检索权重：长词更具体。 */
export function tokenWeight(token) {
  if (!isCjk(token[0])) return token.length >= 4 ? 1.6 : 1.2;
  if (token.length >= 4) return 1.6;
  if (token.length === 3) return 1.35;
  return 1;
}

/** 中文专有名词后缀：命中则显著提权（这些才是人想检索的"对象"）。 */
const NOUN_SUFFIX = /(插件|项目|工具|平台|系统|靶场|镜像|游戏|模块|脚本|组件|服务|框架|记忆库|漏洞库|数据库|引擎|面板|配置|流程|方案|文档|文件|目录|接口|规则|策略|版本|功能|页面|窗口|终端|进程|日志|用户|账号|模型|提示词)$/;

/**
 * 出现频次最高的 n 个关键词。
 *
 * 关键点：滑窗产出的三字碎片（如「忆库插」「库插件」）必须被淘汰，
 * 否则索引卡片里全是没法读的东西。判定标准是「支撑度」——
 * 三字串两侧的二字串都得真实高频出现，才说明它是独立成词而非跨词切开的。
 */
export function topKeywords(text, n = 6) {
  const counts = new Map();
  const bigramCounts = new Map();
  for (const token of tokenize(text)) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
    if (isCjk(token[0]) && token.length === 2) {
      bigramCounts.set(token, (bigramCounts.get(token) ?? 0) + 1);
    }
  }
  const scored = [];
  for (const [token, count] of counts) {
    if (!isCjk(token[0])) {
      // 英文/技术词：整词就是好关键词，长词更具体
      scored.push([token, count * (token.length >= 4 ? 1.6 : 1.2)]);
      continue;
    }
    if (token.length === 2) {
      scored.push([token, count * (NOUN_SUFFIX.test(token) ? 1.6 : 1)]);
      continue;
    }
    // 三字及以上：要求重复出现，且两侧二字串都有支撑
    const left = bigramCounts.get(token.slice(0, 2)) ?? 0;
    const right = bigramCounts.get(token.slice(-2)) ?? 0;
    const support = Math.min(left, right);
    if (count < 2 || support < count) continue;
    scored.push([token, count * 1.7 * (NOUN_SUFFIX.test(token) ? 1.4 : 1)]);
  }
  scored.sort((a, b) => b[1] - a[1]);
  const picked = [];
  for (const [token] of scored) {
    // 已被更长的同族词覆盖（如同时有话记忆/记忆库时不重复收录）
    if (picked.some((p) => p.includes(token) && p.length > token.length)) continue;
    picked.push(token);
    if (picked.length >= n) break;
  }
  return picked;
}

/** 削掉称呼类结果尾部的口语虚词（「老王就行」→「老王」）。 */
function stripTail(value) {
  return String(value ?? "")
    .replace(/(?:就可以|就行|就好|可以|谢谢|吧|啊|哦|啦|嘛|呢|呀|了)+$/u, "")
    .trim()
    .slice(0, 40);
}

/**
 * 规则事实抽取：从用户原话里抓「稳定事实」（称呼/名字/偏好/性格）。
 *
 * 和 extractProfileHints 的区别：这里产出的是带槽位的结构化事实，
 * 带极性（"+" 断言 / "-" 否定），可以直接进冲突消解流程。
 * @param {string} text
 * @returns {Array<{subject: string, predicate: string, value: string, polarity: string, confidence: number}>}
 */
export function extractFacts(text) {
  const facts = [];
  if (typeof text !== "string" || text === "") return facts;
  const src = text.slice(0, 4000);
  const add = (subject, predicate, value, polarity = "+", confidence = 0.75) => {
    const v = stripTail(value);
    if (v.length < 1 || v.length > 40) return;
    facts.push({ subject, predicate, value: v, polarity, confidence });
  };

  // 否定必须排在肯定之前匹配，否则「别叫我老王」会被「叫我」规则吃掉
  for (const match of src.matchAll(/(?:以后|以后都|请)?(?:别|不要|不用|不要再|别再)(?:再)?(?:叫我|喊我|称呼我)\s*[「“"]?([^\s，。,.!！？?「」“”"]{1,16})/g)) {
    add("user", "nickname", match[1], "-", 0.85);
  }
  for (const match of src.matchAll(/(?:以后|以后就|就)?(?:叫我|喊我|称呼我|管我叫)\s*[「“"]?([^\s，。,.!！？?「」“”"]{1,16})/g)) {
    add("user", "nickname", match[1], "+", 0.85);
  }
  for (const match of src.matchAll(/(?:我的名字叫|我叫)\s*[「“"]?([^\s，。,.!！？?「」“”"]{1,12})(?=[，。,.!！？?\s]|$)/g)) {
    add("user", "name", match[1], "+", 0.8);
  }
  for (const match of src.matchAll(/(?:你的名字叫|你叫|你就叫)\s*[「“"]?([^\s，。,.!！？?「」“”"]{1,12})(?=[，。,.!！？?\s]|$)/g)) {
    add("assistant", "name", match[1], "+", 0.7);
  }
  for (const match of src.matchAll(/(?:我)?(?:更?喜欢|偏爱|倾向(?:于)?)\s*([^\s，。,.!！？?；;]{2,20})/g)) {
    add("user", "preference", match[1], "+", 0.6);
  }
  for (const match of src.matchAll(/(?:我)?(?:不喜欢|讨厌|受不了|不想要)\s*([^\s，。,.!！？?；;]{2,20})/g)) {
    add("user", "preference", match[1], "-", 0.6);
  }
  for (const match of src.matchAll(/(?:我这个人|我比较|我有点|我是那种)\s*([^\s，。,.!！？?；;]{2,16})/g)) {
    add("user", "personality", match[1], "+", 0.5);
  }
  // 同一句里同一 (subject,predicate,value) 只保留一条
  const seen = new Set();
  return facts.filter((fact) => {
    const key = `${fact.subject}/${fact.predicate}/${fact.value.toLowerCase()}/${fact.polarity}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * 规则人设抽取：模型不可用时也能抓到称呼、偏好这些最该记住的东西。
 * @param {string} text
 * @returns {{userName: string, nickname: string, calledBy: string, personality: string[], preference: string[], event: string}|null}
 */
export function extractProfileHints(text) {
  if (typeof text !== "string" || text.length === 0) return null;
  const src = text.slice(0, 4000);
  const out = { userName: "", nickname: "", calledBy: "", personality: [], preference: [], event: "" };
  const take = (re, group = 1) => {
    const match = src.match(re);
    const value = match?.[group]?.trim();
    return value !== undefined && value.length >= 1 && value.length <= 24 ? value : "";
  };
  // 称呼类结果要削掉尾部口语虚词（「老王就行」→「老王」）
  const clean = (value) =>
    value.replace(/(?:就可以|就行|就好|可以|谢谢|吧|啊|哦|啦|嘛|呢|呀|了)+$/u, "").trim().slice(0, 24);
  // 用户怎么称呼自己 / 希望 AI 怎么称呼自己
  out.calledBy = clean(
    take(/(?:以后|就)?(?:叫我|喊我|称呼我|管我叫)\s*[「“"]?([^\s，。,.!！？?「」“”"]{1,16})/) ||
      take(/(?:我的名字叫|我叫|我是)\s*[「“"]?([^\s，。,.!！？?「」“”"]{1,12})(?=[，。,.!！？?\s]|$)/),
  );
  // 昵称（同一句式但带「昵称」字样）
  out.nickname = clean(take(/(?:我的)?昵称(?:是|叫)?\s*[「“"]?([^\s，。,.!！？?]{1,16})/));
  // 明确要求记下来的事件
  out.event = take(/(?:记住|记一下|别忘了)[：:\s]*([^\n]{2,80})/, 1);
  // 偏好：喜欢 / 不喜欢 / 讨厌 / 不要
  for (const match of src.matchAll(/(?:我)?(?:更?喜欢|偏爱|倾向(?:于)?)\s*([^\s，。,.!！？?；;]{2,20})/g)) {
    out.preference.push(match[1]);
  }
  for (const match of src.matchAll(/(?:我)?(?:不喜欢|讨厌|受不了|不想要|别用|不要用)\s*([^\s，。,.!！？?；;]{2,20})/g)) {
    out.preference.push(`不喜欢:${match[1]}`);
  }
  // 性格自述（保守：只在明确自述句式上采信）
  for (const match of src.matchAll(/(?:我这个人|我比较|我有点|我是那种)\s*([^\s，。,.!！？?；;]{2,16})/g)) {
    out.personality.push(match[1]);
  }
  const empty =
    out.calledBy === "" &&
    out.nickname === "" &&
    out.event === "" &&
    out.preference.length === 0 &&
    out.personality.length === 0;
  return empty ? null : out;
}

/** 引号、路径、文件名、驼峰标识符、专有名词等「对象」型实体。 */
export function extractEntities(text) {
  const out = new Set();
  if (typeof text !== "string" || text.length === 0) return [];
  const src = text.slice(0, 20000);

  const add = (value) => {
    const v = String(value).trim();
    if (v.length < 2 || v.length > 40) return;
    out.add(v);
  };

  for (const m of src.matchAll(/[「『“"【]([^」』”"】\n]{2,30})[」』”"】]/g)) add(m[1]);
  for (const m of src.matchAll(/\bhttps?:\/\/[^\s"'<>）)]+/g)) add(m[0]);
  for (const m of src.matchAll(/\b[A-Za-z]:\\[^\s"'<>|]+/g)) add(m[0]);
  for (const m of src.matchAll(/\b[\w.-]+\.(?:js|mjs|cjs|ts|tsx|jsx|json|jsonl|md|py|bat|ps1|sh|yml|yaml|html|css|log|txt|exe|apk|db|zip|pdf|svg|png|jpg)\b/gi)) add(m[0]);
  for (const m of src.matchAll(/\b[A-Z][A-Za-z0-9]{2,}(?:[A-Z][A-Za-z0-9]*)*\b/g)) add(m[0]);
  for (const m of src.matchAll(/[\u4e00-\u9fa5]{2,8}(?:插件|项目|工具|平台|系统|靶场|镜像|游戏|模块|脚本|组件|服务|框架|记忆库|漏洞库|数据库|引擎|面板)/g)) add(m[0]);
  for (const m of src.matchAll(/\bv?\d+\.\d+(?:\.\d+)*(?:-[a-z0-9.]+)?\b/gi)) add(m[0]);
  for (const m of src.matchAll(/\b\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2})?\b/g)) add(m[0]);
  for (const m of src.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g)) add(m[0]);
  for (const m of src.matchAll(/@[\w\u4e00-\u9fa5]{2,20}/g)) add(m[0]);

  return [...out];
}

/** 事件类型判定：身份/决策/事件/任务/情绪/知识/闲聊。 */
const KIND_RULES = [
  ["identity", /(叫我|喊我|称呼|昵称|我叫|名字叫|你是|你的名字|人设|性格|记住我|我的偏好|我喜欢|我不喜欢)/],
  ["decision", /(决定|确定用|就选|改成|换成|采用|方案|最终选择|拍板|定下来)/],
  ["task", /(要做|需要做|计划|下一步|待办|记得|明天|下周|安排|目标|实现|开发|写一个|帮我做)/],
  ["event", /(完成|搞定|上线|发布|交付|修复|出错|失败|崩溃|报错|部署|安装|测试通过|跑通|验证)/],
  ["emotion", /(难过|开心|生气|焦虑|累|烦|爽|害怕|惊喜|感动|难受|委屈)/],
  ["knowledge", /(原理|机制|区别|概念|为什么|怎么实现|技术|架构|算法|性能|优化|文档)/],
];

/** @returns {string} kind */
export function detectKind(text) {
  if (typeof text !== "string" || text.length === 0) return "chat";
  for (const [kind, re] of KIND_RULES) {
    if (re.test(text)) return kind;
  }
  return "chat";
}

const KIND_LABELS = {
  identity: "人设",
  decision: "决策",
  event: "事件",
  task: "任务",
  emotion: "情绪",
  knowledge: "知识",
  chat: "闲聊",
};

export const kindLabel = (kind) => KIND_LABELS[kind] ?? kind;

/** 取文本中第一个长度达标的句子。 */
export function firstSentence(text, maxChars = 90) {
  if (typeof text !== "string") return "";
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length === 0) return "";
  const match = clean.match(/^(.{1,240}?)(?:[。！？!?\n]|$)/);
  const sentence = (match?.[1] ?? clean).trim();
  return sentence.length > maxChars ? `${sentence.slice(0, maxChars)}…` : sentence;
}

/** 去掉口语填充词后的紧凑文本。 */
export function compactText(text) {
  if (typeof text !== "string") return "";
  return text
    .replace(/\s+/g, " ")
    .replace(/^(请问|你好|嗨|那个|就是说|嗯|额|那个的话)[，,。\s]*/u, "")
    .trim();
}

/**
 * 把「用户：A｜回应：B」压成「A → B」。
 * 规则摘要和话题卡片会互相嵌套，不清掉前缀就会出现「含：用户：用户：…」。
 */
export function traceToArrow(text) {
  if (typeof text !== "string" || text === "") return "";
  const match = text.match(/^用户[：:]\s*([\s\S]*?)(?:｜|\|)\s*回应[：:]\s*([\s\S]*)$/);
  if (match !== null) {
    const user = match[1].trim();
    const assistant = match[2].trim();
    if (user !== "" && assistant !== "") return `${user} → ${assistant}`;
    return user || assistant;
  }
  return text.replace(/^(?:用户[：:]|回应[：:])\s*/u, "").trim();
}

/**
 * 规则摘要：不依赖模型也能产出可读的一行总结。
 * @param {string} userText
 * @param {string} assistantText
 * @returns {string}
 */
export function ruleSummary(userText, assistantText) {
  const user = firstSentence(compactText(userText), 80);
  const assistant = firstSentence(compactText(assistantText), 90);
  if (!user && !assistant) return "";
  if (user && assistant) return `用户：${user}｜回应：${assistant}`;
  return user || assistant;
}

/** 粗略估算字符串的 token 数（中文按 1.5 字/token，英文按 4 字符/token）。 */
export function estimateTokens(text) {
  if (typeof text !== "string" || text.length === 0) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (CJK_RE.test(ch)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk / 1.5 + other / 4);
}

/** 安全截断（不劈开代理对）。 */
export function clampText(text, maxChars) {
  if (typeof text !== "string") return "";
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  let cut = maxChars;
  const code = text.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return `${text.slice(0, cut)}…`;
}
