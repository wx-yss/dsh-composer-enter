window.__ModuleLoader__.load({
  id: "dsh-composer-enter",
  factory: () => {
    const selector = '[data-composer-input][contenteditable="true"]';

    function apply(ctx) {
      const listeners = new Map();

      function bind() {
        for (const element of document.querySelectorAll(selector)) {
          if (listeners.has(element)) continue;
          const listener = (event) => {
            if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) return;
            if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
            if (document.querySelector('[role="listbox"]:not([hidden])')) return;

            const editor = element.__lexicalEditor;
            const command = [...(editor?._commands?.keys?.() ?? [])]
              .find((item) => item?.type === "INSERT_LINE_BREAK_COMMAND");
            if (!command) return;

            event.preventDefault();
            event.stopImmediatePropagation();
            editor.dispatchCommand(command, false);
          };
          element.addEventListener("keydown", listener, true);
          listeners.set(element, listener);
        }
      }

      bind();
      const observer = new MutationObserver(bind);
      observer.observe(document.documentElement, { childList: true, subtree: true });
      ctx.effect(() => () => {
        observer.disconnect();
        for (const [element, listener] of listeners) {
          element.removeEventListener("keydown", listener, true);
        }
      }, "composer-enter");
    }

    return { name: "composer-enter", inject: [], apply };
  },
});
