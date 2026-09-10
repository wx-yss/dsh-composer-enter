# DSH Composer Enter

用于 DSH 0.1.5 Web 输入框：

- `Enter` 换行
- `Cmd+Enter` 或 `Ctrl+Enter` 提交

## 安装

```bash
dsh plugin --profile web add dsh-composer-enter
```

安装后重启 DSH，并刷新浏览器页面。

## 功能

- 普通 `Enter` 插入换行
- `Cmd+Enter` 或 `Ctrl+Enter` 继续使用 DSH 原生提交行为
- 输入法组合输入、候选菜单和带其他修饰键的 Enter 不受影响

插件不提供配置项，不轮询 DOM，也不改写 Lexical 方法。

## 验证

```bash
npm run check
```

## 兼容范围

- DSH CLI：`0.1.5-rc.1`
- DSH Web 客户端组件：`0.1.5-rc.2`

## 许可证

MIT
