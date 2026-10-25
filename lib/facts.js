/**
 * 语义记忆（facts）：稳定事实与冲突消解。
 *
 * 和 episodes（一轮轮对话流水）分开存的原因：
 *  - 「用户叫老王」是**状态**，改口后旧值必须失效，不能新旧并存；
 *  - 「今天修了个 bug」是**事件**，只增不改，永远留在时间线上。
 * 两类混在一个池子里，检索时稳定信息会被流水淹没，改口后还会同时召回两个矛盾的答案。
 *
 * 槽位（slot）是冲突消解的支点：
 *  - 单值谓词（称呼、名字、人设、路径…）→ 一个槽位只有一个当前值，新值让旧值失效；
 *  - 多值谓词（偏好、性格、标签…）→ 槽位带值，天然可并存，只做去重；
 *  - 否定极性（polarity '-'）不参与注入，只用来让匹配的正面事实失效：
 *    「以后别叫我老王」= 让 (user,nickname,老王) 这条失效，而不是覆盖整个昵称槽位。
 */
import { clampText } from "./text.js";

/** 单值谓词：同一槽位只保留一个当前值。 */
export const SINGLE_VALUED = new Set([
  "name",
  "nickname",
  "calledBy",
  "persona",
  "role",
  "model",
  "language",
  "timezone",
  "title",
  "birthday",
]);

/** 多值谓词：可以同时成立，只去重不冲突。 */
export const MULTI_VALUED = new Set([
  "preference",
  "personality",
  "tag",
  "skill",
  "habit",
  "milestone",
  "tool",
  "project",
  // 路径天然多个并存：不同项目在不同的目录
  "path",
]);

/** 谓词 → 中文标签（注入与面板展示用）。 */
export const PREDICATE_LABELS = {
  name: "名字",
  nickname: "昵称",
  calledBy: "称呼",
  persona: "人设",
  role: "角色",
  path: "路径",
  model: "模型",
  language: "语言",
  timezone: "时区",
  title: "头衔",
  birthday: "生日",
  preference: "偏好",
  personality: "性格",
  tag: "标签",
  skill: "技能",
  habit: "习惯",
  milestone: "里程碑",
  tool: "工具",
  project: "项目",
};

const SUBJECT_LABELS = { user: "用户", assistant: "AI", env: "环境", general: "" };

export const subjectLabel = (subject) => SUBJECT_LABELS[subject] ?? subject;
export const predicateLabel = (predicate) => PREDICATE_LABELS[predicate] ?? predicate;

/** 值归一化：去多余空白、统一大小写比较用。 */
export function normalizeValue(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
}

