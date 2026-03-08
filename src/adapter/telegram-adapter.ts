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

interface PromptHandler {
    (prompt: string): Promise<string>;
}

interface PrintHandler {
    (message: string): void;
}

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
    ) {}

    async start(): Promise<void> {
        if (this.client) return;

        this.validateConfig();

        const { TelegramClient } = await import("@mtcute/node");
        const client = new TelegramClient({
            apiId: Number(this.config.apiId),
            apiHash: this.config.apiHash,
            storage: "workspace/tg-session/account",
        });

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

            this.nc.push({
                type: "nc.message",
                scene: "telegram",
                chatId: normalized.chatId,
                userId: normalized.userId,
                displayName: normalized.displayName,
                text: normalized.text,
                timestamp: normalized.timestamp,
                messageId: normalized.messageId,
                replyToMessageId: normalized.replyToMessageId,
                chatTitle: normalized.chatTitle,
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
                    isDirectMessage: normalized.isDirectMessage,
                    mentionsAgent: normalized.mentionsAgent,
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

    async handleCall(method: string, args: unknown[]): Promise<unknown> {
        if (!this.client) {
            throw new Error("TelegramAdapter is not started");
        }

        switch (method) {
            case "telegram.getMe":
                return this.selfUser ?? this.normalizeUser(await this.client.getMe());
            case "telegram.sendText":
                return this.normalizeMessage(
                    await this.client.sendText(args[0], args[1], args[2]),
                );
            case "telegram.sendMedia":
                return this.normalizeMessage(
                    await this.client.sendMedia(args[0], args[1], args[2]),
                );
            case "telegram.getChat":
                return this.normalizeChat(await this.client.getChat(args[0]));
            case "telegram.getUser":
                return this.normalizeUser(await this.client.getUser(args[0]));
            case "telegram.getChatMembers": {
                const peers = await this.client.getChatMembers(args[0], args[1]);
                return peers.map((peer: any) => this.normalizePeer(peer));
            }
            case "telegram.getHistory": {
                const messages = await this.client.getHistory(args[0], args[1]);
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
                await this.client.readHistory(args[0]);
                return null;
            case "telegram.sendTyping":
                await this.client.sendTyping(args[0]);
                return null;
            default:
                throw new Error(`Unsupported TelegramAdapter call: ${method}`);
        }
    }

    private validateConfig(): void {
        if (!this.config.apiId || !this.config.apiHash) {
            throw new Error("Telegram API credentials are missing (TG_API_ID / TG_API_HASH)");
        }

        if (this.config.mode === "bot" && !this.config.botToken) {
            throw new Error("TG_BOT_TOKEN is required in bot mode");
        }

        if (this.config.mode === "userbot" && !this.config.phone) {
            throw new Error("TG_PHONE is required in userbot mode");
        }
    }

    private readLimit(value: unknown, fallback: number): number {
        if (typeof value === "object" && value && "limit" in value) {
            const limit = Number((value as { limit?: unknown }).limit);
            return Number.isNaN(limit) ? fallback : limit;
        }
        return fallback;
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
        isDirectMessage?: boolean;
        mentionsAgent?: boolean;
    } | null {
        const plain = this.normalizeMessage(msg);
        if (!plain.chat?.id) return null;

        const senderId = plain.sender?.id ?? "0";
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
            isDirectMessage: plain.chat.type === "private",
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
