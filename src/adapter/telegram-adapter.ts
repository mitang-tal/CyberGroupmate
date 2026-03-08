/**
 * telegram-adapter.ts — 官方 Telegram ingress adapter
 *
 * 宿主侧负责：
 * - 建立 mtcute 连接
 * - 监听 Telegram 消息并标准化后推入 NotificationCenter
 * - 通过 host-call 为 sandbox 提供 ctx.tg 代码接口
 */

import type { NotificationCenter } from "../event/notification-center.js";
import type { TelegramConfig } from "../core/config.js";
import type { PlatformAdapter } from "./platform-adapter.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("telegram-adapter");

interface PromptHandler {
    (prompt: string): Promise<string>;
}

interface PrintHandler {
    (message: string): void;
}

interface TelegramClientLike {
    start(params: Record<string, unknown>): Promise<unknown>;
    onNewMessage: {
        add(handler: (msg: unknown) => void | Promise<void>): void;
        remove(handler: (msg: unknown) => void | Promise<void>): void;
    };
    destroy?(): Promise<void>;
    getMe?(): Promise<unknown>;
    sendText?(chatId: unknown, text: unknown, opts?: unknown): Promise<unknown>;
    sendMedia?(chatId: unknown, media: unknown, opts?: unknown): Promise<unknown>;
    getChat?(chatId: unknown): Promise<unknown>;
    getUser?(userId: unknown): Promise<unknown>;
    getChatMembers?(chatId: unknown, params?: unknown): Promise<unknown[]>;
    getHistory?(chatId: unknown, params?: unknown): Promise<unknown[]>;
    iterDialogs?(params?: unknown): AsyncIterable<unknown>;
    readHistory?(chatId: unknown): Promise<void>;
    sendTyping?(chatId: unknown): Promise<void>;
}

type TelegramClientFactory = (config: TelegramConfig) => Promise<TelegramClientLike>;

interface PlainUser {
    id: string;
    displayName?: string;
    title?: string;
    username?: string;
    firstName?: string;
    lastName?: string;
    isBot: boolean;
}

interface PlainChat {
    id: string;
    title?: string;
    username?: string;
    type: "private" | "group" | "supergroup" | "channel";
}

interface PlainMessage {
    id: string;
    text: string;
    date: string;
    chat: PlainChat;
    sender: PlainUser | null;
    isMention: boolean;
    replyToMessage?: { id: string } | null;
    media?: unknown;
}

interface PlainDialog {
    peer: PlainUser | PlainChat;
    lastMessage?: PlainMessage;
    unreadCount: number;
}

export class TelegramAdapter implements PlatformAdapter {
    readonly platform = "telegram";

    private client: any | null = null;
    private selfUser: PlainUser | null = null;
    private messageHandler: ((msg: any) => Promise<void>) | null = null;

    constructor(
        private config: TelegramConfig,
        private nc: NotificationCenter,
        private promptUser: PromptHandler,
        private print: PrintHandler = console.log,
        private createClient: TelegramClientFactory = defaultTelegramClientFactory,
    ) {}

