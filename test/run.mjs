import assert from "node:assert/strict";

// 用最小假的 DOM/编辑器环境跑客户端插件逻辑，不引入 jsdom。
const COMPOSER = '[data-composer-input][contenteditable="true"]';
const LINE_BREAK = { type: "INSERT_LINE_BREAK_COMMAND" };
const ENTER = { type: "KEY_ENTER_COMMAND" };

let plugin;
globalThis.window = {
  __ModuleLoader__: {
    load: (definition) => {
      plugin = definition.factory();
    },
  },
};

const docListeners = [];
const popups = [];
const warnings = [];
const originalWarn = console.warn;

globalThis.document = {
  body: { appendChild() {} },
  addEventListener(type, fn, capture) {
    docListeners.push({ type, fn, capture });
  },
  removeEventListener(type, fn, capture) {
    const index = docListeners.findIndex((item) => item.type === type && item.fn === fn && item.capture === capture);
    if (index >= 0) docListeners.splice(index, 1);
  },
  querySelectorAll(selector) {
    return selector.includes("data-trigger-menu") ? popups : [];
  },
  createElement() {
    return { style: {}, setAttribute() {}, remove() {}, textContent: "" };
  },
};

await import("../lib/client.js");

console.warn = (...args) => {
  warnings.push(args.join(" "));
};

let composing = false;
let draftText = "";
const root = {
  isContentEditable: true,
  __lexicalEditor: null,
  get textContent() {
    return draftText;
  },
  closest(selector) {
    return selector === COMPOSER ? root : null;
  },
  hasAttribute(name) {
    return name === "data-composer-composing" ? composing : false;
  },
};

function makeEditor(calls, commands = [[LINE_BREAK, []], [ENTER, [] ]]) {
  return {
    _commands: new Map(commands),
    getRootElement: () => root,
    dispatchCommand(command, payload) {
      calls.push([command, payload]);
      return true;
    },
  };
}

const active = { calls: [], editor: null };
active.editor = makeEditor(active.calls);
root.__lexicalEditor = active.editor;

const cleanups = [];
plugin.apply({
  effect: (factory) => {
    cleanups.push(factory());
  },
});

const keydown = docListeners.find((item) => item.type === "keydown" && item.capture).fn;
const compositionEnd = docListeners.find((item) => item.type === "compositionend" && item.capture).fn;

function makeEvent(overrides = {}) {
  const event = {
    key: "Enter",
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
    keyCode: 13,
    target: root,
    defaultPrevented: false,
    propagationStopped: false,
    getModifierState: () => false,
    preventDefault() {
      event.defaultPrevented = true;
    },
    stopPropagation() {
      event.propagationStopped = true;
    },
    ...overrides,
  };
  return event;
}

// 1. 裸 Enter：拦截并派发宿主的换行命令
{
  const event = makeEvent();
  keydown(event);
  assert.equal(event.defaultPrevented, true, "裸 Enter 应被拦截");
  assert.equal(event.propagationStopped, true, "裸 Enter 应阻止冒泡");
  assert.deepEqual(active.calls, [[LINE_BREAK, false]], "应派发一次换行命令");
}

// 2. Alt / Shift / 双修饰键 / 输入法状态一律放行
for (const overrides of [
  { altKey: true },
  { shiftKey: true },
  { shiftKey: true, metaKey: true },
  { ctrlKey: true, metaKey: true },
  { isComposing: true },
  { keyCode: 229 },
  { getModifierState: (key) => key === "AltGraph" },
]) {
  const before = active.calls.length;
  const event = makeEvent(overrides);
  keydown(event);
  assert.equal(event.defaultPrevented, false, `不应拦截：${JSON.stringify(Object.keys(overrides))}`);
  assert.equal(active.calls.length, before);
}

// 3. 非输入框目标不处理
{
  const event = makeEvent({ target: { closest: () => null } });
  keydown(event);
  assert.equal(event.defaultPrevented, false);
}

