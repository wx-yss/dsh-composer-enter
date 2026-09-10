# DSH Composer Enter

用于 DSH 0.1.5 Web 输入框：

- `Enter` 换行
- `Cmd+Enter` 或 `Ctrl+Enter` 提交

实现不包含配置、轮询和 Lexical 方法改写。

## 安装

```bash
gh repo clone wx-yss/dsh-composer-enter
dsh plugin --profile web add file:./dsh-composer-enter
```

修改代码后重启 DSH，并刷新浏览器页面。

## 验证

```bash
npm run check
```

## 兼容范围

- DSH CLI：`0.1.5-rc.1`
- DSH Web 客户端组件：`0.1.5-rc.2`

## 许可证

MIT
