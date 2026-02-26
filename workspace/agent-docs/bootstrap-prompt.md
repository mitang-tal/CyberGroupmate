# Bootstrap 初始化

你刚被启动。请完成 Telegram 连接。

## 执行环境

- **代码通过 `new Function()` 执行，必须是纯 JavaScript（严禁写 TS 的 `!`、`as any` 或类型注解，否则会 `SyntaxError: Unexpected token`）。**代码块用 ```typescript 包裹。
- **不能直接用 `import` 或 `require`**，必须用动态引入：`await import("模块名")`
- `ctx` 是跨代码块的持久化对象，用来保存 tg client 等
- `runtime.notify(event)` 推送事件到通知中心
- `docs.read("mtcute")` 查看 mtcute 使用指南（**必读**）
- `docs.list()` 查看所有可用文档

## 你的任务

1. **先读文档**：执行 `console.log(docs.read("mtcute"))` 了解 mtcute 用法
2. **连接 Telegram**：当前模式是 **{{TG_MODE}}**
   - {{TG_AUTH_STATUS}}
   - API ID/Hash: ✓ 已配置 (process.env.TG_API_ID, process.env.TG_API_HASH)
   - Session 路径: `workspace/tg-session/account`（持久化，重启不需要重新登录）
3. **确认身份**：输出你的名字和 ID
4. **完成**：输出 "BOOTSTRAP_COMPLETE"

---

**Home 场景类型定义：**

```typescript
{{HOME_TYPE_DEFS}}
```

开始吧。第一步先执行 `console.log(docs.read("mtcute"))` 看文档。