/** 路径事实必须是真路径：盘符开头且不是句子，或 POSIX 绝对路径。 */
export function isPathLike(value) {
  const text = String(value ?? "").trim();
  if (text === "" || text.length > 120) return false;
  if (/^[A-Za-z]:[\\/]/u.test(text)) return !/[\s，。；：、（）【】「」]/u.test(text);
  if (/^\/[^\s，。；：、（）*?"<>|]+/u.test(text)) return true;
  return false;
}

/** 这条内容是不是从我们自己的注入框架回流来的（防止自我强化）。 */
export function isFrameworkEcho(value) {
  const text = String(value ?? "");
  if (text.includes("### 框架") || text.includes("## 记忆库")) return true;
  if (/^- (?:性格|偏好|补充|事件|目录)[：:]/mu.test(text)) return true;
  return false;
}

/**
 * 多值事实的"同一件事"归一：剥掉口语化的引导词和修饰。
 *
 * 多值谓词的槽位含完整值，只做精确去重的话，「全程离线不联网」和
 * 「要求全程离线不联网」会各占一个槽 —— 框架里就出现两条一样的意思。
 * 这里把「要求/喜欢/希望/希望我/请」这类引导词剥掉，得到用于比较的骨架。
 */
export function factValueKey(value) {
  return normalizeValue(value)
    .toLowerCase()
    // 口语引导词（只剥开头，避免误伤词中）
    .replace(/^(?:要求|希望|喜欢|偏好|请|务必|需要|想要|希望我|要求我|让我)(?:我)?/u, "")
    // 结尾的语气与标点
    .replace(/[。！!，,；;～~]+$/u, "")
    .trim();
}

/** 两个多值事实是不是同一件事（骨架相同，或一个包含另一个且长度接近）。 */
export function sameFactValue(a, b) {
  const left = factValueKey(a);
  const right = factValueKey(b);
  if (left === "" || right === "") return false;
  if (left === right) return true;
  // 路径类值不做模糊匹配：parent 与 parent\child 是两个不同的目录，都有用
  if (isPathLike(String(a)) || isPathLike(String(b))) return false;
  const [short, long] = left.length <= right.length ? [left, right] : [right, left];
  // 短的是长的子串，且长度差不大 → 视为同一件事
  return short.length >= 2 && long.includes(short) && short.length / long.length >= 0.6;
}

/** 槽位：单值谓词不含值，多值谓词含值。 */
export function factSlot(fact) {
  const subject = String(fact.subject ?? "general");
  const predicate = String(fact.predicate ?? "tag");
  if (MULTI_VALUED.has(predicate)) return `${subject}/${predicate}/${normalizeValue(fact.value).toLowerCase()}`;
  return `${subject}/${predicate}`;
}

let factSeq = 0;
function newFactId(now) {
  factSeq += 1;
  return `ft-${now.toString(36)}-${factSeq.toString(36)}`;
}

/** 校验/归一化一条事实；非法返回 null。 */
export function normalizeFact(raw, now = Date.now()) {
  if (raw === null || typeof raw !== "object") return null;
  const subject = typeof raw.subject === "string" && raw.subject.trim() !== "" ? raw.subject.trim().slice(0, 40) : "user";
  const predicate = typeof raw.predicate === "string" && raw.predicate.trim() !== "" ? raw.predicate.trim().slice(0, 30) : "";
  const value = normalizeValue(raw.value);
  if (predicate === "" || value === "") return null;
  // 两道防线：路径谓词必须是真路径；任何字段都不接受我们自己的注入回流
  if (predicate === "path" && !isPathLike(value)) return null;
  if (isFrameworkEcho(value)) return null;
  const polarity = raw.polarity === "-" ? "-" : "+";
  const fact = {
    id: typeof raw.id === "string" && raw.id !== "" ? raw.id : newFactId(now),
    subject,
    predicate,
    value,
    polarity,
    confidence: Number.isFinite(raw.confidence) ? Math.max(0, Math.min(1, Number(raw.confidence))) : 0.8,
    validFrom: Number.isFinite(raw.validFrom) ? Number(raw.validFrom) : now,
    validUntil: Number.isFinite(raw.validUntil) ? Number(raw.validUntil) : null,
    supersededBy: typeof raw.supersededBy === "string" ? raw.supersededBy : null,
    replaces: typeof raw.replaces === "string" ? raw.replaces : null,
    source: typeof raw.source === "string" ? raw.source : "manual",
    sourceEntryIds: Array.isArray(raw.sourceEntryIds) ? raw.sourceEntryIds.filter((id) => typeof id === "string").slice(0, 8) : [],
    t: Number.isFinite(raw.t) ? Number(raw.t) : now,
    lastSeen: Number.isFinite(raw.lastSeen) ? Number(raw.lastSeen) : now,
    seen: Number.isFinite(raw.seen) ? Number(raw.seen) : 1,
  };
  fact.slot = factSlot(fact);
  return fact;
}

/** 是否仍然有效。 */
export function isActive(fact, now = Date.now()) {
  if (fact === null || typeof fact !== "object") return false;
  if (fact.validUntil !== null && fact.validUntil !== undefined && Number(fact.validUntil) <= now) return false;
  return true;
}

const sameValue = (a, b) => normalizeValue(a).toLowerCase() === normalizeValue(b).toLowerCase();

/**
 * 冲突消解：给一批新事实，算出要对现有事实做哪些动作。
 * @param {Array} activeFacts 当前有效的事实
 * @param {Array} incoming 新抽到的事实（未归一化也可）
 * @param {number} [now]
 * @returns {{ puts: Array, retires: Array, touches: Array }}
 */
export function resolveFacts(activeFacts, incoming, now = Date.now()) {
  const puts = [];
  const retires = [];
  const touches = [];
  const bySlot = new Map();
  const byValue = new Map();
  for (const fact of activeFacts) {
    if (!isActive(fact, now)) continue;
    bySlot.set(fact.slot, fact);
    byValue.set(`${fact.subject}/${fact.predicate}/${normalizeValue(fact.value).toLowerCase()}`, fact);
  }

  for (const raw of incoming) {
    const fact = normalizeFact(raw, now);
    if (fact === null) continue;

    // 否定事实：让匹配的正面事实失效，自己也不长期留存
    if (fact.polarity === "-") {
      const target = byValue.get(`${fact.subject}/${fact.predicate}/${normalizeValue(fact.value).toLowerCase()}`)
        // 「别叫我老王」也要能命中「要求全程离线」这类口语变体
        ?? [...byValue.values()].find(
          (candidate) =>
            candidate.subject === fact.subject
            && candidate.predicate === fact.predicate
            && (MULTI_VALUED.has(fact.predicate) ? sameFactValue(candidate.value, fact.value) : sameValue(candidate.value, fact.value)),
        );
      if (target !== undefined) {
        retires.push({ fact: target, supersededBy: fact.id, reason: "negated" });
        bySlot.delete(target.slot);
        byValue.delete(`${target.subject}/${target.predicate}/${normalizeValue(target.value).toLowerCase()}`);
      }
      // 单值槽位上的否定：等于把该槽位整体作废（"以后别叫我老王" 而当前就是老王）
      const slotFact = bySlot.get(fact.slot);
      if (slotFact !== undefined && MULTI_VALUED.has(fact.predicate) === false && sameValue(slotFact.value, fact.value)) {
        retires.push({ fact: slotFact, supersededBy: fact.id, reason: "negated-slot" });
        bySlot.delete(fact.slot);
      }
      puts.push({ ...fact, validUntil: now });
      continue;
    }

    // 多值谓词：先按「同一件事」判重，避免「全程离线」与「要求全程离线」并存
    if (MULTI_VALUED.has(fact.predicate)) {
      const twin = [...byValue.values()].find(
        (candidate) =>
          candidate.subject === fact.subject
          && candidate.predicate === fact.predicate
          && sameFactValue(candidate.value, fact.value),
      );
      if (twin !== undefined) {
        touches.push(twin);
        continue;
      }
    }

    const existing = bySlot.get(fact.slot);
    if (existing === undefined) {
      puts.push(fact);
      bySlot.set(fact.slot, fact);
      byValue.set(`${fact.subject}/${fact.predicate}/${normalizeValue(fact.value).toLowerCase()}`, fact);
      continue;
    }
    if (sameValue(existing.value, fact.value)) {
      touches.push(existing);
      continue;
    }
    // 同槽位不同值 → 旧的失效
    retires.push({ fact: existing, supersededBy: fact.id, reason: "superseded" });
    puts.push({ ...fact, replaces: existing.id });
    bySlot.set(fact.slot, fact);
    byValue.set(`${fact.subject}/${fact.predicate}/${normalizeValue(fact.value).toLowerCase()}`, fact);
  }

  return { puts, retires, touches };
}

/**
 * 把事实投影成人设框架（与 profile.json 手工内容合并，手工内容优先补空缺）。
 * @param {object} profile 手工维护的框架
 * @param {Array} facts 全部事实
 * @param {number} [now]
 */
export function composeFrame(profile, facts, now = Date.now()) {
  const base = {
    user: { ...(profile?.user ?? {}) },
    self: { ...(profile?.self ?? {}) },
    personality: [...(profile?.personality ?? [])],
    preferences: [...(profile?.preferences ?? [])],
    events: [...(profile?.events ?? [])],
    notes: profile?.notes ?? "",
    sources: [],
  };
  if (!Array.isArray(base.user.nicknames)) base.user.nicknames = [];

  const active = (Array.isArray(facts) ? facts : []).filter((fact) => isActive(fact, now) && fact.polarity !== "-");
  const values = (subject, predicate) => active.filter((fact) => fact.subject === subject && fact.predicate === predicate).map((fact) => fact.value);
  const newest = (list) => (list.length > 0 ? list[list.length - 1] : "");

  const names = values("user", "name");
  if (names.length > 0) base.user.name = newest(names);

  const nicknames = values("user", "nickname");
  if (nicknames.length > 0) {
    const merged = [...new Set([...base.user.nicknames, ...nicknames])].slice(-12);
    base.user.nicknames = merged;
  }

  const calledBy = values("user", "calledBy");
  if (calledBy.length > 0) base.user.calledBy = newest(calledBy);

  const persona = values("assistant", "persona");
  if (persona.length > 0) base.self.persona = newest(persona);

  const role = values("assistant", "role");
  if (role.length > 0) base.self.role = newest(role);

  const assistantName = values("assistant", "name");
  if (assistantName.length > 0) base.self.name = newest(assistantName);

  /**
   * 合并两组同类值，按「同一件事」判重而不是字符串相等。
   *
   * profile.json 里可能还留着早年手填的「要求全程离线不联网」，
   * 而事实层归纳出的是「全程离线不联网」——字符串不同、意思一样，
   * 如果只做 Set 去重，框架里就会并排出现两条。这里保留更简洁的写法。
   */
  const mergeValues = (existing, incoming, limit) => {
    const merged = [];
    // 先放事实（较新、较干净），再补 profile 里人工填的
    for (const value of [...incoming, ...existing]) {
      const text = normalizeValue(value);
      if (text === "") continue;
      const twin = merged.findIndex((current) => sameFactValue(current, text));
      if (twin >= 0) {
        // 两者同一件事：留下更短的那个（通常剥掉了「要求/希望」这类引导词）
        if (text.length < merged[twin].length) merged[twin] = text;
        continue;
      }
      merged.push(text);
    }
    return merged.slice(-limit);
  };

  const traits = values("user", "personality");
  base.personality = mergeValues(base.personality, traits, 30);

  const preferences = values("user", "preference");
  // 同一个短语不该同时出现在性格和偏好里：模型常把「需求推进快」两处都填。
  // 性格先占位（它描述的是"是什么样的人"），偏好里去掉重复项。
  const preferenceValues = preferences.filter(
    (value) => !base.personality.some((trait) => sameFactValue(trait, value)),
  );
  base.preferences = mergeValues(base.preferences, preferenceValues, 50);

  // 项目目录：多值事实，但注入时只带最近几条，否则十几条路径会把框架撑满
  const paths = active
    .filter((fact) => fact.subject === "env" && fact.predicate === "path")
    .sort((a, b) => Number(b.lastSeen ?? b.t) - Number(a.lastSeen ?? a.t))
    .map((fact) => fact.value);
  base.paths = [...new Set(paths)].slice(0, 3);

  return base;
}

/** 面板/调试用的一行事实描述。 */
export function renderFactLine(fact, now = Date.now()) {
  const subject = subjectLabel(fact.subject);
  const label = predicateLabel(fact.predicate);
  const negative = fact.polarity === "-" ? "（已否定）" : "";
  const dead = isActive(fact, now) ? "" : "（已失效）";
  const d = new Date(fact.validFrom);
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const head = [subject, label].filter(Boolean).join(" · ");
  return `${head}：${clampText(fact.value, 60)}${negative}${dead} ｜ ${stamp} ｜ ${fact.id}`;
}
