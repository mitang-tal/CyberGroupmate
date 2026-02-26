# mtcute 参考指南

本文档供 Agent 在 sandbox 中查阅。通过 `docs.read("mtcute")` 读取。

## 创建客户端 & 登录

### Bot 模式

```typescript
const { TelegramClient } = await import("@mtcute/node");
const tg = new TelegramClient({
  apiId: Number(process.env.TG_API_ID),
  apiHash: process.env.TG_API_HASH,
  storage: "workspace/tg-session/account",
});
const self = await tg.start({ botToken: process.env.TG_BOT_TOKEN });
console.log("Bot: " + self.displayName + " (ID: " + self.id + ")");
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
  code: async () => await runtime.input("请输入 Telegram 验证码: "),
  password: async () => await runtime.input("请输入两步验证密码: "),
  codeSentCallback: (sentCode) => {
    runtime.print("📱 验证码已发送 (type: " + sentCode.type + ")");
  },
});
console.log("Logged in: " + self.displayName + " (ID: " + self.id + ")");
ctx.tg = tg;
ctx.self = self;
```

Session 持久化在 `workspace/tg-session/`，重启时 `tg.start()` 自动恢复。

## 发送消息

> **❌ 绝对禁止使用由于习惯其他库而产生的“对象传参”幻觉！**
> ❌ 错误做法 (会报 Illegal state at toInputPeer)：`ctx.tg.sendText({ chatId: 123, text: "hi" })`
> ✅ 正确位置参数：`ctx.tg.sendText(123, "hi", { replyTo: 456 })`

```typescript
// 发送文本（返回 Message 对象）
const sent = await ctx.tg.sendText(chatId, "Hello!");
console.log("已发送, msgId=" + sent.id);

// 带 HTML 格式
const { html } = await import("@mtcute/node");
await ctx.tg.sendText(chatId, html`<b>粗体</b>`);

// 回复消息
await ctx.tg.sendText(chatId, "回复内容", { replyTo: messageId });

// 发送媒体
await ctx.tg.sendMedia(chatId, { type: "photo", file: "path/to/photo.jpg" });
```

## 获取消息历史

> **❌ 绝对禁止把 chatId 写在 opts 对象里！**
> ❌ 错误做法：`ctx.tg.getHistory({ chatId: 123, limit: 5 })`
> ✅ 正确位置参数：`ctx.tg.getHistory(123, { limit: 5 })`

```typescript
for await (const msg of ctx.tg.iterHistory(chatId, { limit: 20 })) {
  console.log((msg.sender?.displayName || "?") + ": " + msg.text);
}
```

## 获取对话列表

```typescript
for await (const dialog of ctx.tg.iterDialogs({ limit: 20 })) {
  // ⚠ 对话信息在 dialog.peer 上，不是 dialog.chat
  const name = dialog.peer.displayName || dialog.peer.title || "未知";
  console.log(name + " (ID: " + dialog.peer.id + ")");
}
```

## 监听新消息

`ctx.tg.onNewMessage` 是 **Emitter 对象**（不是函数！），用 `.add(handler)` 注册：

```typescript
ctx.tg.onNewMessage.add(async (msg) => {
  if (msg.sender?.id === ctx.self.id) return;  // 忽略自己

  const isUrgent = msg.isMention || msg.replyToMessage || msg.chat.id > 0 ? true : false;

  runtime.notify({
    type: "telegram.message",
    chatId: msg.chat.id,
    senderId: msg.sender?.id,
    senderName: msg.sender?.displayName || "未知",
    text: msg.text || "",
    messageId: msg.id,
    raw: msg,
    _urgent: isUrgent,
  });
});
console.log("消息监听已启动");
```

### Emitter 方法

| 方法 | 说明 |
|------|------|
| `.add(handler)` | 注册监听器 |
| `.once(handler)` | 一次性监听器 |
| `.remove(handler)` | 移除 |
| `.clear()` | 移除全部 |

### 可用事件

`onNewMessage` · `onEditMessage` · `onDeleteMessage` · `onChatMemberUpdate` · `onCallbackQuery` · `onUserStatusUpdate` · `onUserTyping` · `onHistoryRead`

## 常用方法速查

这些方法在原型链上，`Object.keys()` 看不到，但可以直接调用：

| 方法 | 说明 |
|------|------|
| `sendText(chatId, text, opts?)` | 发消息，返回 Message |
| `sendMedia(chatId, media, opts?)` | 发媒体 |
| `replyText(msg, text, opts?)` | 回复消息 |
| `editMessage(msgOrId, params)` | 编辑消息 |
| `deleteMessages(chatId, ids)` | 删除消息 |
| `forwardMessages(toChatId, msgs)` | 转发消息 |
| `iterHistory(chatId, opts?)` | 迭代消息历史 |
| `getHistory(chatId, opts?)` | 获取消息历史 |
| `iterDialogs(opts?)` | 迭代对话列表 |
| `getChat(chatId)` | 获取聊天详情 |
| `getChatMembers(chatId, opts?)` | 获取群成员列表 |
| `getMe()` | 获取自身信息 |
| `getUser(userId)` | 获取用户信息 |
| `readHistory(chatId)` | 标记已读 |
| `sendTyping(chatId)` | 发送"正在输入"状态 |
| `pinMessage(chatId, msgId)` | 置顶消息 |
| `joinChat(chatId)` | 加入群组/频道 |
| `leaveChat(chatId)` | 退出群组/频道 |
| `searchMessages(chatId, opts)` | 搜索消息 |

## Sandbox Runtime API

| 方法 | 说明 |
|------|------|
| `runtime.notify(event)` | 推送事件到通知中心 |
| `runtime.input(prompt)` | 向 CLI 请求用户输入（阻塞等待） |
| `runtime.print(msg)` | 直接打印到 CLI（不被 console.log 捕获） |

## 注意事项

1. **必须用 `await import()`**：sandbox 不支持 `import`/`require`
2. **Session 持久化**：始终用 `storage: "workspace/tg-session/account"`
3. **保存到 ctx**：`ctx.tg` 跨代码块复用
4. **方法在原型链上**：`Object.keys(ctx.tg)` 只显示事件，直接调用 `sendText` 等即可
5. **Emitter 用 .add()**：`ctx.tg.onNewMessage.add(fn)`，不能直接调用 `onNewMessage(fn)`
6. **对话信息在 peer**：`dialog.peer.displayName`，不是 `dialog.chat`
7. **sendText 返回 Message**：发送成功时打印 `sent.id` 确认
8. **API 限制**：Telegram 有 flood wait，mtcute 自动重试
9. **ChatId**：群组/频道 ID 通常是负数
