# DSH Composer Enter

让 DSH Web 聊天输入框按「Enter 换行、Cmd/Ctrl+Enter 发送」工作。纯客户端插件，无配置项。

## 按键行为

| 输入 | 行为 |
|---|---|
| `Enter` | 插入换行，不发送 |
| `Cmd+Enter` / `Ctrl+Enter` | 发送；繁忙时按「繁忙时的发送行为」投递，与发送按钮一致 |
| `Shift+Enter` | 换行（DSH 原生行为，未改动） |
| `Alt` / `AltGraph` / 多修饰组合 | 不拦截，交给 DSH |
| 输入法组合中、组合结束后 10ms 内 | 不拦截，避免中文候选确认被误判 |
| `/`、`@`、`+` 等候选菜单打开时 | 有高亮候选时交给菜单选择；菜单已弹出但还没高亮时吞掉 Enter，避免宿主误提交 |
| 非聊天输入框（搜索框等） | 不处理 |

## 与「繁忙时的发送行为」设置的关系

DSH 原生的 `Cmd/Ctrl+Enter` 是「加速提交」：繁忙时固定取该设置的相反模式。插件把裸 Enter 改成换行后，键盘上只剩这个键能发送，于是设成「排队发送」时按 `Cmd/Ctrl+Enter` 反而会插话进正在跑的回合。插件因此接管这个键，改为按设置投递，与发送按钮完全一致：

| 入口 | 智能体运行中 |
|---|---|
| 裸 `Enter` | 换行，不排队也不插话 |
| 发送按钮 | 按该设置，标签显示「排队发送」或「插话发送」 |
| `Cmd/Ctrl+Enter` | 按该设置投递（与发送按钮一致），不再取相反模式 |
| 空草稿 + `Cmd/Ctrl+Enter` | 插话发送全部排队消息（DSH 原有加速语义，保留） |

队列行的行内编辑用的是独立编辑器，不是聊天输入框，不受本插件影响。

## 安装

```bash
dsh plugin --profile web add dsh-composer-enter
```

安装后重启 DSH，并刷新浏览器页面。

## 实现方式

DSH 没有修改 Enter 快捷键的公开 API，官方在 Lexical 命令层把裸 `Enter` 注册成了提交（`KEY_ENTER_COMMAND`，priority 4）。

为什么不在命令层抢：

- Lexical 按优先级桶 4→0 派发，**同优先级按注册顺序执行**；官方在编辑器创建时就注册好了，后注册的监听器永远排在后面
- Lexical 命令以对象身份为键，自己打包一份 `lexical` 拿到的是另一个命令对象，派发无效
- 用未公开的优先级数值插队属于依赖实现细节，不采用

因此插件在 **document 捕获阶段**拦下按键，阻止事件到达编辑器，再复用宿主自己的命令：裸 `Enter` 派发 `INSERT_LINE_BREAK_COMMAND`；`Cmd/Ctrl+Enter` 派发 `KEY_ENTER_COMMAND`，但传空事件，让宿主的提交回调按「非加速」处理——与发送按钮走同一条路径，繁忙时按设置排队或插话。派发前先取命令，取不到就放行给宿主，避免吞掉一次发送。

宿主半部（`lib/index.js`）是空壳，只负责让 profile 的 bundle patch 能插一条 loader 记录；所有逻辑在 `lib/client.js`。

## 依赖的 DSH 内部契约

这些不是公开 API，DSH 升级后若要排查，按顺序检查：

| 契约 | 用途 |
|---|---|
| `[data-composer-input][contenteditable="true"]` | 识别聊天输入框根元素 |
| 根元素的 `__lexicalEditor`（Lexical 挂载） | 拿到编辑器实例 |
| `editor._commands` 里 `type === "INSERT_LINE_BREAK_COMMAND"` 的命令对象 | 复用宿主换行命令 |
| `editor._commands` 里 `type === "KEY_ENTER_COMMAND"` 的命令对象 | 复用宿主提交命令（繁忙时按设置投递） |
| `[data-trigger-menu]` / `[role="listbox"]:not([hidden])` / 候选列表的 `aria-activedescendant` | 菜单打开时决定交给菜单还是吞掉 |
| 根元素的 `data-composer-composing` 属性 | 输入法组合中放行 |

浏览器控制台自查：

```js
const root = document.querySelector('[data-composer-input][contenteditable="true"]');
root?.__lexicalEditor;
const types = [...(root?.__lexicalEditor?._commands?.keys?.() ?? [])].map((c) => c.type);
types.includes('INSERT_LINE_BREAK_COMMAND');
types.includes('KEY_ENTER_COMMAND');
document.querySelector('[data-trigger-menu]');
```

## 失效策略

两条路故意相反：

- 裸 `Enter`：一旦确认按键来自聊天输入框，即使找不到编辑器或换行命令，也会**拦下这次 Enter 而不是退回发送**——插件失效时「回车没反应」远好于「半截消息被发出去」
- `Cmd/Ctrl+Enter`：取不到宿主提交命令时直接放行，让宿主的加速提交兜底——丢掉一次发送比插话更糟

裸 Enter 失效时：

- 控制台 `console.warn` 提示一次
- 页面底部给一次 8 秒的轻提示
- 草稿保留，用 `Cmd/Ctrl+Enter` 或发送按钮继续

## 兼容范围

- 实测：DSH CLI / Web 客户端 `0.2.1-rc.5`
- 0.1.x 时代的旧版本可用，但不再验证

## 开发与验证

```bash
npm run check   # 语法检查 + 单元测试（假 DOM，无额外依赖）
```

手测清单：中文/英文输入法（含 Safari）、组合刚结束就回车、`/` 与 `@` 菜单打开与选择、长按 Enter、多会话切换、页面刷新与 HMR、选区替换、撤销重做、粘贴文本/图片、运行中与禁用态、运行中按 `Cmd/Ctrl+Enter` 应排队而不是插话。

## 已知边界

- 「繁忙时的发送行为」只约束发送按钮和 `Cmd/Ctrl+Enter`，裸 `Enter` 永远是换行；需要插话时把设置改成「插话发送」
- 仅 Web 端；移动端请用发送按钮
- 长按 Enter 会连续换行，与普通文本框一致
- 依赖 Lexical 内部结构，属于尽力兼容，不做版本承诺

## 许可证

MIT