    async start(): Promise<void> {
        if (this.client) return;

        this.validateConfig();

        const client = await this.createClient(this.config);

        const self = this.config.mode === "bot"
            ? await client.start({ botToken: this.config.botToken })
            : await client.start({
                phone: () => this.config.phone,
                code: async () => this.promptUser("请输入 Telegram 验证码: "),
                password: async () => this.promptUser("请输入 Telegram 两步验证密码: "),
                codeSentCallback: (sentCode: { type?: string }) => {
                    this.print(`📱 Telegram 验证码已发送 (${sentCode?.type ?? "unknown"})`);
                },
            });

        this.client = client;
        this.selfUser = this.normalizeUser(self);

        this.messageHandler = async (msg: any) => {
            const normalized = this.normalizeIncomingMessage(msg);
            if (!normalized || !normalized.messageId || !normalized.text) return;

            log.debug("接收 Telegram 消息", {
                messageId: normalized.messageId,
                chatId: normalized.chatId,
                userId: normalized.userId,
                chatType: normalized.chatType,
                isDirectMessage: normalized.isDirectMessage,
                mentionsAgent: normalized.mentionsAgent,
                textPreview: normalized.text.slice(0, 80),
            });

            this.nc.push({
                type: "nc.message",
                scene: "telegram",
                source: {
                    scene: "telegram",
                    platform: "telegram",
                    chatId: normalized.chatId,
                    userId: normalized.userId,
                    chatType: normalized.chatType,
                    messageId: normalized.messageId,
                    replyToMessageId: normalized.replyToMessageId,
                },
                chatId: normalized.chatId,
                userId: normalized.userId,
                displayName: normalized.displayName,
                text: normalized.text,
                timestamp: normalized.timestamp,
                messageId: normalized.messageId,
                replyToMessageId: normalized.replyToMessageId,
                chatTitle: normalized.chatTitle,
                chatType: normalized.chatType,
                isDirectMessage: normalized.isDirectMessage,
                mentionsAgent: normalized.mentionsAgent,
                payload: {
                    scene: "telegram",
                    chatId: normalized.chatId,
                    userId: normalized.userId,
                    displayName: normalized.displayName,
                    text: normalized.text,
                    timestamp: normalized.timestamp,
                    messageId: normalized.messageId,
                    replyToMessageId: normalized.replyToMessageId,
                    chatTitle: normalized.chatTitle,
                    chatType: normalized.chatType,
                    isDirectMessage: normalized.isDirectMessage,
                    mentionsAgent: normalized.mentionsAgent,
                    source: {
                        scene: "telegram",
                        platform: "telegram",
                        chatId: normalized.chatId,
                        userId: normalized.userId,
                        chatType: normalized.chatType,
                        messageId: normalized.messageId,
                        replyToMessageId: normalized.replyToMessageId,
                    },
                    platformData: {
                        originalType: "telegram.message",
                    },
                },
                _urgent: normalized.isDirectMessage || normalized.mentionsAgent || normalized.replyToMessageId ? true : false,
            });
        };

        client.onNewMessage.add(this.messageHandler);
        this.print(`✅ TelegramAdapter 已启动: ${this.selfUser.displayName ?? this.selfUser.firstName ?? this.selfUser.id} (${this.selfUser.id})`);
    }

    async stop(): Promise<void> {
        if (!this.client) return;

        if (this.messageHandler) {
            this.client.onNewMessage.remove(this.messageHandler);
            this.messageHandler = null;
        }

        if (typeof this.client.destroy === "function") {
            await this.client.destroy();
        }

        this.client = null;
        this.selfUser = null;
    }

    canHandle(method: string): boolean {
        return method.startsWith("telegram.");
    }

    getSceneTypeDefs(scene: string, baseTypeDefs: string): string | undefined {
        if (scene !== "telegram") return undefined;

        const filtered = this.config.mode === "userbot"
            ? baseTypeDefs.replace(/^\s*\/\/ \[USERBOT_ONLY_BEGIN\]\s*$/gm, "").replace(/^\s*\/\/ \[USERBOT_ONLY_END\]\s*$/gm, "")
            : baseTypeDefs.replace(/^\s*\/\/ \[USERBOT_ONLY_BEGIN\]\s*$[\s\S]*?^\s*\/\/ \[USERBOT_ONLY_END\]\s*$/gm, "");

        const modeNote = this.config.mode === "bot"
            ? "// 当前 Telegram adapter 模式: bot\n// 注意: bot mode 下不应使用历史读取、对话遍历、读回执、成员枚举等受限 API。\n"
            : "// 当前 Telegram adapter 模式: userbot\n// 可使用完整的 Telegram host proxy 能力面。\n";

        return `${modeNote}\n${filtered}`.trim();
    }

