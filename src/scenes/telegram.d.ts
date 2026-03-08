/**
 * telegram.d.ts — Telegram 场景类型定义
 *
 * 这是一份真实 mtcute TelegramClient 的常用接口子集。
 * 提供给 Agent 在 sandbox 执行时作为 TypeScript 强类型上下文参考。
 * Agent 调用 scene.showFullTypes() 看到的即是此文件。
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
    self: User;
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

/**
 * Mtcute TelegramClient 接口子集。
 * 注意：这些方法都在原型链上，Object.keys 探测不到！
 */
interface TelegramClient {
    // ─── 发送与交互 ───
    sendText(chatId: number | string, text: string, opts?: { replyTo?: number }): Promise<Message>;
    sendMedia(chatId: number | string, media: any, opts?: { replyTo?: number, caption?: string }): Promise<Message>;
    replyText(msg: Message | number, text: string, opts?: any): Promise<Message>;
    editMessage(msgId: number, params: { text: string }): Promise<Message>;
    deleteMessages(chatId: number | string, msgIds: number[]): Promise<void>;
    forwardMessages(toChatId: number | string, msgs: Message[] | number[]): Promise<Message[]>;

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
    pinMessage(chatId: number | string, msgId: number): Promise<void>;
    joinChat(chatId: number | string): Promise<void>;
    leaveChat(chatId: number | string): Promise<void>;

    // ─── 事件监听器 (Emitter) ───
    readonly onNewMessage: Emitter<Message>;
    readonly onEditMessage: Emitter<Message>;
    readonly onDeleteMessage: Emitter<any>;
}
