import assert from "node:assert/strict";

let plugin;
let cleanup;
const elements = [];
globalThis.window = { __ModuleLoader__: { load: (definition) => { plugin = definition.factory(); } } };
globalThis.document = {
  documentElement: {},
  querySelector: () => null,
  querySelectorAll: () => elements,
};
globalThis.MutationObserver = class { observe() {} disconnect() {} };

await import("../lib/client.js");

const command = { type: "INSERT_LINE_BREAK_COMMAND" };
const dispatched = [];
const listeners = [];
const element = {
  __lexicalEditor: {
    _commands: new Map([[command, []]]),
    dispatchCommand: (value, payload) => dispatched.push([value, payload]),
  },
  addEventListener: (type, listener, capture) => listeners.push({ type, listener, capture }),
  removeEventListener(type, listener, capture) {
    const index = listeners.findIndex((item) =>
      item.type === type && item.listener === listener && item.capture === capture);
    if (index >= 0) listeners.splice(index, 1);
  },
};
elements.push(element);
plugin.apply({ effect: (factory) => { cleanup = factory(); } });

let prevented = false;
let stopped = false;
listeners[0].listener({
  key: "Enter",
  preventDefault: () => { prevented = true; },
  stopImmediatePropagation: () => { stopped = true; },
});
assert.equal(prevented, true);
assert.equal(stopped, true);
assert.deepEqual(dispatched, [[command, false]]);

for (const modifier of ["altKey", "ctrlKey", "metaKey", "shiftKey", "isComposing"]) {
  listeners[0].listener({ key: "Enter", [modifier]: true });
}
assert.equal(dispatched.length, 1);

cleanup();
assert.equal(listeners.length, 0);
console.log("测试通过");