    async handleCall(method: string, args: unknown[]): Promise<unknown> {
        if (!this.client) {
            throw new Error("TelegramAdapter is not started");
        }

        switch (method) {
            case "telegram.getMe":
                return this.selfUser ?? this.normalizeUser(await this.client.getMe());
            case "telegram.sendText":
                return this.normalizeMessage(
                    await this.client.sendText(this.normalizePeerArg(args[0]), args[1], args[2]),
                );
            case "telegram.sendMedia":
                return this.normalizeMessage(
                    await this.client.sendMedia(this.normalizePeerArg(args[0]), args[1], args[2]),
                );
            case "telegram.getChat":
                return this.normalizeChat(await this.client.getChat(this.normalizePeerArg(args[0])));
            case "telegram.getUser":
                return this.normalizeUser(await this.client.getUser(this.normalizePeerArg(args[0])));
            case "telegram.getChatMembers": {
                const peers = await this.client.getChatMembers(this.normalizePeerArg(args[0]), args[1]);
                return peers.map((peer: any) => this.normalizePeer(peer));
            }
            case "telegram.getHistory": {
                const messages = await this.client.getHistory(this.normalizePeerArg(args[0]), args[1]);
                return messages.map((message: any) => this.normalizeMessage(message));
            }
            case "telegram.getDialogs": {
                const limit = this.readLimit(args[0], 20);
                const dialogs: PlainDialog[] = [];
                for await (const dialog of this.client.iterDialogs({ limit })) {
                    dialogs.push(this.normalizeDialog(dialog));
                }
                return dialogs;
            }
            case "telegram.readHistory":
                await this.client.readHistory(this.normalizePeerArg(args[0]));
                return null;
            case "telegram.sendTyping":
                await this.client.sendTyping(this.normalizePeerArg(args[0]));
                return null;
            default:
                throw new Error(`Unsupported TelegramAdapter call: ${method}`);
        }
    }

    private validateConfig(): void {
        if (!this.config.apiId || !this.config.apiHash) {
            throw new Error("Telegram API credentials are missing in config.yaml (telegram.api_id / telegram.api_hash)");
        }

        if (this.config.mode === "bot" && !this.config.botToken) {
            throw new Error("telegram.bot_token is required in bot mode");
        }

        if (this.config.mode === "userbot" && !this.config.phone) {
            throw new Error("telegram.phone is required in userbot mode");
        }
    }

    private readLimit(value: unknown, fallback: number): number {
        if (typeof value === "object" && value && "limit" in value) {
            const limit = Number((value as { limit?: unknown }).limit);
            return Number.isNaN(limit) ? fallback : limit;
        }
        return fallback;
    }

    private normalizePeerArg(value: unknown): unknown {
        if (typeof value !== "string") return value;
        const trimmed = value.trim();
        if (/^-?\d+$/.test(trimmed)) {
            const asNumber = Number(trimmed);
            if (Number.isSafeInteger(asNumber)) return asNumber;
        }
        return value;
    }

    private normalizeIncomingMessage(msg: any): {
        chatId: string;
        userId: string;
        displayName: string;
        text: string;
        timestamp: string;
        messageId?: string;
        replyToMessageId?: string;
        chatTitle?: string;
        chatType?: string;
        isDirectMessage?: boolean;
        mentionsAgent?: boolean;
    } | null {
        const plain = this.normalizeMessage(msg);
        if (!plain.chat?.id) return null;

        const senderId = plain.sender?.id ?? "0";
        const numericChatId = Number(plain.chat.id);
        const isDirectMessage = plain.chat.type === "private" || (!Number.isNaN(numericChatId) && numericChatId > 0);
        const mentionsAgent = Boolean(
            plain.isMention ||
            (this.selfUser && plain.replyToMessage && plain.sender?.id !== this.selfUser.id),
        );

        return {
            chatId: plain.chat.id,
            userId: senderId,
            displayName: plain.sender?.displayName ?? plain.sender?.firstName ?? "Unknown",
            text: plain.text ?? "",
            timestamp: plain.date,
            messageId: plain.id,
            replyToMessageId: plain.replyToMessage?.id ?? undefined,
            chatTitle: plain.chat.title,
            chatType: plain.chat.type,
            isDirectMessage,
            mentionsAgent,
        };
    }

