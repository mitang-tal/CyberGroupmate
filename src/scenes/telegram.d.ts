/**
 * telegram.d.ts — Telegram 场景类型定义
 *
 * 这是系统注入的 Telegram host proxy 的接口子集。
 * 提供给 Agent 在 sandbox 执行时作为 TypeScript 强类型上下文参考。
 * 平台连接与消息监听由宿主侧官方 adapter 管理。
 */

declare const scene: {
    enter(name: string): void;
    current: string;
    list(): void;
    showFullTypes(): void;
};

declare const runtime: {
    notify(event: { type: string;[key: string]: unknown }): void;
    input(prompt: string): Promise<string>;
    print(msg: string): void;
    spawn(name: string, fn: (signal: AbortSignal) => Promise<void>): void;
    kill(name: string): void;
    ps(): string[];
};

declare const actions: {
    getTopicContext(topicId: string): Promise<Record<string, unknown> | null>;
    listActiveTopics(chatId?: string): Promise<Array<Record<string, unknown> | null>>;
    recallForTopic(topicId: string, options?: Record<string, unknown>): Promise<unknown>;
};

declare const skills: {
    memory: {
        recallAndSummarize(query: string, options?: Record<string, unknown>): Promise<unknown>;
        browseForAnswer(request: Record<string, unknown>): Promise<unknown>;
    };
    social: {
        replyInTelegram(
            chatId: number | string,
            text: string,
            opts?: { replyTo?: number }
        ): Promise<Message>;
    };
};

declare const ctx: {
    tg: TelegramClient;
    [key: string]: any;
};

/** 用户/频道/群组通用对等实体 */
interface Peer {
    id: number;
    displayName?: string;
    title?: string;
    username?: string;
}

interface User extends Peer {
    firstName: string;
    lastName?: string;
    isBot: boolean;
}

interface Chat {
    id: number;
    title?: string;
    username?: string;
    type: "private" | "group" | "supergroup" | "channel";
}

interface Message {
    id: number;
    text: string;
    date: Date;
    chat: Chat;
    sender: Peer;
    isMention: boolean;
    replyToMessage?: any;
    media?: unknown;
}

interface Dialog {
    peer: Peer;
    lastMessage?: Message;
    unreadCount: number;
}

interface Emitter<T> {
    add(handler: (event: T) => void | Promise<void>): void;
    remove(handler: (event: T) => void | Promise<void>): void;
    once(handler: (event: T) => void | Promise<void>): void;
    clear(): void;
}

/** 系统注入的 TelegramClient 代理接口。 */
interface TelegramClient {
    // ─── 发送与交互 ───
    sendText(chatId: number | string, text: string, opts?: { replyTo?: number }): Promise<Message>;
    sendMedia(chatId: number | string, media: any, opts?: { replyTo?: number, caption?: string }): Promise<Message>;

    // ─── 信息获取 ───
    getMe(): Promise<User>;
    getChat(chatId: number | string): Promise<Chat>;
    getUser(userId: number | string): Promise<User>;
    getChatMembers(chatId: number | string, opts?: { limit?: number }): Promise<Peer[]>;
    getHistory(chatId: number | string, opts?: { limit?: number }): Promise<Message[]>;

    // ─── 迭代器 (for await) ───
    iterHistory(chatId: number | string, opts?: { limit?: number }): AsyncIterable<Message>;
    iterDialogs(opts?: { limit?: number }): AsyncIterable<Dialog>;

    // ─── 状态操作 ───
    readHistory(chatId: number | string): Promise<void>;
    sendTyping(chatId: number | string): Promise<void>;
}
