# mtcute 参考指南

本文档供 Agent 在 sandbox 中查阅。通过 `docs.read("mtcute")` 读取。

> **重要：sandbox 执行环境使用 `new Function()`，不支持 `import` 和 `require`。**
> **必须用 `await import("模块名")` 来导入模块。**

## 导入

```typescript
const { TelegramClient } = await import("@mtcute/node");
```

## 创建客户端

```typescript
const { TelegramClient } = await import("@mtcute/node");

const tg = new TelegramClient({
  apiId: Number(process.env.TG_API_ID),
  apiHash: process.env.TG_API_HASH,
  storage: "workspace/tg-session/account",  // SQLite 自动持久化
});
ctx.tg = tg;  // 保存到 ctx 以便后续代码块使用
```

**重要**：`storage` 传字符串路径即可，mtcute 自动使用 `SqliteStorage`。
Session 文件保存在 `workspace/tg-session/` 目录下，重启后自动恢复登录状态。

## 登录方式

### Bot 模式

```typescript
const { TelegramClient } = await import("@mtcute/node");

const tg = new TelegramClient({
  apiId: Number(process.env.TG_API_ID),
  apiHash: process.env.TG_API_HASH,
  storage: "workspace/tg-session/account",
});

const self = await tg.start({
  botToken: process.env.TG_BOT_TOKEN,
});
console.log("Logged in as bot: " + self.displayName + " (ID: " + self.id + ")");
ctx.tg = tg;
ctx.self = self;
```

### Userbot 模式（手机号 + OTP）

```typescript
const { TelegramClient } = await import("@mtcute/node");

const tg = new TelegramClient({
  apiId: Number(process.env.TG_API_ID),
  apiHash: process.env.TG_API_HASH,
  storage: "workspace/tg-session/account",
});

const self = await tg.start({
  phone: () => process.env.TG_PHONE,
  code: async () => {
    // runtime.input() 会在 CLI 中提问并等待用户输入
    const code = await runtime.input("请输入 Telegram 验证码: ");
    return code;
  },
  password: async () => {
    const pwd = await runtime.input("请输入两步验证密码: ");
    return pwd;
  },
  codeSentCallback: (sentCode) => {
    runtime.print("📱 验证码已发送 (type: " + sentCode.type + "), 请查看你的 Telegram 应用");
  },
});
console.log("Logged in as: " + self.displayName + " (ID: " + self.id + ")");
ctx.tg = tg;
ctx.self = self;
```

**关键 API**：
- `runtime.input(prompt)` — 在 CLI 中显示提示并等待用户输入
- `runtime.print(msg)` — 直接打印到 CLI（不被 console.log 捕获）
- `runtime.notify(event)` — 推送事件到通知中心

## 会话恢复

**首次登录后，session 自动保存。** 重启时 `tg.start()` 会直接恢复，不会再要求验证码。

## 监听新消息

`ctx.tg.onNewMessage` 是一个 **Emitter 对象**（不是函数！）。
必须使用 `.add(handler)` 方法来注册监听器。

```typescript
// ✅ 正确：用 .add() 注册监听器
ctx.tg.onNewMessage.add(async (msg) => {
  // 忽略自己的消息
  if (msg.sender?.id === ctx.self.id) return;

  const senderName = msg.sender?.displayName || "未知";
  const chatId = msg.chat.id;
  const text = msg.text || "[非文本消息]";
  
  console.log("[收到消息] " + senderName + " in " + chatId + ": " + text);

  // 推送到事件中心，让主循环处理
  runtime.notify({
    type: "telegram.message",
    chatId: chatId,
    senderId: msg.sender?.id,
    senderName: senderName,
    text: text,
    messageId: msg.id,
  });
});

console.log("消息监听已启动");
```

**⚠ 常见错误**：
```typescript
// ❌ 错误：onNewMessage 不是函数，不能直接调用
ctx.tg.onNewMessage(handler);  // TypeError: not a function

// ❌ 错误：Object.keys() 看不到 Emitter 方法（在原型链上）
Object.keys(ctx.tg.onNewMessage);  // 返回 []
```

### Emitter API

所有事件监听器都是 Emitter 对象，方法一致：

| 方法 | 说明 |
|------|------|
| `.add(handler)` | 注册监听器 |
| `.once(handler)` | 注册一次性监听器（触发后自动移除） |
| `.remove(handler)` | 移除监听器 |
| `.clear()` | 移除所有监听器 |

### 可用的事件监听器

- `ctx.tg.onNewMessage` — 新消息
- `ctx.tg.onEditMessage` — 消息被编辑
- `ctx.tg.onDeleteMessage` — 消息被删除
- `ctx.tg.onChatMemberUpdate` — 群成员变更
- `ctx.tg.onCallbackQuery` — 按钮回调
- `ctx.tg.onUserStatusUpdate` — 用户在线状态变更
- `ctx.tg.onUserTyping` — 用户正在输入
- `ctx.tg.onHistoryRead` — 消息已读

## 发送消息

```typescript
// 发送文本消息
await ctx.tg.sendText(chatId, "Hello!");

// 带 HTML 格式
const { html } = await import("@mtcute/node");
await ctx.tg.sendText(chatId, html`<b>粗体</b> 和 <i>斜体</i>`);

// 回复消息
await ctx.tg.sendText(chatId, "回复内容", { replyTo: messageId });
```

## 获取消息

```typescript
// 获取最近的消息
for await (const msg of ctx.tg.iterHistory(chatId, { limit: 20 })) {
  console.log(msg.sender?.displayName + ": " + msg.text);
}
```

## 获取对话列表

```typescript
// 注意：对话信息在 dialog.peer 上，不是 dialog.chat
for await (const dialog of ctx.tg.iterDialogs({ limit: 20 })) {
  const name = dialog.peer.displayName || dialog.peer.title || "未知";
  console.log(name + " (ID: " + dialog.peer.id + ")");
}
```

## 获取自身信息

```typescript
const me = await ctx.tg.getMe();
console.log("I am: " + me.displayName + " (ID: " + me.id + ")");
```

## 注意事项

1. **必须用 `await import()`**：sandbox 不支持 `import` 和 `require`
2. **Session 持久化**：始终使用 `storage: "workspace/tg-session/account"` 保持登录
3. **保存到 ctx**：将 tg client 保存到 `ctx.tg` 以便跨代码块使用
4. **消息监听用 Emitter 的 .add()**：`ctx.tg.onNewMessage.add(handler)`，不能直接调 `onNewMessage(handler)`
5. **对话信息在 peer 上**：`dialog.peer.displayName`，不是 `dialog.chat`
6. **API 限制**：Telegram 有 flood wait，mtcute 会自动重试但可能会阻塞
7. **Userbot 风险**：使用用户号登录时，频繁操作可能导致封号
8. **ChatId**：群组和频道的 ID 通常是负数
