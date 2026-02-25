# mtcute 参考指南

本文档供 Agent 在需要时查阅。可通过 `docs.read("mtcute")` 读取。

> **此文档是预置参考资料，Agent 不需要联网搜索 mtcute 用法。**

## 安装

`@mtcute/node` 已在项目依赖中安装。导入：

```typescript
import { TelegramClient } from "@mtcute/node";
```

## 创建客户端

```typescript
const tg = new TelegramClient({
  apiId: Number(process.env.TG_API_ID),
  apiHash: process.env.TG_API_HASH,
  storage: "data/tg-session/account",  // SQLite 自动持久化
});
```

**重要**：`storage` 传字符串路径即可，mtcute 自动使用 `SqliteStorage`。
Session 文件保存在 `data/tg-session/` 目录下，重启后自动恢复登录状态。

## 登录方式

### Bot 模式

```typescript
const self = await tg.start({
  botToken: process.env.TG_BOT_TOKEN,
});
console.log(`Logged in as bot: ${self.displayName}`);
```

### Userbot 模式（手机号 + OTP）

```typescript
const self = await tg.start({
  phone: () => process.env.TG_PHONE ?? "+1234567890",
  code: () => {
    // ⚠ 这里需要从人类获取验证码
    // 使用 runtime.notify 请求人类输入
    return new Promise((resolve) => {
      runtime.notify({
        type: "system.auth_code_needed",
        message: "请输入 Telegram 发送的验证码",
      });
      // 等待人类通过 notify 事件返回验证码
      ctx._resolveAuthCode = resolve;
    });
  },
  password: () => {
    // 2FA 密码（如果设置了的话）
    return new Promise((resolve) => {
      runtime.notify({
        type: "system.auth_2fa_needed",
        message: "请输入两步验证密码",
      });
      ctx._resolve2FA = resolve;
    });
  },
  codeSentCallback: (sentCode) => {
    console.log(`验证码已发送: type=${sentCode.type}`);
  },
});
```

### QR 码登录

```typescript
const self = await tg.start({
  qrCodeHandler: (url, expires) => {
    runtime.notify({
      type: "system.qr_login",
      url: url,
      expiresAt: expires.toISOString(),
      message: `请在 Telegram 手机端扫描此登录链接: ${url}`,
    });
  },
});
```

## 会话恢复

**首次登录后，session 自动保存。** 重启时只需：

```typescript
const tg = new TelegramClient({
  apiId: Number(process.env.TG_API_ID),
  apiHash: process.env.TG_API_HASH,
  storage: "data/tg-session/account",
});

// 如果已有 session，start() 会直接恢复，不会再要求登录
const self = await tg.start({
  // 仍然提供 phone/code 回调以防 session 过期
  phone: () => process.env.TG_PHONE,
  code: () => { /* ... */ },
});
```

## 发送消息

```typescript
// 发送文本消息
await tg.sendText(chatId, "Hello!");

// 带 HTML 格式
import { html } from "@mtcute/node";
await tg.sendText(chatId, html`<b>粗体</b> 和 <i>斜体</i>`);

// 回复消息
await tg.sendText(chatId, "回复内容", { replyTo: messageId });
```

## 获取消息

```typescript
// 获取最近的消息
for await (const msg of tg.iterHistory(chatId, { limit: 20 })) {
  console.log(`${msg.sender?.displayName}: ${msg.text}`);
}

// 也可用 getHistory
const messages = await tg.getHistory(chatId, { limit: 20 });
```

## 获取对话列表

```typescript
for await (const dialog of tg.iterDialogs({ limit: 20 })) {
  console.log(`${dialog.chat.title ?? dialog.chat.displayName}: ${dialog.unreadCount} unread`);
}
```

## 监听新消息

需要使用 Dispatcher：

```typescript
import { Dispatcher } from "@mtcute/dispatcher";

const dp = Dispatcher.for(tg);

dp.onNewMessage.add((msg) => {
  runtime.notify({
    type: "telegram.message",
    chatId: msg.chat.id,
    chatTitle: msg.chat.title ?? msg.chat.displayName,
    fromUser: msg.sender?.displayName ?? "unknown",
    fromUserId: msg.sender?.id,
    text: msg.text,
    messageId: msg.id,
    mentioned: msg.entities?.some(e => e._ === "messageEntityMention") ?? false,
    isPrivate: msg.chat.chatType === "private",
  });
});

// 启动 dispatcher 的轮询（必须调用）
dp.startPolling();
```

**重要**：Dispatcher 监听不需要 `runtime.spawn`，它自己管理事件循环。
但你需要安装 `@mtcute/dispatcher`：

```typescript
// 如果 @mtcute/dispatcher 不可用，可以使用 tg.on：
tg.on("update", (update) => {
  if (update._ === "updateNewMessage" || update._ === "updateNewChannelMessage") {
    // 处理新消息
  }
});
```

## 获取自身信息

```typescript
const me = await tg.getMe();
console.log(`I am: ${me.displayName} (ID: ${me.id})`);
```

## 搜索消息

```typescript
const results = [];
for await (const msg of tg.searchMessages({
  chatId: chatId,
  query: "关键词",
  limit: 10,
})) {
  results.push(msg);
}
```

## 注意事项

1. **Session 持久化**：始终使用 `storage: "data/tg-session/account"` 保持登录
2. **API 限制**：Telegram 有 flood wait，mtcute 会自动重试但可能会阻塞
3. **Userbot 风险**：使用用户号登录时，频繁操作可能导致封号，注意控制频率
4. **ChatId**：群组和频道的 ID 通常是负数（如 -100123456）
5. **DisplayName**：使用 `user.displayName` 获取用户显示名称
