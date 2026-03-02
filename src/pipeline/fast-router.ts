/**
 * phase6/fast-router.ts — 消息快速路由
 *
 * 对从 NotificationCenter drain 出来的消息进行分类路由：
 *
 * 1. 被直接 @、回复 agent 消息、私聊 → FAST_PATH（跳过 Recording，直接进 Reply Pipeline）
 * 2. 属于 ENGAGED 话题的消息 → 转交 EngagedTopicHandler
 * 3. 其他群聊消息 → 进入 RecordingPipeline 缓冲
 */

import { createLogger } from "../core/logger.js";
import type { TopicRegistry } from "./topic-registry.js";
import type { EngagedTopicHandler } from "./engaged-topic-handler.js";
import type { RecordingPipeline } from "./recording-pipeline.js";
import type { Message, RouteResult, EngagedRelevance } from "./types.js";
import type { NotificationEvent } from "../event/notification-center.js";

const log = createLogger("fast-router");

/**
 * FastRouter — 消息快速路由器
 *
 * 将从 NotificationCenter 获取的事件转换为 Message 并路由。
 */
export class FastRouter {
    /** Agent 自身的 user ID（用于检测 @ 和回复） */
    private agentUserId: number;

    /** Agent 发送过的消息 ID 集合（用于检测回复） */
    private agentMessageIds: Set<number> = new Set();

    constructor(
        private registry: TopicRegistry,
        private engagedHandler: EngagedTopicHandler,
        private recordingPipeline: RecordingPipeline,
        agentUserId: number
    ) {
        this.agentUserId = agentUserId;
    }

    /**
     * 路由一批事件
     *
     * @returns 需要 FAST_PATH 处理的消息列表（由 main.ts 送入 CodeAct session）
     */
    routeEvents(events: NotificationEvent[]): Message[] {
        const fastPathMessages: Message[] = [];

        for (const event of events) {
            const msg = this.eventToMessage(event);
            if (!msg) continue;

            const result = this.routeMessage(msg);

            switch (result.type) {
                case "FAST_PATH":
                    log.info("FAST_PATH", { msgId: msg.id, reason: result.reason });
                    fastPathMessages.push(result.message);
                    // FAST_PATH 消息也进 recording 缓冲，用于记忆更新
                    this.recordingPipeline.onMessage(msg);
                    break;

                case "ENGAGED":
                    log.debug("→ ENGAGED 话题", { msgId: msg.id, topicId: result.topicId });
                    this.engagedHandler.onMessage(result.message, result.topicId);
                    // ENGAGED 消息也进 recording 缓冲
                    this.recordingPipeline.onMessage(msg);
                    break;

                case "RECORDING":
                    log.debug("→ Recording 缓冲", { msgId: msg.id });
                    this.recordingPipeline.onMessage(result.message);
                    break;
            }
        }

        return fastPathMessages;
    }

    /**
     * 路由单条消息
     */
    routeMessage(msg: Message): RouteResult {
        // 1. FAST_PATH 检测
        if (this.isDirectMention(msg)) {
            return { type: "FAST_PATH", message: msg, reason: "direct_mention" };
        }
        if (this.isReplyToAgent(msg)) {
            return { type: "FAST_PATH", message: msg, reason: "reply_to_agent" };
        }
        if (this.isPrivateChat(msg)) {
            return { type: "FAST_PATH", message: msg, reason: "private_chat" };
        }

        // 2. ENGAGED 话题检测
        const engagedTopics = this.registry.getEngaged(msg.chatId);
        for (const topic of engagedTopics) {
            const relevance = this.engagedHandler.belongsToEngagedTopic(msg, topic);
            if (relevance !== "CLEARLY_UNRELATED") {
                return { type: "ENGAGED", message: msg, topicId: topic.id };
            }
        }

        // 3. 默认进入 Recording 缓冲
        return { type: "RECORDING", message: msg };
    }

    /**
     * 记录 Agent 发出的消息 ID（用于回复检测）
     */
    recordAgentMessage(messageId: number): void {
        this.agentMessageIds.add(messageId);
        // 只保留最近 500 条
        if (this.agentMessageIds.size > 500) {
            const iter = this.agentMessageIds.values();
            this.agentMessageIds.delete(iter.next().value!);
        }
    }

    /**
     * 将 NotificationEvent 转换为 Message
     */
    private eventToMessage(event: NotificationEvent): Message | null {
        if (event.type !== "telegram.message" && event.type !== "telegram.edited") {
            return null;
        }

        const e = event as NotificationEvent & {
            messageId?: number;
            chatId?: number;
            userId?: number;
            userName?: string;
            text?: string;
            replyToMessageId?: number;
        };

        if (!e.messageId || !e.chatId || !e.text) return null;

        return {
            id: e.messageId,
            chatId: e.chatId,
            senderId: e.userId ?? 0,
            senderName: e.userName ?? "Unknown",
            text: e.text,
            replyToMessageId: e.replyToMessageId,
            timestamp: new Date(event._ts).getTime(),
        };
    }

    /**
     * 检测是否被直接 @
     */
    private isDirectMention(msg: Message): boolean {
        // bot 模式下通常包含 /command 或 @botname
        // userbot 模式下检测 mention entity
        // 简化实现：检查消息中是否包含 agent 相关标记
        return msg.text.includes(`@${this.agentUserId}`) ||
               msg.text.startsWith("/");
    }

    /**
     * 检测是否回复 agent 的消息
     */
    private isReplyToAgent(msg: Message): boolean {
        if (!msg.replyToMessageId) return false;
        return this.agentMessageIds.has(msg.replyToMessageId);
    }

    /**
     * 检测是否私聊
     */
    private isPrivateChat(msg: Message): boolean {
        // Telegram 私聊 chatId > 0（群组是负数）
        return msg.chatId > 0;
    }
}
