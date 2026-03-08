/**
 * nc-event.ts — NotificationCenter 标准化事件定义
 *
 * 为 Phase 6B 提供平台无关的消息 schema，并兼容旧的 telegram.message 事件。
 */

import type { NotificationEvent } from "./notification-center.js";

export interface NCEventEnvelope<TPayload = Record<string, unknown>> {
    eventId?: string;
    kind: string;
    source?: "platform_adapter" | "agent_runtime" | "system";
    observedAt?: string;
    scene: string;
    payload: TPayload;
    dedupeKey?: string;
    traceId?: string;
}

export interface NCMessageEventPayload {
    type: "message";
    scene: string;
    chatId: string;
    userId: string;
    displayName: string;
    text: string;
    timestamp: string;
    messageId?: string;
    replyToMessageId?: string;
    threadId?: string;
    chatTitle?: string;
    isDirectMessage?: boolean;
    mentionsAgent?: boolean;
    platformData?: Record<string, unknown>;
}

export function normalizeMessageEvent(event: NotificationEvent): NCMessageEventPayload | null {
    if (event.type === "nc.message" || event.type === "im.message") {
        const payload = (event.payload ?? {}) as Record<string, unknown>;
        const scene = String(event.scene ?? payload.scene ?? "");
        const chatId = event.chatId ?? payload.chatId;
        const text = event.text ?? payload.text;
        if (!scene || chatId === undefined || typeof text !== "string") return null;

        return {
            type: "message",
            scene,
            chatId: String(chatId),
            userId: String(event.userId ?? payload.userId ?? "0"),
            displayName: String(event.displayName ?? payload.displayName ?? event.userName ?? "Unknown"),
            text,
            timestamp: String(event.timestamp ?? payload.timestamp ?? event._ts),
            messageId: event.messageId !== undefined || payload.messageId !== undefined
                ? String(event.messageId ?? payload.messageId)
                : undefined,
            replyToMessageId: event.replyToMessageId !== undefined || payload.replyToMessageId !== undefined
                ? String(event.replyToMessageId ?? payload.replyToMessageId)
                : undefined,
            chatTitle: event.chatTitle ? String(event.chatTitle) : undefined,
            isDirectMessage: typeof event.isDirectMessage === "boolean"
                ? event.isDirectMessage
                : typeof payload.isDirectMessage === "boolean"
                    ? payload.isDirectMessage
                    : undefined,
            mentionsAgent: typeof event.mentionsAgent === "boolean"
                ? event.mentionsAgent
                : typeof payload.mentionsAgent === "boolean"
                    ? payload.mentionsAgent
                    : undefined,
            platformData: (payload.platformData as Record<string, unknown>) ?? undefined,
        };
    }

    if (event.type === "telegram.message" || event.type === "telegram.edited") {
        const chatId = event.chatId;
        const text = event.text;
        if (chatId === undefined || typeof text !== "string") return null;

        return {
            type: "message",
            scene: "telegram",
            chatId: String(chatId),
            userId: String(event.userId ?? 0),
            displayName: String(event.userName ?? "Unknown"),
            text,
            timestamp: String(event._ts),
            messageId: event.messageId !== undefined ? String(event.messageId) : undefined,
            replyToMessageId: event.replyToMessageId !== undefined ? String(event.replyToMessageId) : undefined,
            chatTitle: event.chatTitle ? String(event.chatTitle) : undefined,
            isDirectMessage: typeof chatId === "number"
                ? chatId > 0
                : typeof chatId === "string" && /^-?\d+$/.test(chatId)
                    ? Number(chatId) > 0
                    : undefined,
            mentionsAgent: typeof event.isMention === "boolean" ? event.isMention : undefined,
            platformData: {
                originalType: event.type,
            },
        };
    }

    return null;
}
