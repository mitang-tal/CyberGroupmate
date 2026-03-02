/**
 * safety.ts — 安全限制模块
 *
 * 实现消息发送速率限制、破坏性操作拦截、发出消息 ID 记录。
 * 保护系统不会被 agent 的代码滥用。
 *
 * 在整体架构中的位置：
 * - 在 sandbox-worker 中作为 runtime 的一部分注入
 * - 拦截特定 Telegram API 调用
 * - 记录所有发出的消息 ID 用于事后审计
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// ─── 速率限制 ───

/**
 * RateLimitError — 超过消息发送速率限制
 */
export class RateLimitError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "RateLimitError";
    }
}

/**
 * PermissionError — 尝试执行被禁止的操作
 */
export class PermissionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "PermissionError";
    }
}

/** 速率限制配置 */
export interface RateLimitConfig {
    /** 每个 session 最大发送消息数，默认 10 */
    maxMessagesPerSession: number;
    /** 每分钟最大发送消息数，默认 5 */
    maxMessagesPerMinute: number;
}

/**
 * MessageRateLimiter — 消息发送速率限制器
 *
 * 跟踪 session 内和时间窗口内的消息发送计数。
 *
 * @example
 * ```ts
 * const limiter = new MessageRateLimiter();
 * limiter.checkAndRecord("chatId", "messageId"); // 通过
 * // ... 发送很多消息后 ...
 * limiter.checkAndRecord("chatId", "messageId"); // 抛出 RateLimitError
 * ```
 */
export class MessageRateLimiter {
    private sessionCount: number = 0;
    private windowMessages: Array<{ timestamp: number }> = [];
    private config: RateLimitConfig;
    private sentMessageLog: string;

    /**
     * @param config - 速率限制配置
     * @param logPath - 发出消息 ID 记录文件路径
     */
    constructor(
        config?: Partial<RateLimitConfig>,
        logPath: string = "workspace/sent-messages.jsonl"
    ) {
        this.config = {
            maxMessagesPerSession: config?.maxMessagesPerSession ?? 10,
            maxMessagesPerMinute: config?.maxMessagesPerMinute ?? 5,
        };
        this.sentMessageLog = logPath;

        // 确保日志目录存在
        const dir = dirname(logPath);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
    }

    /**
     * 检查是否可以发送消息，如果可以则记录
     *
     * @param chatId - 目标聊天 ID
     * @param messageId - 消息 ID（发送后获得）
     * @throws RateLimitError 如果超过速率限制
     */
    checkAndRecord(
        chatId: string | number,
        messageId?: string | number
    ): void {
        // 检查 session 限制
        if (this.sessionCount >= this.config.maxMessagesPerSession) {
            throw new RateLimitError(
                `已达到 session 消息发送上限 (${this.config.maxMessagesPerSession} 条)。` +
                `请等待当前 session 结束后再发送。`
            );
        }

        // 检查时间窗口限制
        const now = Date.now();
        const oneMinuteAgo = now - 60000;
        this.windowMessages = this.windowMessages.filter(
            (m) => m.timestamp > oneMinuteAgo
        );

        if (this.windowMessages.length >= this.config.maxMessagesPerMinute) {
            throw new RateLimitError(
                `已达到每分钟消息发送上限 (${this.config.maxMessagesPerMinute} 条)。` +
                `请稍后再试。`
            );
        }

        // 记录
        this.sessionCount++;
        this.windowMessages.push({ timestamp: now });

        // 记录发出的消息 ID（用于事后审计/撤回）
        if (messageId !== undefined) {
            this.logSentMessage(chatId, messageId);
        }
    }

    /**
     * 重置 session 计数器（每个 session 结束时调用）
     */
    resetSession(): void {
        this.sessionCount = 0;
    }

    /**
     * 获取当前 session 已发送的消息数
     */
    get currentSessionCount(): number {
        return this.sessionCount;
    }

    /**
     * 记录发出的消息到 JSONL 日志
     */
    private logSentMessage(
        chatId: string | number,
        messageId: string | number
    ): void {
        try {
            const record = {
                chatId,
                messageId,
                timestamp: new Date().toISOString(),
            };
            appendFileSync(
                this.sentMessageLog,
                JSON.stringify(record) + "\n",
                "utf-8"
            );
        } catch {
            // 日志写入失败不影响主流程
        }
    }
}

// ─── 破坏性操作拦截 ───

/** 禁止的 Telegram API 方法名列表 */
const FORBIDDEN_METHODS = new Set([
    "deleteMessages",
    "deleteMessage",
    "banUser",
    "banChatMember",
    "kickChatMember",
    "restrictChatMember",
    "promoteChatMember",
    "setChatTitle",
    "setChatDescription",
    "setChatPhoto",
    "deleteChatPhoto",
    "leaveChat",
    "deleteChat",
]);

/**
 * 检查方法名是否被禁止
 *
 * @param methodName - API 方法名
 * @throws PermissionError 如果方法被禁止
 */
export function checkForbiddenMethod(methodName: string): void {
    if (FORBIDDEN_METHODS.has(methodName)) {
        throw new PermissionError(
            `操作 "${methodName}" 被禁止。这是一个破坏性操作，不允许 agent 执行。`
        );
    }
}

/**
 * 获取所有禁止的方法名列表
 */
export function getForbiddenMethods(): string[] {
    return Array.from(FORBIDDEN_METHODS);
}