    private normalizeDialog(dialog: any): PlainDialog {
        return {
            peer: this.normalizePeer(dialog?.peer),
            lastMessage: dialog?.lastMessage ? this.normalizeMessage(dialog.lastMessage) : undefined,
            unreadCount: Number(dialog?.unreadCount ?? 0),
        };
    }

    private normalizeMessage(message: any): PlainMessage {
        return {
            id: String(message?.id ?? ""),
            text: String(message?.text ?? ""),
            date: this.normalizeDate(message?.date),
            chat: this.normalizeChat(message?.chat),
            sender: message?.sender ? this.normalizeUser(message.sender) : null,
            isMention: Boolean(message?.isMention),
            replyToMessage: message?.replyToMessage ? { id: String(message.replyToMessage.id ?? "") } : undefined,
            media: message?.media,
        };
    }

    private normalizePeer(peer: any): PlainUser | PlainChat {
        const type = this.normalizeChatType(peer?.type);
        if (type === "private" || typeof peer?.firstName === "string" || typeof peer?.isBot === "boolean") {
            return this.normalizeUser(peer);
        }
        return this.normalizeChat(peer);
    }

    private normalizeUser(user: any): PlainUser {
        return {
            id: String(user?.id ?? ""),
            displayName: this.pickDisplayName(user),
            title: typeof user?.title === "string" ? user.title : undefined,
            username: typeof user?.username === "string" ? user.username : undefined,
            firstName: typeof user?.firstName === "string" ? user.firstName : undefined,
            lastName: typeof user?.lastName === "string" ? user.lastName : undefined,
            isBot: Boolean(user?.isBot),
        };
    }

    private normalizeChat(chat: any): PlainChat {
        return {
            id: String(chat?.id ?? ""),
            title: typeof chat?.title === "string" ? chat.title : this.pickDisplayName(chat),
            username: typeof chat?.username === "string" ? chat.username : undefined,
            type: this.normalizeChatType(chat?.type),
        };
    }

    private normalizeChatType(value: unknown): PlainChat["type"] {
        if (value === "private" || value === "group" || value === "supergroup" || value === "channel") {
            return value;
        }
        if (value === "user") {
            return "private";
        }
        return "group";
    }

    private normalizeDate(value: unknown): string {
        if (value instanceof Date) return value.toISOString();
        if (typeof value === "number") return new Date(value).toISOString();
        if (typeof value === "string") {
            const parsed = Date.parse(value);
            return Number.isNaN(parsed) ? new Date().toISOString() : new Date(parsed).toISOString();
        }
        return new Date().toISOString();
    }

    private pickDisplayName(value: any): string | undefined {
        if (typeof value?.displayName === "string" && value.displayName.length > 0) return value.displayName;
        if (typeof value?.title === "string" && value.title.length > 0) return value.title;
        if (typeof value?.firstName === "string" && value.firstName.length > 0) {
            const last = typeof value?.lastName === "string" && value.lastName.length > 0 ? ` ${value.lastName}` : "";
            return `${value.firstName}${last}`;
        }
        if (typeof value?.username === "string" && value.username.length > 0) return value.username;
        return undefined;
    }
}

async function defaultTelegramClientFactory(config: TelegramConfig): Promise<TelegramClientLike> {
    const { TelegramClient } = await import("@mtcute/node");
    return new TelegramClient({
        apiId: Number(config.apiId),
        apiHash: config.apiHash,
        storage: "workspace/tg-session/account",
    }) as TelegramClientLike;
}
