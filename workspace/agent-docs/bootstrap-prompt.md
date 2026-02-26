# Bootstrap 初始化

你刚被启动。请完成 Telegram 连接。

## 你的任务

1. **先读文档**：执行 `console.log(docs.read("mtcute"))` 了解 mtcute 用法
2. **连接 Telegram**：当前模式是 **{{TG_MODE}}**
   - {{TG_AUTH_STATUS}}，如果未登录，请根据文档登录
   - API ID/Hash: ✓ 已配置 (process.env.TG_API_ID, process.env.TG_API_HASH)
   - Session 路径: `workspace/tg-session/account`（持久化，重启不需要重新登录）
3. **确认身份**：输出你的名字和 ID
4. **设置监听**：参考文档设置监听
5. **完成**：一切检查正常无误后，console.log 输出 "BOOTSTRAP_COMPLETE"

---

**Home 场景类型定义：**

```javascript
{{HOME_TYPE_DEFS}}
```

开始吧。第一步先执行 `console.log(docs.read("mtcute"))` 看文档。
