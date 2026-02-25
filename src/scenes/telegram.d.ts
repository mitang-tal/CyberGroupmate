/**
 * telegram.d.ts — Telegram 场景类型定义 (L1)
 *
 * 精简版 mtcute 操作接口，手工编写的子集。
 * Agent 进入 telegram 场景后看到这些类型，用于读写消息。
 *
 * ctx.tg: TelegramClient — 在 bootstrap 时初始化
 */

// ─── 场景管理（所有场景共用） ───
declare const scene: {
    enter(name: string): void;
    current: string;
    list(): void;
    showFullTypes(): void;
};

declare const runtime: {
    notify(event: { type: string;[key: string]: unknown }): void;
    spawn(name: string, fn: (signal: AbortSignal) => Promise<void>): void;
    kill(name: string): void;
    ps(): void;
    cron(expr: string, name: string, fn: () => Promise<void>): void;
};

declare const ctx: Record<string, any>;

// ─── Telegram 类型 ───

/** Telegram 用户 */
interface User {
    /** 用户数字 ID */
    id: number;
    /** 名 */
    firstName: string;
    /** 姓（可选） */
    lastName?: string;
    /** 用户名（不含 @） */
    username?: string;
}

/** Telegram 聊天 */
interface Chat {
    /** 聊天 ID */
    id: number;
    /** 聊天类型："private" | "group" | "supergroup" | "channel" */
    type: "private" | "group" | "supergroup" | "channel";
    /** 聊天标题（群组/频道）或用户名（私聊） */
    title?: string;
    /** 聊天 username */
    username?: string;
}

/** Telegram 消息 */
interface Message {
    /** 消息 ID */
    id: number;
    /** 消息文本内容 */
    text: string;
    /** 发送时间 (Date) */
    date: Date;
    /** 消息所在聊天 */
    chat: Chat;
    /** 发送者 */
    sender: User;
    /** 是否 @ 了当前用户 */
    mentioned: boolean;
    /** 回复的消息 ID（如有） */
    replyToMessageId?: number;
    /** 媒体内容（图片、文件等） */
    media?: unknown;
    /** 表情包 */
    sticker?: {
        emoji?: string;
        setName?: string;
    };
}

/** 对话列表项 */
interface Dialog {
    /** 对话对应的聊天 */
    chat: Chat;
    /** 最后一条消息 */
    lastMessage?: Message;
    /** 未读消息数 */
    unreadCount: number;
}

/** 获取消息的选项 */
interface GetMessagesOptions {
    /** 最大获取数量，默认 20 */
    limit?: number;
    /** 从此消息 ID 之前开始获取 */
    offsetId?: number;
}

/**
 * Telegram 客户端（精简版 mtcute 接口）
 *
 * 通过 ctx.tg 访问，在 bootstrap 时初始化。
 */
interface TelegramClient {
    /**
     * 发送文本消息
     * @param chatId - 目标聊天 ID
     * @param text - 消息文本
     * @param options - 可选参数（如 replyTo）
     * @returns 发送的消息对象
     */
    sendText(
        chatId: number | string,
        text: string,
        options?: { replyTo?: number }
    ): Promise<Message>;

    /**
     * 获取聊天中的消息
     * @param chatId - 聊天 ID
     * @param options - 获取选项
     * @returns 消息数组
     */
    getMessages(
        chatId: number | string,
        options?: GetMessagesOptions
    ): Promise<Message[]>;

    /**
     * 获取对话列表
     * @param options - 获取选项
     * @returns 对话列表
     */
    getDialogs(options?: { limit?: number }): Promise<Dialog[]>;

    /**
     * 转发消息
     * @param toChatId - 目标聊天 ID
     * @param fromChatId - 源聊天 ID
     * @param messageIds - 要转发的消息 ID 数组
     */
    forwardMessages(
        toChatId: number | string,
        fromChatId: number | string,
        messageIds: number[]
    ): Promise<Message[]>;

    /**
     * 发送表情包
     * @param chatId - 目标聊天 ID
     * @param stickerId - 表情包文件 ID
     */
    sendSticker(chatId: number | string, stickerId: string): Promise<Message>;

    /**
     * 搜索消息
     * @param chatId - 聊天 ID
     * @param query - 搜索关键词
     * @param limit - 最大返回数量
     */
    searchMessages(
        chatId: number | string,
        query: string,
        limit?: number
    ): Promise<Message[]>;

    /**
     * 监听新消息（用于后台任务）
     *
     * @example
     * runtime.spawn("listener", async (signal) => {
     *   for await (const msg of ctx.tg.onNewMessage()) {
     *     if (signal.aborted) break;
     *     runtime.notify({
     *       type: "telegram.message",
     *       chatId: msg.chat.id,
     *       text: msg.text,
     *       fromUser: msg.sender.firstName
     *     });
     *   }
     * })
     */
    onNewMessage(): AsyncIterable<Message>;

    /**
     * 获取当前用户信息
     * @returns 当前登录的用户
     */
    getMe(): Promise<User>;
}

/**
 * Telegram 客户端实例，在 bootstrap 时通过 ctx.tg 设置
 * @example
 * const msgs = await ctx.tg.getMessages(-100123456, { limit: 10 });
 * console.log(msgs.map(m => `${m.sender.firstName}: ${m.text}`));
 */
declare const tg: TelegramClient;