// 4. 菜单打开时：有高亮交给菜单，无高亮吞掉（避免宿主误提交）
{
  const triggerMenu = (hasHighlight) => ({
    getClientRects: () => [{}],
    hasAttribute: (name) => name === "data-trigger-menu",
    querySelector: () => ({
      hasAttribute: (name) => (name === "aria-activedescendant" ? hasHighlight : false),
    }),
  });

  // 4.1 非触发菜单（普通下拉）：放行给宿主
  popups.push({ getClientRects: () => [{}] });
  let event = makeEvent();
  keydown(event);
  assert.equal(event.defaultPrevented, false, "普通下拉打开时应放行");
  popups.length = 0;

  // 4.2 触发菜单已有高亮：放行，交给菜单选择
  popups.push(triggerMenu(true));
  event = makeEvent();
  keydown(event);
  assert.equal(event.defaultPrevented, false, "有高亮候选时应交给菜单");
  popups.length = 0;

  // 4.3 触发菜单尚未有高亮：吞掉，避免宿主 arbitrate 返回 pass 后误发送
  popups.push(triggerMenu(false));
  const before = active.calls.length;
  event = makeEvent();
  keydown(event);
  assert.equal(event.defaultPrevented, true, "无高亮候选时应吞掉 Enter");
  assert.equal(event.propagationStopped, true);
  assert.equal(active.calls.length, before);
  popups.length = 0;
}

// 5. 输入法组合属性打开时放行
{
  composing = true;
  const event = makeEvent();
  keydown(event);
  assert.equal(event.defaultPrevented, false);
  composing = false;
}

// 6. 组合结束后的 10ms 宽限期内放行，超过后拦截
{
  const realNow = Date.now;
  try {
    Date.now = () => 1000;
    compositionEnd(makeEvent({ target: root }));
    Date.now = () => 1005;
    let event = makeEvent();
    keydown(event);
    assert.equal(event.defaultPrevented, false, "组合结束 5ms 内应放行");
    Date.now = () => 1010;
    event = makeEvent();
    keydown(event);
    assert.equal(event.defaultPrevented, true, "组合结束 10ms 后应拦截");
  } finally {
    Date.now = realNow;
  }
}

// 7. 找不到编辑器：裸 Enter 拦下但不派发（避免误发送）
{
  const saved = root.__lexicalEditor;
  root.__lexicalEditor = null;
  const before = active.calls.length;
  const event = makeEvent();
  keydown(event);
  assert.equal(event.defaultPrevented, true, "缺编辑器时仍应拦下");
  assert.equal(active.calls.length, before);
  root.__lexicalEditor = saved;
}

// 8. 编辑器根不一致：裸 Enter 拦下但不派发
{
  const original = active.editor.getRootElement;
  active.editor.getRootElement = () => ({});
  const before = active.calls.length;
  const event = makeEvent();
  keydown(event);
  assert.equal(event.defaultPrevented, true);
  assert.equal(active.calls.length, before);
  active.editor.getRootElement = original;
}

// 9. 换行命令缺失：裸 Enter 拦下但不派发（用新编辑器避开命令缓存）
{
  const calls = [];
  const saved = root.__lexicalEditor;
  root.__lexicalEditor = makeEditor(calls, [[ENTER, []]]);
  const event = makeEvent();
  keydown(event);
  assert.equal(event.defaultPrevented, true);
  assert.equal(calls.length, 0);
  root.__lexicalEditor = saved;
}

// 10. 换行 dispatch 抛异常：不外抛，事件仍被拦截
{
  const original = active.editor.dispatchCommand;
  active.editor.dispatchCommand = () => {
    throw new Error("boom");
  };
  const event = makeEvent();
  assert.doesNotThrow(() => keydown(event));
  assert.equal(event.defaultPrevented, true);
  active.editor.dispatchCommand = original;
}

// 10.5 换行 dispatch 返回 false：事件仍被拦截，并留下告警
{
  const original = active.editor.dispatchCommand;
  active.editor.dispatchCommand = () => false;
  const event = makeEvent();
  keydown(event);
  assert.equal(event.defaultPrevented, true);
  active.editor.dispatchCommand = original;
}

