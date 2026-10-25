/**
 * mnemosyne — Web 面板（Client 半）。
 *
 * 侧栏底部一个「Mnemosyne」入口，点开是全屏面板：
 *  · 记忆：搜索 / 按事件类型筛选 / 展开原文 / 手动记一条 / 删除
 *  · 人设框架：称呼、昵称、AI 人设、性格、偏好、重要事件（可编辑保存）
 *  · 召回预览：输入一句话，看这次对话实际会注入哪些记忆（调试与信任都靠它）
 *
 * 全部数据通过 Host 的 /mnemosyne/api/* 读写；样式只用 --dsw-alias-* 主题变量。
 */
window.__ModuleLoader__.load({
  id: "dsh-mnemosyne",
  factory(require) {
    const React = require("react");
    const {
      useCallback,
      useEffect,
      useMemo,
      useRef,
      useState,
      useSyncExternalStore,
    } = React;
    const h = React.createElement;

    const API = "/mnemosyne/api";
    const NS = "dsh-mnemosyne";

    const zh = {
      "footer.label": "记忆女神",
      "footer.aria": "打开记忆女神",
      "panel.title": "记忆女神",
      "panel.close": "关闭",
      "tab.entries": "记忆",
      "tab.profile": "人设框架",
      "tab.facts": "事实",
      "tab.preview": "召回预览",
      "search.placeholder": "搜索记忆：关键词、项目名、事件…",
      "search.button": "搜索",
      "search.clear": "清空",
      "filter.all": "全部",
      "empty.search": "没有匹配的记忆",
      "empty.list": "这里还是空的：聊几轮，或手动记一条",
      "empty.detail": "选择左侧一条记忆查看原文",
      "btn.expand": "展开原文",
      "btn.collapse": "收起",
      "btn.delete": "删除",
      "btn.confirmDelete": "确认删除",
      "note.title": "手动记一条",
      "note.placeholder": "要长期记住的事：结论、决定、偏好、约定…",
      "note.save": "记入记忆",
      "note.saved": "已记入记忆",
      "profile.userName": "用户名字",
      "profile.nicknames": "昵称（逗号分隔）",
      "profile.calledBy": "AI 对用户的称呼",
      "profile.tone": "相处基调",
      "profile.persona": "AI 人设",
      "profile.role": "AI 角色",
      "profile.personality": "用户性格（逗号分隔）",
      "profile.preferences": "用户偏好（逗号分隔）",
      "profile.notes": "补充备注",
      "profile.events": "重要事件节点",
      "profile.eventPlaceholder": "例如：2026-10-18 完成 Mnemosyne 插件第一版",
      "profile.addEvent": "添加事件",
      "profile.save": "保存框架",
      "profile.saved": "已保存",
      "persona.rebuild": "让 AI 重新归纳",
      "persona.running": "正在归纳…",
      "persona.done": "框架已更新（+{n} 条事实）",
      "persona.last": "上次归纳：{time}",
      "persona.auto": "框架会随对话自动生成，这里可以手动修正。",
      "preview.placeholder": "输入一句你可能会问的话，看会注入哪些记忆…",
      "preview.button": "生成预览",
      "preview.hint": "这里显示的是 Mnemosyne 在真实对话里注入给 AI 的完整文本。",
      "preview.chars": "字符数",
      "stat.count": "条记忆",
      "stat.dir": "数据目录",
      "stat.pending": "总结中",
      "kind.identity": "人设",
      "kind.decision": "决策",
      "kind.event": "事件",
      "kind.task": "任务",
      "kind.emotion": "情绪",
      "kind.knowledge": "知识",
      "kind.chat": "闲聊",
      "label.user": "用户",
      "label.ai": "AI",
      "label.keywords": "关键词",
      "label.entities": "对象",
      "label.source": "来源",
      "source.rule": "规则摘要",
      "source.llm": "模型总结",
      "source.manual": "手动记录",
      "msg.loading": "加载中…",
      "msg.error": "操作失败：{message}",
      "msg.total": "命中 {n} 条",
      "import.btn": "导入历史",
      "import.running": "导入中",
      "import.done": "已导入 {n} 条历史记忆",
      "consolidate.btn": "固化",
      "consolidate.running": "固化中…",
      "consolidate.done": "固化完成：合并 {m} / 摘要 {d} / 归档 {a}",
      "facts.empty": "还没有记录任何稳定事实。聊到「叫我老王」「我喜欢简洁」这类内容时会自动记下来。",
      "facts.showAll": "含已失效",
      "facts.activeOnly": "只看生效中",
      "facts.retire": "让它失效",
    };

    const en = {
      "footer.label": "Mnemosyne",
      "footer.aria": "Open Mnemosyne",
      "panel.title": "Mnemosyne",
      "panel.close": "Close",
      "tab.entries": "Memories",
      "tab.profile": "Persona",
      "tab.facts": "Facts",
      "tab.preview": "Recall preview",
      "search.placeholder": "Search memories: keywords, projects, events…",
      "search.button": "Search",
      "search.clear": "Clear",
      "filter.all": "All",
      "empty.search": "No matching memories",
      "empty.list": "The vault is empty. Chat a few turns, or add one manually.",
      "empty.detail": "Pick a memory on the left to read it",
      "btn.expand": "Read",
      "btn.collapse": "Collapse",
      "btn.delete": "Delete",
      "btn.confirmDelete": "Confirm delete",
      "note.title": "Remember something",
      "note.placeholder": "Conclusions, decisions, preferences, agreements…",
      "note.save": "Save to vault",
      "note.saved": "Saved",
      "profile.userName": "User name",
      "profile.nicknames": "Nicknames (comma separated)",
      "profile.calledBy": "How the AI addresses the user",
      "profile.tone": "Tone",
      "profile.persona": "AI persona",
      "profile.role": "AI role",
      "profile.personality": "User traits (comma separated)",
      "profile.preferences": "User preferences (comma separated)",
      "profile.notes": "Notes",
      "profile.events": "Key events",
      "profile.eventPlaceholder": "e.g. 2026-10-18 shipped memory vault v1",
      "profile.addEvent": "Add event",
      "profile.save": "Save persona",
      "profile.saved": "Saved",
      "persona.rebuild": "Let AI re-derive",
      "persona.running": "Deriving…",
      "persona.done": "Framework updated (+{n} facts)",
      "persona.last": "Last derived: {time}",
      "persona.auto": "The framework grows from conversations; edit here to correct it.",
      "preview.placeholder": "Type a question you might ask, to see what would be injected…",
      "preview.button": "Preview",
      "preview.hint": "This is the exact text the vault injects during a real conversation.",
      "preview.chars": "Characters",
      "stat.count": "memories",
      "stat.dir": "Data directory",
      "stat.pending": "summarizing",
      "kind.identity": "Persona",
      "kind.decision": "Decision",
      "kind.event": "Event",
      "kind.task": "Task",
      "kind.emotion": "Emotion",
      "kind.knowledge": "Knowledge",
      "kind.chat": "Chat",
      "label.user": "User",
      "label.ai": "AI",
      "label.keywords": "Keywords",
      "label.entities": "Entities",
      "label.source": "Source",
      "source.rule": "Rule summary",
      "source.llm": "Model summary",
      "source.manual": "Manual",
      "msg.loading": "Loading…",
      "msg.error": "Failed: {message}",
      "msg.total": "{n} matches",
      "import.btn": "Import history",
      "import.running": "Importing",
      "import.done": "Imported {n} memories",
      "consolidate.btn": "Consolidate",
      "consolidate.running": "Consolidating…",
      "consolidate.done": "Done: merged {m} / digests {d} / archived {a}",
      "facts.empty": "No stable facts yet. Say things like \"call me Lao Wang\" and they get recorded.",
      "facts.showAll": "Show retired",
      "facts.activeOnly": "Active only",
      "facts.retire": "Retire",
    };

    const KIND_ORDER = ["identity", "decision", "event", "task", "knowledge", "emotion", "chat"];

    // ── 共享面板开关 ────────────────────────────────────────────────────────
    const panelStore = {
      open: false,
      listeners: new Set(),
      getSnapshot: () => panelStore.open,
      subscribe: (fn) => {
        panelStore.listeners.add(fn);
        return () => panelStore.listeners.delete(fn);
      },
      set: (open) => {
        if (panelStore.open === open) return;
        panelStore.open = open;
        for (const fn of [...panelStore.listeners]) fn();
      },
    };

    // ── Host API ────────────────────────────────────────────────────────────
    async function callApi(path, payload) {
      const init = payload === undefined
        ? { method: "GET", headers: { accept: "application/json" } }
        : {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          };
      let response;
      try {
        response = await fetch(API + path, init);
      } catch (error) {
        return { ok: false, error: String(error && error.message ? error.message : error) };
      }
      let data;
      try {
        data = await response.json();
      } catch {
        data = { ok: false, error: `HTTP ${response.status}` };
      }
      return data;
    }

    // ── 样式 ────────────────────────────────────────────────────────────────
    const TOKEN = {
      bgBase: "var(--dsw-alias-bg-base)",
      layer1: "var(--dsw-alias-bg-layer-1)",
      layer2: "var(--dsw-alias-bg-layer-2)",
      overlay: "var(--dsw-alias-bg-overlay)",
      border1: "var(--dsw-alias-border-l1)",
      border2: "var(--dsw-alias-border-l2)",
      label1: "var(--dsw-alias-label-primary)",
      label2: "var(--dsw-alias-label-secondary)",
      brand: "var(--dsw-alias-brand-primary)",
      error: "var(--dsw-alias-state-error-primary)",
      idle: "var(--dsw-alias-state-idle-primary)",
      success: "var(--dsw-alias-state-success-primary)",
      warn: "var(--dsw-alias-state-warn-primary)",
    };

    const KIND_COLOR = {
      identity: TOKEN.brand,
      decision: TOKEN.warn,
      event: TOKEN.success,
      task: TOKEN.brand,
      knowledge: TOKEN.label2,
      emotion: TOKEN.error,
      chat: TOKEN.idle,
    };

    const styles = {
      overlay: {
        position: "fixed",
        inset: 0,
        zIndex: 5000,
        // shell.overlay 图层默认是 click-through，条目必须自己 opt-in，
        // 否则面板看得见但点不到（点击会穿透到下面的应用）。
        pointerEvents: "auto",
        background: "rgba(0,0,0,0.42)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      },
      panel: {
        width: "min(940px, calc(100vw - 32px))",
        height: "min(720px, calc(100vh - 64px))",
        background: TOKEN.bgBase,
        border: `1px solid ${TOKEN.border1}`,
        borderRadius: 14,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        boxShadow: "0 18px 60px rgba(0,0,0,0.35)",
        color: TOKEN.label1,
        fontSize: 13,
      },
      header: {
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "14px 18px",
        borderBottom: `1px solid ${TOKEN.border1}`,
        background: TOKEN.layer1,
      },
      title: { fontSize: 15, fontWeight: 600, margin: 0 },
      stats: { display: "flex", gap: 14, color: TOKEN.label2, fontSize: 12, marginLeft: "auto", alignItems: "center" },
      iconButton: {
        border: "none",
        background: "transparent",
        color: TOKEN.label2,
        cursor: "pointer",
        fontSize: 18,
        lineHeight: 1,
        padding: "4px 8px",
        borderRadius: 6,
      },
      tabs: {
        display: "flex",
        gap: 4,
        padding: "8px 14px 0",
        borderBottom: `1px solid ${TOKEN.border1}`,
        background: TOKEN.layer1,
      },
      tab: (active) => ({
        border: "none",
        borderBottom: active ? `2px solid ${TOKEN.brand}` : "2px solid transparent",
        background: "transparent",
        color: active ? TOKEN.label1 : TOKEN.label2,
        cursor: "pointer",
        padding: "8px 12px",
        fontSize: 13,
        fontWeight: active ? 600 : 400,
        marginBottom: -1,
      }),
      body: { flex: 1, minHeight: 0, display: "flex", overflow: "hidden" },
      column: { display: "flex", flexDirection: "column", minHeight: 0 },
      scroll: { flex: 1, overflowY: "auto", padding: 14 },
      listPane: { width: "44%", minWidth: 240, borderRight: `1px solid ${TOKEN.border1}`, display: "flex", flexDirection: "column", minHeight: 0 },
      detailPane: { flex: 1, display: "flex", flexDirection: "column", minHeight: 0, background: TOKEN.layer1 },
      toolbar: { display: "flex", gap: 8, padding: "10px 14px", borderBottom: `1px solid ${TOKEN.border1}`, background: TOKEN.layer1 },
      input: {
        flex: 1,
        minWidth: 0,
        background: TOKEN.layer2,
        border: `1px solid ${TOKEN.border1}`,
        borderRadius: 8,
        color: TOKEN.label1,
        padding: "7px 10px",
        fontSize: 13,
        outline: "none",
      },
      textarea: {
        width: "100%",
        boxSizing: "border-box",
        minHeight: 90,
        resize: "vertical",
        background: TOKEN.layer2,
        border: `1px solid ${TOKEN.border1}`,
        borderRadius: 8,
        color: TOKEN.label1,
        padding: "8px 10px",
        fontSize: 13,
        fontFamily: "inherit",
        outline: "none",
      },
      button: {
        border: `1px solid ${TOKEN.border2}`,
        background: TOKEN.layer2,
        color: TOKEN.label1,
        borderRadius: 8,
        padding: "6px 12px",
        fontSize: 12.5,
        cursor: "pointer",
        whiteSpace: "nowrap",
      },
      primaryButton: {
        border: "1px solid transparent",
        background: TOKEN.brand,
        color: "#fff",
        borderRadius: 8,
        padding: "6px 14px",
        fontSize: 12.5,
        cursor: "pointer",
        whiteSpace: "nowrap",
      },
      dangerButton: {
        border: `1px solid ${TOKEN.error}`,
        background: "transparent",
        color: TOKEN.error,
        borderRadius: 8,
        padding: "6px 12px",
        fontSize: 12.5,
        cursor: "pointer",
      },
      card: (active) => ({
        padding: "10px 12px",
        border: `1px solid ${active ? TOKEN.brand : TOKEN.border1}`,
        background: active ? TOKEN.layer2 : TOKEN.layer1,
        borderRadius: 10,
        marginBottom: 8,
        cursor: "pointer",
      }),
      row: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
      badge: (kind) => ({
        fontSize: 11,
        lineHeight: 1.5,
        padding: "0 6px",
        borderRadius: 5,
        color: KIND_COLOR[kind] ?? TOKEN.label2,
        border: `1px solid ${KIND_COLOR[kind] ?? TOKEN.border1}`,
        background: "transparent",
      }),
      muted: { color: TOKEN.label2, fontSize: 12 },
      summary: { margin: "4px 0 0", lineHeight: 1.55, color: TOKEN.label1 },
      keywords: { marginTop: 6, color: TOKEN.label2, fontSize: 11.5 },
      field: { marginBottom: 12 },
      fieldLabel: { display: "block", marginBottom: 5, color: TOKEN.label2, fontSize: 12 },
      chip: {
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        border: `1px solid ${TOKEN.border1}`,
        background: TOKEN.layer2,
        borderRadius: 999,
        padding: "2px 4px 2px 10px",
        fontSize: 12,
        marginRight: 6,
        marginBottom: 6,
      },
      chipX: { border: "none", background: "transparent", color: TOKEN.label2, cursor: "pointer", fontSize: 13, padding: "0 4px" },
      pre: {
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        background: TOKEN.layer2,
        border: `1px solid ${TOKEN.border1}`,
        borderRadius: 10,
        padding: 12,
        fontSize: 12.5,
        lineHeight: 1.65,
        margin: 0,
        color: TOKEN.label1,
      },
      toast: {
        position: "sticky",
        bottom: 8,
        margin: "0 14px 10px",
        padding: "8px 12px",
        borderRadius: 8,
        background: TOKEN.layer2,
        border: `1px solid ${TOKEN.border1}`,
        color: TOKEN.label2,
        fontSize: 12,
      },
    };

    // ── 小工具 ──────────────────────────────────────────────────────────────
    const pad = (n) => String(n).padStart(2, "0");
    function fmtTime(ts) {
      const d = new Date(Number(ts) || 0);
      if (!Number.isFinite(d.getTime())) return "";
      const today = new Date();
      const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
      const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
      return sameDay ? `今天 ${time}` : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
    }

    const splitList = (value) =>
      String(value ?? "")
        .split(/[,，、\n]/)
        .map((s) => s.trim())
        .filter(Boolean);

    // ── 记忆列表项 ──────────────────────────────────────────────────────────
    function EntryRow({ entry, active, onClick, t }) {
      return h("div", { style: styles.card(active), onClick },
        h("div", { style: styles.row },
          h("span", { style: styles.badge(entry.kind) }, t(`kind.${entry.kind}`)),
          h("span", { style: styles.muted }, fmtTime(entry.time)),
          entry.source === "manual" ? h("span", { style: styles.badge("identity") }, t("source.manual")) : null
        ),
        h("p", { style: styles.summary }, entry.summary || entry.user || ""),
        Array.isArray(entry.keywords) && entry.keywords.length > 0
          ? h("div", { style: styles.keywords }, `${t("label.keywords")}：${entry.keywords.slice(0, 5).join("、")}`)
          : null
      );
    }

    // ── 记忆详情 ────────────────────────────────────────────────────────────
    function EntryDetail({ detail, onDelete, t }) {
      const [confirming, setConfirming] = useState(false);
      useEffect(() => setConfirming(false), [detail?.id]);
      if (detail === null || detail === undefined) {
        return h("div", { style: { ...styles.scroll, color: TOKEN.label2 } }, t("empty.detail"));
      }
      const entry = detail.entry ?? detail;
      return h("div", { style: styles.column },
        h("div", { style: styles.toolbar },
          h("span", { style: styles.badge(entry.kind) }, t(`kind.${entry.kind}`)),
          h("span", { style: styles.muted }, fmtTime(entry.t ?? entry.time)),
          h("span", { style: { ...styles.muted, marginLeft: "auto" } }, `${t("label.source")}：${t(`source.${entry.source ?? "rule"}`)}`),
          confirming
            ? h("button", { style: styles.dangerButton, onClick: () => onDelete(entry.id) }, t("btn.confirmDelete"))
            : h("button", { style: styles.button, onClick: () => setConfirming(true) }, t("btn.delete"))
        ),
        h("div", { style: styles.scroll },
          h("div", { style: styles.field },
            h("div", { style: styles.fieldLabel }, t("label.user")),
            h("pre", { style: styles.pre }, entry.user || "—")
          ),
          entry.assistant
            ? h("div", { style: styles.field },
                h("div", { style: styles.fieldLabel }, t("label.ai")),
                h("pre", { style: styles.pre }, entry.assistant)
              )
            : null,
          Array.isArray(entry.keywords) && entry.keywords.length > 0
            ? h("div", { style: styles.field },
                h("div", { style: styles.fieldLabel }, t("label.keywords")),
                h("div", null, ...entry.keywords.map((k) => h("span", { key: k, style: styles.chip }, k)))
              )
            : null,
          Array.isArray(entry.entities) && entry.entities.length > 0
            ? h("div", { style: styles.field },
                h("div", { style: styles.fieldLabel }, t("label.entities")),
                h("div", null, ...entry.entities.map((k) => h("span", { key: k, style: styles.chip }, k)))
              )
            : null,
          h("div", { style: styles.muted }, `id：${entry.id}`),
          entry.sessionTitle ? h("div", { style: { ...styles.muted, marginTop: 4 } }, `会话：${entry.sessionTitle}`) : null
        )
      );
    }

    // ── 标签编辑（性格/偏好） ───────────────────────────────────────────────
    function ListField({ label, values, onChange, t }) {
      const [draft, setDraft] = useState("");
      const add = () => {
        const items = splitList(draft);
        if (items.length === 0) return;
        const next = [...values];
        for (const item of items) if (!next.includes(item)) next.push(item);
        onChange(next);
        setDraft("");
      };
      return h("div", { style: styles.field },
        h("label", { style: styles.fieldLabel }, label),
        h("div", null, ...values.map((value, i) => h("span", { key: `${value}-${i}`, style: styles.chip },
          value,
          h("button", { style: styles.chipX, onClick: () => onChange(values.filter((_, j) => j !== i)), "aria-label": "remove" }, "×")
        ))),
        h("div", { style: { display: "flex", gap: 8 } },
          h("input", {
            style: styles.input,
            value: draft,
            placeholder: label,
            onChange: (e) => setDraft(e.target.value),
            onKeyDown: (e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            },
          }),
          h("button", { style: styles.button, onClick: add }, "+")
        )
      );
    }

    // ── 人设框架 ────────────────────────────────────────────────────────────
    function ProfilePane({ profile, onSave, t, persona, onRebuild }) {
      const [form, setForm] = useState(profile);
      const [eventDraft, setEventDraft] = useState("");
      useEffect(() => setForm(profile), [profile]);
      if (form === null || form === undefined) return h("div", { style: styles.scroll }, t("msg.loading"));

      const field = (key, label, valuePath, multiline = false) => {
        const read = () => (valuePath === "user" ? form.user?.[key] : valuePath === "self" ? form.self?.[key] : form[key]) ?? "";
        const write = (value) => {
          setForm((prev) => {
            if (valuePath === "user") return { ...prev, user: { ...prev.user, [key]: value } };
            if (valuePath === "self") return { ...prev, self: { ...prev.self, [key]: value } };
            return { ...prev, [key]: value };
          });
        };
        return h("div", { style: styles.field },
          h("label", { style: styles.fieldLabel }, label),
          multiline
            ? h("textarea", { style: styles.textarea, value: read(), onChange: (e) => write(e.target.value) })
            : h("input", { style: styles.input, value: read(), onChange: (e) => write(e.target.value) })
        );
      };

      const save = () => {
        const payload = {
          ...form,
          user: { ...form.user, nicknames: splitList(form.user?.nicknames ?? []) },
          personality: form.personality ?? [],
          preferences: form.preferences ?? [],
          events: form.events ?? [],
        };
        onSave(payload);
      };

      return h("div", { style: styles.column },
        h("div", { style: styles.toolbar },
          h("button", {
            style: styles.primaryButton,
            onClick: () => void onRebuild(),
            disabled: persona?.running === true,
          }, persona?.running === true ? t("persona.running") : t("persona.rebuild")),
          h("span", { style: { ...styles.muted, flex: 1, textAlign: "right" } },
            persona?.lastAt
              ? t("persona.last").replace("{time}", new Date(persona.lastAt).toLocaleString())
              : t("persona.auto"))
        ),
        h("div", { style: styles.scroll },
          h("div", { style: { ...styles.muted, marginBottom: 12 } },
            "框架每轮对话都会常驻注入；记忆索引按需检索。这里的称呼、性格、偏好，就是 AI 眼里「你是谁」。"),
          field("name", t("profile.userName"), "user"),
          h("div", { style: styles.field },
            h("label", { style: styles.fieldLabel }, t("profile.nicknames")),
            h("input", {
              style: styles.input,
              value: (form.user?.nicknames ?? []).join("，"),
              onChange: (e) => setForm((prev) => ({ ...prev, user: { ...prev.user, nicknames: splitList(e.target.value) } })),
            })
          ),
          field("calledBy", t("profile.calledBy"), "user"),
          field("tone", t("profile.tone"), "user"),
          field("persona", t("profile.persona"), "self", true),
          field("role", t("profile.role"), "self"),
          h(ListField, {
            label: t("profile.personality"),
            values: form.personality ?? [],
            onChange: (values) => setForm((prev) => ({ ...prev, personality: values })),
            t,
          }),
          h(ListField, {
            label: t("profile.preferences"),
            values: form.preferences ?? [],
            onChange: (values) => setForm((prev) => ({ ...prev, preferences: values })),
            t,
          }),
          field("notes", t("profile.notes"), "plain", true),
          h("div", { style: styles.field },
            h("label", { style: styles.fieldLabel }, t("profile.events")),
            ...(form.events ?? []).slice().reverse().map((event, i, arr) =>
              h("div", { key: `${event.t}-${i}`, style: { ...styles.chip, display: "flex", justifyContent: "space-between" } },
                h("span", null, `${fmtTime(event.t)} · ${event.text}`),
                h("button", {
                  style: styles.chipX,
                  onClick: () => {
                    const targetIndex = (form.events ?? []).length - 1 - i;
                    setForm((prev) => ({ ...prev, events: (prev.events ?? []).filter((_, j) => j !== targetIndex) }));
                  },
                  "aria-label": "remove",
                }, "×")
              )
            ),
            h("div", { style: { display: "flex", gap: 8 } },
              h("input", {
                style: styles.input,
                value: eventDraft,
                placeholder: t("profile.eventPlaceholder"),
                onChange: (e) => setEventDraft(e.target.value),
                onKeyDown: (e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    const text = eventDraft.trim();
                    if (text === "") return;
                    setForm((prev) => ({ ...prev, events: [...(prev.events ?? []), { t: Date.now(), text, kind: "event" }] }));
                    setEventDraft("");
                  }
                },
              }),
              h("button", {
                style: styles.button,
                onClick: () => {
                  const text = eventDraft.trim();
                  if (text === "") return;
                  setForm((prev) => ({ ...prev, events: [...(prev.events ?? []), { t: Date.now(), text, kind: "event" }] }));
                  setEventDraft("");
                },
              }, t("profile.addEvent"))
            )
          )
        ),
        h("div", { style: styles.toolbar },
          h("span", { style: styles.muted }, form.updatedAt ? `更新于 ${fmtTime(form.updatedAt)}` : ""),
          h("button", { style: { ...styles.primaryButton, marginLeft: "auto" }, onClick: save }, t("profile.save"))
        )
      );
    }

    // ── 召回预览 ────────────────────────────────────────────────────────────
    function PreviewPane({ t, onError }) {
      const [query, setQuery] = useState("");
      const [text, setText] = useState("");
      const [busy, setBusy] = useState(false);

      const run = async () => {
        setBusy(true);
        const data = await callApi("/preview", { query });
        setBusy(false);
        if (data.ok) setText(data.text ?? "");
        else onError(data.error);
      };

      return h("div", { style: styles.column },
        h("div", { style: styles.toolbar },
          h("input", {
            style: styles.input,
            value: query,
            placeholder: t("preview.placeholder"),
            onChange: (e) => setQuery(e.target.value),
            onKeyDown: (e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void run();
              }
            },
          }),
          h("button", { style: styles.primaryButton, onClick: () => void run(), disabled: busy }, t("preview.button"))
        ),
        h("div", { style: { ...styles.muted, padding: "8px 14px 0" } }, t("preview.hint")),
        h("div", { style: styles.scroll },
          text
            ? h("pre", { style: styles.pre }, text)
            : h("div", { style: styles.muted }, busy ? t("msg.loading") : "")
        ),
        text ? h("div", { style: styles.toast }, `${t("preview.chars")}：${text.length}`) : null
      );
    }

    // ── 记忆面板 ────────────────────────────────────────────────────────────
    function EntriesPane({ t, onError, onToast }) {
      const [data, setData] = useState(null);
      const [list, setList] = useState([]);
      const [query, setQuery] = useState("");
      const [kind, setKind] = useState("");
      const [detail, setDetail] = useState(null);
      const [noteOpen, setNoteOpen] = useState(false);
      const [noteText, setNoteText] = useState("");
      const [busy, setBusy] = useState(false);
      const [importState, setImportState] = useState(null);
      const [consolidating, setConsolidating] = useState(false);

      /** 手动触发一次固化（合并重复 / 生成摘要 / 归档旧记忆）。 */
      const runConsolidate = async () => {
        if (consolidating) return;
        setConsolidating(true);
        const data = await callApi("/consolidate", {});
        setConsolidating(false);
        if (!data.ok) return onError(data.error);
        onToast?.(
          t("consolidate.done")
            .replace("{m}", String(data.merged ?? 0))
            .replace("{d}", String(data.digests ?? 0))
            .replace("{a}", String(data.archived ?? 0)),
        );
        void refresh();
      };

      const refresh = useCallback(async () => {
        const params = new URLSearchParams({ limit: "60" });
        if (kind !== "") params.set("kind", kind);
        const data = await callApi(`/entries?${params.toString()}`);
        if (data.ok) setList(data.entries ?? []);
        else onError(data.error);
      }, [kind, onError]);

      useEffect(() => {
        void (async () => {
          const summary = await callApi("/summary");
          if (summary.ok) setData(summary);
          else onError(summary.error);
        })();
      }, [onError]);

      useEffect(() => {
        void refresh();
      }, [refresh]);

      const doSearch = async () => {
        if (query.trim() === "") {
          setDetail(null);
          void refresh();
          return;
        }
        setBusy(true);
        const data = await callApi("/search", { query, limit: 30 });
        setBusy(false);
        if (data.ok) setList((data.hits ?? []).map((hit) => ({
          id: hit.id,
          time: hit.time,
          kind: hit.kind,
          summary: hit.summary,
          keywords: hit.keywords,
          source: "rule",
        })));
        else onError(data.error);
      };

      const openDetail = async (id) => {
        const data = await callApi("/get", { id });
        if (data.ok) setDetail(data);
        else onError(data.error);
      };

      const removeEntry = async (id) => {
        const data = await callApi("/delete", { id });
        if (!data.ok) return onError(data.error);
        setDetail(null);
        void refresh();
      };

      const saveNote = async () => {
        const text = noteText.trim();
        if (text === "") return;
        setBusy(true);
        const data = await callApi("/note", { text });
        setBusy(false);
        if (!data.ok) return onError(data.error);
        setNoteText("");
        setNoteOpen(false);
        void refresh();
      };

      const startImport = async () => {
        if (importState?.running) return;
        const data = await callApi("/backfill", { maxSessions: 60, maxTurns: 30 });
        if (!data.ok) return onError(data.error);
        setImportState({ running: true, written: 0, skipped: 0, index: 0, total: 0 });
      };

      // 导入是后台任务：轮询状态直到结束
      useEffect(() => {
        if (importState?.running !== true) return undefined;
        let cancelled = false;
        const timer = setInterval(async () => {
          const data = await callApi("/backfill/status");
          if (cancelled || !data.ok) return;
          setImportState(data);
          if (data.running !== true) {
            clearInterval(timer);
            void refresh();
          }
        }, 1200);
        return () => {
          cancelled = true;
          clearInterval(timer);
        };
      }, [importState?.running, refresh]);

      const kinds = KIND_ORDER.filter((k) => {
        const counts = data?.stats?.byKind ?? {};
        return (counts[k] ?? 0) > 0;
      });

      return h(React.Fragment, null,
        h("div", { style: styles.toolbar },
          h("input", {
            style: styles.input,
            value: query,
            placeholder: t("search.placeholder"),
            onChange: (e) => setQuery(e.target.value),
            onKeyDown: (e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void doSearch();
              }
            },
          }),
          h("button", { style: styles.primaryButton, onClick: () => void doSearch(), disabled: busy }, t("search.button")),
          h("button", {
            style: styles.button,
            onClick: () => void startImport(),
            disabled: importState?.running === true,
            title: t("import.btn"),
          }, importState?.running === true
            ? `${t("import.running")} ${importState.written ?? 0}`
            : t("import.btn")),
          h("button", {
            style: styles.button,
            onClick: () => void runConsolidate(),
            disabled: consolidating,
            title: t("consolidate.btn"),
          }, consolidating ? t("consolidate.running") : t("consolidate.btn")),
          h("button", { style: styles.button, onClick: () => setNoteOpen((v) => !v) }, "＋")
        ),
        noteOpen
          ? h("div", { style: { padding: "10px 14px", borderBottom: `1px solid ${TOKEN.border1}`, background: TOKEN.layer1 } },
              h("div", { style: styles.fieldLabel }, t("note.title")),
              h("textarea", { style: styles.textarea, value: noteText, placeholder: t("note.placeholder"), onChange: (e) => setNoteText(e.target.value) }),
              h("div", { style: { display: "flex", justifyContent: "flex-end", marginTop: 8 } },
                h("button", { style: styles.primaryButton, onClick: () => void saveNote() }, t("note.save"))
              )
            )
          : null,
        h("div", { style: { display: "flex", gap: 6, padding: "8px 14px 0", flexWrap: "wrap" } },
          h("button", { style: styles.button, onClick: () => { setKind(""); setQuery(""); setDetail(null); void refresh(); } },
            `${t("filter.all")}${data?.stats?.count ? ` (${data.stats.count})` : ""}`),
          ...kinds.map((k) => h("button", {
            key: k,
            style: { ...styles.button, borderColor: kind === k ? TOKEN.brand : TOKEN.border2 },
            onClick: () => setKind(k),
          }, `${t(`kind.${k}`)} (${data.stats.byKind[k]})`))
        ),
        h("div", { style: styles.body },
          h("div", { style: styles.listPane },
            h("div", { style: styles.scroll },
              list.length === 0
                ? h("div", { style: styles.muted }, query.trim() !== "" ? t("empty.search") : t("empty.list"))
                : list.map((entry) => h(EntryRow, {
                    key: entry.id,
                    entry,
                    active: detail !== null && (detail.entry?.id ?? detail.id) === entry.id,
                    onClick: () => void openDetail(entry.id),
                    t,
                  }))
            )
          ),
          h("div", { style: styles.detailPane },
            h(EntryDetail, { detail, onDelete: (id) => void removeEntry(id), t })
          )
        )
      );
    }

    // ── 事实（语义记忆） ────────────────────────────────────────────────────
    function FactsPane({ t, onError }) {
      const [facts, setFacts] = useState([]);
      const [showAll, setShowAll] = useState(false);
      const [busy, setBusy] = useState(false);

      const load = useCallback(async () => {
        const data = await callApi(`/facts${showAll ? "?all=1" : ""}`);
        if (data.ok) setFacts(data.facts ?? []);
        else onError(data.error);
      }, [showAll, onError]);

      useEffect(() => {
        void load();
      }, [load]);

      const retract = async (id) => {
        setBusy(true);
        const data = await callApi("/facts", { action: "retract", id });
        setBusy(false);
        if (!data.ok) return onError(data.error);
        void load();
      };

      const activeCount = facts.filter((fact) => fact.validUntil === null || Number(fact.validUntil) > Date.now()).length;

      return h("div", { style: styles.column },
        h("div", { style: styles.toolbar },
          h("span", { style: styles.muted }, `${activeCount} / ${facts.length}`),
          h("button", {
            style: { ...styles.button, marginLeft: "auto" },
            onClick: () => setShowAll((value) => !value),
          }, showAll ? t("facts.activeOnly") : t("facts.showAll"))
        ),
        h("div", { style: styles.scroll },
          facts.length === 0
            ? h("div", { style: styles.muted }, t("facts.empty"))
            : facts.map((fact) => {
                const alive = fact.validUntil === null || Number(fact.validUntil) > Date.now();
                return h("div", {
                  key: fact.id,
                  style: { ...styles.card(false), cursor: "default", display: "flex", alignItems: "center", gap: 8 },
                },
                  h("span", { style: { flex: 1, lineHeight: 1.6, opacity: alive ? 1 : 0.45 } }, fact.line ?? `${fact.predicate}：${fact.value}`),
                  alive
                    ? h("button", { style: styles.chipX, title: t("facts.retire"), onClick: () => void retract(fact.id), disabled: busy }, "×")
                    : null
                );
              })
        )
      );
    }

    // ── 主面板 ──────────────────────────────────────────────────────────────
    function MemoryPanel({ open, t }) {
      const [tab, setTab] = useState("entries");
      const [profile, setProfile] = useState(null);
      const [stats, setStats] = useState(null);
      const [persona, setPersona] = useState(null);
      const [toast, setToast] = useState("");
      const toastTimer = useRef(0);

      useEffect(() => () => clearTimeout(toastTimer.current), []);

      const showError = useCallback((message) => {
        setToast((zh["msg.error"] ?? "").replace("{message}", String(message ?? "unknown")));
        clearTimeout(toastTimer.current);
        toastTimer.current = setTimeout(() => setToast(""), 4000);
      }, []);

      const showToast = useCallback((message) => {
        setToast(String(message ?? ""));
        clearTimeout(toastTimer.current);
        toastTimer.current = setTimeout(() => setToast(""), 3200);
      }, []);

      const load = useCallback(async () => {
        const data = await callApi("/summary");
        if (!data.ok) return showError(data.error);
        setProfile(data.profile ?? null);
        setStats(data.stats ?? null);
        setPersona(data.persona ?? null);
      }, [showError]);

      /** 让 AI 从记忆里重新归纳人设框架。 */
      const rebuildPersona = async () => {
        setPersona((prev) => ({ ...(prev ?? {}), running: true }));
        const data = await callApi("/persona/rebuild", {});
        setPersona(data.state ?? null);
        if (!data.ok) return showError(data.error ?? "failed");
        if (data.profile !== undefined && data.profile !== null) setProfile(data.profile);
        setToast(t("persona.done").replace("{n}", String(data.puts ?? 0)));
        clearTimeout(toastTimer.current);
        toastTimer.current = setTimeout(() => setToast(""), 3000);
      };

      useEffect(() => {
        if (open) void load();
      }, [open, load]);

      const saveProfile = async (next) => {
        const data = await callApi("/profile", { profile: next });
        if (!data.ok) return showError(data.error);
        setProfile(data.profile);
        setToast(zh["profile.saved"]);
        clearTimeout(toastTimer.current);
        toastTimer.current = setTimeout(() => setToast(""), 2500);
      };

      if (!open) return null;

      const tabButton = (key, label) => h("button", {
        key,
        style: styles.tab(tab === key),
        onClick: () => setTab(key),
      }, label);

      return h("div", { style: styles.overlay, onClick: () => panelStore.set(false) },
        h("div", { style: styles.panel, onClick: (e) => e.stopPropagation() },
          h("div", { style: styles.header },
            h("h2", { style: styles.title }, t("panel.title")),
            h("div", { style: styles.stats },
              h("span", null, `${stats?.count ?? 0} ${t("stat.count")}`),
              stats?.pendingSummaries > 0 ? h("span", null, `${t("stat.pending")} ${stats.pendingSummaries}`) : null,
              h("span", { title: stats?.dir ?? "", style: { maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
                stats?.dir ?? "")
            ),
            h("button", { style: styles.iconButton, "aria-label": t("panel.close"), onClick: () => panelStore.set(false) }, "×")
          ),
          h("div", { style: styles.tabs },
            tabButton("entries", t("tab.entries")),
            tabButton("profile", t("tab.profile")),
            tabButton("facts", t("tab.facts")),
            tabButton("preview", t("tab.preview"))
          ),
          tab === "entries" ? h(EntriesPane, { t, onError: showError, onToast: showToast }) : null,
          tab === "profile" ? h(ProfilePane, { profile, onSave: (next) => void saveProfile(next), t, persona, onRebuild: rebuildPersona }) : null,
          tab === "facts" ? h(FactsPane, { t, onError: showError }) : null,
          tab === "preview" ? h(PreviewPane, { t, onError: showError }) : null,
          toast ? h("div", { style: styles.toast }, toast) : null
        )
      );
    }

    // ── 侧栏入口 ────────────────────────────────────────────────────────────
    function FooterAction({ wide, t }) {
      return h("div", { style: { padding: "4px 8px" } },
        h("button", {
          type: "button",
          "aria-label": t("footer.aria"),
          title: t("footer.aria"),
          onClick: () => panelStore.set(true),
          style: {
            display: "flex",
            alignItems: "center",
            gap: 8,
            width: "100%",
            border: `1px solid ${TOKEN.border1}`,
            background: "transparent",
            color: TOKEN.label2,
            borderRadius: 8,
            padding: "6px 8px",
            cursor: "pointer",
            fontSize: 12.5,
          },
          onMouseEnter: (e) => { e.currentTarget.style.background = TOKEN.layer2; },
          onMouseLeave: (e) => { e.currentTarget.style.background = "transparent"; },
        },
          h("span", { style: { width: 16, height: 16, display: "inline-flex", alignItems: "center", justifyContent: "center" } },
            h("svg", { viewBox: "0 0 24 24", width: 15, height: 15, "aria-hidden": true },
              h("circle", { cx: 12, cy: 12, r: 8.2, fill: "none", stroke: "currentColor", strokeWidth: 1.7 }),
              h("circle", { cx: 12, cy: 12, r: 3.1, fill: "currentColor" }),
              h("path", { d: "M12 3.8v2.3M12 17.9v2.3M3.8 12h2.3M17.9 12h2.3", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round" })
            )
          ),
          wide ? h("span", null, t("footer.label")) : null
        )
      );
    }

    /**
     * 面板挂在 `shell.overlay`（全窗口浮层）而不是侧栏里。
     * 侧栏是带滚动容器的列，`position: fixed` 在里面会被裁剪成侧栏大小，
     * 表现就是「点了按钮什么都不显示」。
     */
    function OverlayRoot({ t }) {
      const open = useSyncExternalStore(panelStore.subscribe, panelStore.getSnapshot);
      if (!open) return null;
      return h(MemoryPanel, { open, t });
    }

    // ── 插件入口 ────────────────────────────────────────────────────────────
    const inject = ["slots", "locale"];

    function apply(ctx) {
      let dictionary = zh;
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "mnemosyne:dictionaries");
      // 用 locale 的当前语言挑字典；拿不到就退回中文
      try {
        const active = ctx.locale.get?.(NS) ?? null;
        if (active !== null && typeof active === "object") dictionary = active;
      } catch {
        /* 保持中文 */
      }
      const t = (key) => dictionary[key] ?? zh[key] ?? key;

      ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
        name: "sidebar.footer.action",
        id: "mnemosyne-footer",
        order: 31,
        locale: NS,
      }, (props) => h(FooterAction, { ...props, t })));

      // 全屏面板挂全窗口浮层：它在所有列之外，不受侧栏滚动容器裁剪
      ctx.slots.inject("shell.overlay", () => ctx.slots.register({
        name: "shell.overlay",
        id: "mnemosyne-overlay",
        order: 50,
      }, () => h(OverlayRoot, { t })));
    }

    return { inject, apply };
  },
});
