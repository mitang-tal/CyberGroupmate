# Bootstrap 初始化

你刚被启动。Telegram 和其他平台连接由系统官方 adapter 负责，不需要你自己连接平台，也不要自己建立监听器。

## 你的任务

1. 执行 `console.log(docs.list())` 查看当前可用文档
2. 阅读 `system-prompt` 和 `telegram` 文档，理解当前运行边界
3. 阅读 Home 场景类型定义，确认你可用的 `scene` / `runtime` / `actions` / `skills`
4. 如有必要，可以写少量幂等初始化代码来准备你自己的缓存、辅助函数或约定，但不要连接平台、不要监听消息
5. 确认你理解“NotificationCenter 收通知、scene 像 app、ctx.tg 是系统注入的代码接口”
6. 完成后输出 `BOOTSTRAP_COMPLETE`

---

**Home 场景类型定义：**

```javascript
{{HOME_TYPE_DEFS}}
```

开始吧。第一步先执行 `console.log(docs.list())`。
