// DSH Web 输入框按键改造：Enter 换行、Cmd/Ctrl+Enter 发送。
//
// 为什么在 document 捕获阶段拦截：
// DSH 在 Lexical 命令层注册 KEY_ENTER_COMMAND（priority 4），同优先级按注册顺序执行，
// 官方在编辑器创建时就注册好了，后注册的监听器永远排在它后面；命令对象又按身份索引，
// 自己打包一份 lexical 也拿不到同一个命令对象。因此唯一稳的做法是在事件到达编辑器之前
// 截下按键，再复用宿主自己的命令：裸 Enter 派发换行命令，Cmd/Ctrl+Enter 派发提交命令。
//
// 为什么发送要自己派发提交命令：
// 宿主的 Cmd/Ctrl+Enter 是“加速提交”，繁忙时取「繁忙时的发送行为」的互补模式——设成
// 排队发送时，这个键反而会插话进正在跑的回合。插件里 Enter 已经不给发送用了，若不接管，
// 键盘上就再也没有“排队发送”这条路。因此 Cmd/Ctrl+Enter 改派发不带加速标记的提交命令，
// 与发送按钮完全一致：繁忙时按设置排队或插话。
//
// 失败策略：裸 Enter 一旦确认来自宿主输入框，即使找不到编辑器/命令也拦下，绝不退回官方
// 提交——插件失效时“回车没反应”远好于“半截消息被发出去”；Cmd/Ctrl+Enter 相反，找不到
// 宿主命令就放行给宿主，丢掉一次发送比如实发不出去更糟。
window.__ModuleLoader__.load({
  id: "dsh-composer-enter",
  factory: () => {
    const COMPOSER = '[data-composer-input][contenteditable="true"]';
    const POPUP = '[data-trigger-menu], [role="listbox"]:not([hidden])';
    const LINE_BREAK_COMMAND = "INSERT_LINE_BREAK_COMMAND";
    const ENTER_COMMAND = "KEY_ENTER_COMMAND";
    const COMPOSITION_GRACE_MS = 10;
    const HINT_TIMEOUT_MS = 8000;
    const TAG = "[dsh-composer-enter]";
    const FAILED_HINT = "回车插件失效：Enter 已停用，请用 Cmd/Ctrl+Enter 或发送按钮";

    // 防重复安装：HMR 或重复 apply 时先清掉上一份监听。
    let teardown = null;

    function warnOnce(warned, key, message) {
      if (warned.has(key)) return;
      warned.add(key);
      console.warn(`${TAG} ${message}`);
    }

    /** 失效时给一次可见提示，避免用户以为键盘坏了。 */
    function showHint(state, text) {
      if (state.hintShown) return;
      if (typeof document.createElement !== "function" || document.body === undefined) return;
      state.hintShown = true;
      try {
        const el = document.createElement("div");
        el.setAttribute("data-dsh-composer-enter", "hint");
        el.textContent = text;
        el.style.cssText = [
          "position:fixed",
          "left:50%",
          "bottom:24px",
          "transform:translateX(-50%)",
          "z-index:2147483647",
          "max-width:min(560px,90vw)",
          "padding:8px 14px",
          "border-radius:8px",
          "background:rgba(20,20,20,.92)",
          "color:#fff",
          "font:13px/1.55 system-ui,-apple-system,sans-serif",
          "text-align:center",
          "pointer-events:none",
          "box-shadow:0 4px 16px rgba(0,0,0,.28)",
        ].join(";");
        document.body.appendChild(el);
        state.hint = el;
        const timer = setTimeout(() => {
          el.remove?.();
          if (state.hint === el) state.hint = null;
        }, HINT_TIMEOUT_MS);
        timer?.unref?.();
      } catch {
        // 提示失败不影响按键处理
      }
    }

    /** 从宿主的命令表里找命令；命令以对象身份为键，必须复用宿主那一份。 */
    function hostCommand(editor, cache, type) {
      const cached = cache.get(editor);
      if (cached?.has(type) === true) return cached.get(type);
      let found;
      try {
        for (const command of editor?._commands?.keys?.() ?? []) {
          if (command?.type === type) {
            found = command;
            break;
          }
        }
      } catch {
        found = undefined;
      }
      if (found !== undefined) {
        const bucket = cached ?? new Map();
        bucket.set(type, found);
        cache.set(editor, bucket);
      }
      return found;
    }

    /** 取出与输入框根元素匹配的宿主编辑器；不匹配时视为拿不到。 */
    function editorFor(root) {
      const editor = root.__lexicalEditor;
      if (!editor) return undefined;
      if (typeof editor.getRootElement === "function" && editor.getRootElement() !== root) return undefined;
      return editor;
    }

    /**
     * 菜单打开时的裁决：
     * - "pass"：交给菜单/宿主处理（有高亮候选的触发菜单、其它下拉）
     * - "block"：吞掉 Enter。触发菜单已打开但还没有高亮候选时，宿主的 arbitrate 会返回
     *   "pass" 并直接提交消息，这里必须拦下，否则 Enter 会意外发送
     * - "none"：没有菜单
     */
    function popupVerdict() {
      for (const node of document.querySelectorAll(POPUP)) {
        if (typeof node?.getClientRects !== "function" || node.getClientRects().length === 0) continue;
        if (node.hasAttribute?.("data-trigger-menu") !== true) return "pass";
        const listbox = node.querySelector?.('[role="listbox"]');
        return listbox?.hasAttribute?.("aria-activedescendant") === true ? "pass" : "block";
      }
      return "none";
    }

    function apply(ctx) {
      const state = { warned: new Set(), hint: null, hintShown: false };
      const compositionEnds = new WeakMap();
      const commandCache = new WeakMap();

      const onCompositionEnd = (event) => {
        const root = event.target?.closest?.(COMPOSER);
        if (root) compositionEnds.set(root, Date.now());
      };

      /**
       * Cmd/Ctrl+Enter：按发送按钮的投递模式提交（繁忙时跟随「繁忙时的发送行为」）。
       * 先派发再决定是否 preventDefault：宿主命令拿不到或抛错时放行，让宿主的加速提交兜底，
       * 至少这一次消息还能发出去。
       */
      const submit = (event, root) => {
        if (event.repeat === true) return;
        // 空草稿没有可发送的内容，放行给宿主，保留「插话发送全部排队消息」的加速语义
        if ((root.textContent ?? "").trim() === "") return;
        const editor = editorFor(root);
        if (editor === undefined) return;
        const command = hostCommand(editor, commandCache, ENTER_COMMAND);
        if (command === undefined) return;
        let handled;
        try {
          handled = editor.dispatchCommand(command, null) !== false;
        } catch (error) {
          warnOnce(state.warned, "submit", `提交命令执行失败：${String(error)}；本次交给宿主处理。`);
          return;
        }
        if (handled === false) return;
        event.preventDefault();
        event.stopPropagation();
      };

      /** 裸 Enter：一律拦下，再派发宿主的换行命令。 */
      const lineBreak = (event, root) => {
        event.preventDefault();
        event.stopPropagation();

        const editor = editorFor(root);
        if (editor === undefined) {
          warnOnce(state.warned, "editor", "找不到与输入框匹配的 Lexical 编辑器；Enter 已停用，请用 Cmd/Ctrl+Enter 或发送按钮。");
          showHint(state, FAILED_HINT);
          return;
        }

        const command = hostCommand(editor, commandCache, LINE_BREAK_COMMAND);
        if (command === undefined) {
          warnOnce(state.warned, "command", "宿主未提供 INSERT_LINE_BREAK_COMMAND；Enter 已停用，请用 Cmd/Ctrl+Enter 或发送按钮。");
          showHint(state, FAILED_HINT);
          return;
        }

        try {
          const handled = editor.dispatchCommand(command, false);
          if (handled === false) {
            warnOnce(state.warned, "unhandled", "换行命令没有被任何处理器接管；Enter 已停用，请用 Cmd/Ctrl+Enter 或发送按钮。");
            showHint(state, FAILED_HINT);
          }
        } catch (error) {
          warnOnce(state.warned, "dispatch", `换行命令执行失败：${String(error)}；Enter 已停用。`);
          showHint(state, FAILED_HINT);
        }
      };

      const onKeyDown = (event) => {
        if (event.defaultPrevented || event.key !== "Enter") return;
        if (event.altKey || event.shiftKey) return; // Shift+Enter 换行；带 Shift 的组合留给宿主快捷键
        if (typeof event.getModifierState === "function" && event.getModifierState("AltGraph")) return;
        if (event.isComposing || event.keyCode === 229) return;

        const root = event.target?.closest?.(COMPOSER);
        if (!root || root.isContentEditable === false) return;
        if (Date.now() - (compositionEnds.get(root) ?? 0) < COMPOSITION_GRACE_MS) return;
        if (root.hasAttribute?.("data-composer-composing") === true) return;

        if (event.ctrlKey === true && event.metaKey === true) return; // 双修饰组合交给宿主
        if (event.ctrlKey === true || event.metaKey === true) {
          submit(event, root);
          return;
        }

        const verdict = popupVerdict();
        if (verdict === "pass") return;
        if (verdict === "block") {
          // 菜单已弹出但还没有高亮候选：宿主会 arbitrate 出 "pass" 然后提交，必须吞掉
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        lineBreak(event, root);
      };

      teardown?.();
      document.addEventListener("keydown", onKeyDown, true);
      document.addEventListener("compositionend", onCompositionEnd, true);

      const detach = () => {
        document.removeEventListener("keydown", onKeyDown, true);
        document.removeEventListener("compositionend", onCompositionEnd, true);
        state.hint?.remove?.();
        state.hint = null;
        if (teardown === detach) teardown = null;
      };
      teardown = detach;
      ctx.effect(() => detach, "composer-enter");
    }

    return { name: "composer-enter", inject: [], apply };
  },
});