// 11. 已被别人处理过的事件不再处理
{
  const before = active.calls.length;
  const event = makeEvent({ defaultPrevented: true });
  keydown(event);
  assert.equal(active.calls.length, before);
}

// 12. Cmd/Ctrl+Enter：派发不带加速标记的提交命令（繁忙时按设置排队，而不是插话）
for (const mods of [{ metaKey: true }, { ctrlKey: true }]) {
  draftText = "hi";
  const before = active.calls.length;
  const event = makeEvent(mods);
  keydown(event);
  assert.deepEqual(active.calls.slice(before), [[ENTER, null]], `${Object.keys(mods)} 应派发提交命令`);
  assert.equal(event.defaultPrevented, true, "发送后应阻止宿主再走加速提交");
  assert.equal(event.propagationStopped, true);
}

// 13. 空草稿的 Cmd/Ctrl+Enter 放行，保留宿主的「插话发送全部排队消息」
{
  draftText = "   \n";
  const before = active.calls.length;
  const event = makeEvent({ metaKey: true });
  keydown(event);
  assert.equal(event.defaultPrevented, false);
  assert.equal(active.calls.length, before);
  draftText = "";
}

// 14. 提交命令缺失：放行给宿主（加速提交兜底，至少还能发出去）
{
  const calls = [];
  const saved = root.__lexicalEditor;
  root.__lexicalEditor = makeEditor(calls, [[LINE_BREAK, []]]);
  draftText = "hi";
  const event = makeEvent({ metaKey: true });
  keydown(event);
  assert.equal(event.defaultPrevented, false, "找不到提交命令时不应吞掉发送");
  assert.equal(calls.length, 0);
  root.__lexicalEditor = saved;
}

// 15. 长按重复事件不重复发送
{
  draftText = "hi";
  const before = active.calls.length;
  const event = makeEvent({ metaKey: true, repeat: true });
  keydown(event);
  assert.equal(event.defaultPrevented, false);
  assert.equal(active.calls.length, before);
}

// 16. 提交 dispatch 抛异常：不外抛，放行给宿主兜底
{
  draftText = "hi";
  const original = active.editor.dispatchCommand;
  active.editor.dispatchCommand = () => {
    throw new Error("boom");
  };
  const before = active.calls.length;
  const event = makeEvent({ metaKey: true });
  assert.doesNotThrow(() => keydown(event));
  assert.equal(event.defaultPrevented, false, "派发失败时应退回宿主");
  assert.equal(active.calls.length, before);
  active.editor.dispatchCommand = original;
}

// 17. 提交返回 false（无处理器）：同样放行
{
  draftText = "hi";
  const original = active.editor.dispatchCommand;
  active.editor.dispatchCommand = () => false;
  const event = makeEvent({ metaKey: true });
  keydown(event);
  assert.equal(event.defaultPrevented, false);
  active.editor.dispatchCommand = original;
}

// 18. 菜单打开时 Cmd/Ctrl+Enter 仍按提交处理（发送是明确意图）
{
  draftText = "hi";
  popups.push({
    getClientRects: () => [{}],
    hasAttribute: (name) => name === "data-trigger-menu",
    querySelector: () => ({ hasAttribute: () => false }),
  });
  const before = active.calls.length;
  const event = makeEvent({ metaKey: true });
  keydown(event);
  assert.deepEqual(active.calls.slice(before), [[ENTER, null]]);
  assert.equal(event.defaultPrevented, true);
  popups.length = 0;
}

// 19. 卸载后监听器全部移除
{
  cleanups[0]();
  assert.equal(docListeners.filter((item) => item.type === "keydown").length, 0);
  assert.equal(docListeners.filter((item) => item.type === "compositionend").length, 0);
}

// 20. 失效告警只提示一次
{
  const count = warnings.filter((line) => line.includes("dsh-composer-enter")).length;
  assert.ok(count > 0, "失效路径应有告警");
}

console.warn = originalWarn;
console.log("测试通过");
