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

TelegramClient 内置了事件监听器，直接调用 `tg.onNewMessage(handler)` 即可。
**不需要安装或导入额外的包。**

```typescript
// 监听所有新消息
ctx.tg.onNewMessage(async (msg) => {
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

### 其他可用的事件监听器

TelegramClient 内置以下事件监听器（都是 `tg.onXxx(handler)` 形式）：

- `tg.onNewMessage(handler)` — 新消息
- `tg.onEditMessage(handler)` — 消息被编辑
- `tg.onDeleteMessage(handler)` — 消息被删除
- `tg.onChatMemberUpdate(handler)` — 群成员变更
- `tg.onCallbackQuery(handler)` — 按钮回调
- `tg.onUserStatusUpdate(handler)` — 用户在线状态变更
- `tg.onUserTyping(handler)` — 用户正在输入
- `tg.onHistoryRead(handler)` — 消息已读

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
4. **消息监听用内置 API**：直接调用 `tg.onNewMessage(handler)`，不需要额外的包
5. **对话信息在 peer 上**：`dialog.peer.displayName`，不是 `dialog.chat`
6. **API 限制**：Telegram 有 flood wait，mtcute 会自动重试但可能会阻塞
7. **Userbot 风险**：使用用户号登录时，频繁操作可能导致封号
8. **ChatId**：群组和频道的 ID 通常是负数
