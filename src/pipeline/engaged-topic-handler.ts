/**
 * phase6/engaged-topic-handler.ts — 对话模式处理器
 *
 * 当 agent 已介入某话题（state=ENGAGED），该话题的后续消息
 * 走独立的快速路径，绕过 Recording Pipeline 的缓冲，
 * 实现自然的一问一答节奏。
 *
 * 核心功能：
 * - 消息归属判定（乐观归属 + 回退机制）
 * - 自然延迟模拟（3-15秒）
 * - quickTriage（cheap model 多维度判定）
 * - 退出信号体系（P0-P6）
 * - 退出行为风格（5种）
 */

import { EventEmitter } from "node:events";
import { createLogger } from "../core/logger.js";
import { callLLM, type LLMConfig, type ChatMessage } from "../core/llm.js";
import type { TopicRegistry } from "./topic-registry.js";
import type {
    Message,
    Topic,
    EngagedRelevance,
    ExitSignal,
    ExitStyle,
    ExitSignalType,
    QuickTriageResult,
    InterventionType,
} from "./types.js";

const log = createLogger("engaged-handler");

// ─── Prompt 模板 ───

const QUICK_TRIAGE_PROMPT = `你是一个群聊 AI 智能体的决策分析器。
AI 智能体正在参与一个对话，需要你判断以下维度：

话题背景: {TOPIC_LABEL}
AI 智能体已回复 {TURN_COUNT} 轮，最大允许 {MAX_TURNS} 轮。

最近对话上下文：
{CONTEXT}

新到达的消息：
{NEW_MESSAGES}

请输出 JSON 格式：
{
  "identityProbing": 0.0-1.0,
  "shouldContinue": true/false,
  "naturalConclusion": true/false,
  "reason": "<判断理由>",
  "replyHint": "<如果要回复，给一个方向提示>"
}

判断标准：
- identityProbing: 对方是否在试探 AI 身份（要求发自拍、测试记忆一致性、直接问"你是人还是机器人"等）
- shouldContinue: AI 是否还需要继续回复（对方只是在自说自话、已经有人接话、话题已经偏移到AI不熟悉的领域 → false）
- naturalConclusion: 对话是否自然结束了（"好的谢谢"、"知道了"、表情包收尾等）
- 只输出 JSON，不要其他内容`;

/**
 * EngagedTopicHandler — 对话模式处理器
 *
 * Events:
 * - `engaged:response-ready` (topicId: string, messages: Message[], replyHint: string)
 * - `engaged:exit` (topicId: string, signal: ExitSignal, style: ExitStyle)
 */
export class EngagedTopicHandler extends EventEmitter {
    /** 每个话题的响应调度定时器 */
    private responseTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

    constructor(
        private registry: TopicRegistry,
        private llmConfig: LLMConfig,
    ) {
        super();
    }

    /**
     * 消息归属判定
     *
     * 判断一条消息是否属于指定的 ENGAGED 话题。
     * 采用乐观归属 + 回退机制。
     */
    belongsToEngagedTopic(msg: Message, topic: Topic): EngagedRelevance {
        // 1. 强信号：reply chain 指向话题内消息
        if (msg.replyToMessageId && topic.messageIds.includes(msg.replyToMessageId)) {
            return "CLEARLY_RELATED";
        }

        // 2. 时间窗口 + 参与者：agent 刚回复后 90 秒内，已知参与者的消息
        if (topic.lastAgentReplyAt) {
            const timeSinceAgentReply = Date.now() - topic.lastAgentReplyAt;

            if (timeSinceAgentReply < 90_000 && topic.participantIds.has(msg.senderId)) {
                return "CLEARLY_RELATED";
            }

            // 3. 时间窗口 + 无其他活跃话题：60 秒内的任何消息
            if (timeSinceAgentReply < 60_000 && !this.registry.hasOtherEngagedTopic(msg.chatId, topic.id)) {
                return "AMBIGUOUS";
            }
        }

        return "CLEARLY_UNRELATED";
    }

    /**
     * 处理 ENGAGED 话题的新消息
     *
     * 按归属结果执行不同逻辑（乐观归属 + 回退机制）。
     */
    onMessage(msg: Message, topicId: string): void {
        const topic = this.registry.get(topicId);
        if (!topic || topic.state !== "ENGAGED") return;

        const relevance = this.belongsToEngagedTopic(msg, topic);

        if (relevance === "CLEARLY_RELATED") {
            topic.pendingMessages.push(msg);
            topic.irrelevantStreak = 0;
            this.registry.addMessages(topicId, [msg]);
            this.scheduleEngagedResponse(topic);

        } else if (relevance === "AMBIGUOUS") {
            topic.pendingMessages.push({ ...msg, _ambiguous: true });
            topic.irrelevantStreak = 0;
            this.registry.addMessages(topicId, [msg]);
            this.scheduleEngagedResponse(topic);

        } else {
            // CLEARLY_UNRELATED
            topic.irrelevantStreak++;
            if (topic.irrelevantStreak >= 3) {
                this.handleExit(topic, {
                    type: "CROWDED_OUT",
                    confidence: 1.0,
                    reason: `连续 ${topic.irrelevantStreak} 条不相关消息，对话已被冲走`,
                    timestamp: Date.now(),
                });
            }
        }
    }

    /**
     * 调度对话响应（含自然延迟）
     *
     * 如果在等待期间又有新消息到达，重置计时器。
     */
    private scheduleEngagedResponse(topic: Topic): void {
        // 取消已有的定时器
        const existing = this.responseTimers.get(topic.id);
        if (existing) {
            clearTimeout(existing);
        }

        const delay = this.calculateNaturalDelay(topic.pendingMessages, topic);
        log.debug("调度响应", { topicId: topic.id, delay, pendingCount: topic.pendingMessages.length });

        const timer = setTimeout(async () => {
            this.responseTimers.delete(topic.id);
            try {
                await this.processEngagedTurn(topic);
            } catch (err) {
                log.error("对话轮次处理失败", {
                    topicId: topic.id,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }, delay);

        this.responseTimers.set(topic.id, timer);
    }

    /**
     * 自然延迟计算
     *
     * 正常人不会秒回，需要模拟自然的回复延迟。
     */
    private calculateNaturalDelay(pending: Message[], topic: Topic): number {
        if (pending.length === 0) return 5000;

        const lastMsg = pending[pending.length - 1];

        // 基础延迟：3-8 秒
        let delay = 3000 + Math.random() * 5000;

        // 短消息（表情、"哈哈"、"好的"）→ 回复可以快一点
        if (lastMsg.text && lastMsg.text.length < 5) {
            delay = 2000 + Math.random() * 3000;
        }

        // 长消息或复杂问题 → 多想一会儿
        if (lastMsg.text && lastMsg.text.length > 100) {
            delay = 8000 + Math.random() * 7000;
        }

        // 对方连续发了多条 → 给更多时间等对方说完
        if (pending.length >= 2) {
            delay = Math.max(delay, 5000 + Math.random() * 5000);
        }

        return delay;
    }

    /**
     * 处理一轮对话
     *
     * 流程：检查退出信号 → quickTriage → Reply Pipeline
     */
    async processEngagedTurn(topic: Topic): Promise<void> {
        if (topic.state !== "ENGAGED") return;

        const messages = [...topic.pendingMessages];
        topic.pendingMessages = [];

        if (messages.length === 0) return;

        // 1. 先检查非 LLM 退出信号
        const exitSignal = this.evaluateExitConditions(topic, messages);
        if (exitSignal) {
            await this.handleExit(topic, exitSignal);
            return;
        }

        // 2. quickTriage
        const triageResult = await this.quickTriage(topic, messages);

        // 3. 根据结果决定
        if (triageResult.identityProbing > 0.5) {
            await this.handleExit(topic, {
                type: "IDENTITY_PROBING",
                confidence: triageResult.identityProbing,
                reason: `身份探测置信度 ${triageResult.identityProbing}`,
                timestamp: Date.now(),
            });
            return;
        }

        if (triageResult.naturalConclusion || !triageResult.shouldContinue) {
            await this.handleExit(topic, {
                type: "NATURAL_CONCLUSION",
                confidence: 0.8,
                reason: triageResult.reason,
                timestamp: Date.now(),
            });
            return;
        }

        // 4. 通过 → 触发 Reply
        topic.turnCount++;
        log.info("对话继续", {
            topicId: topic.id,
            turn: topic.turnCount,
            maxTurns: topic.maxTurns,
            hint: triageResult.replyHint.slice(0, 50),
        });

        this.emit("engaged:response-ready", topic.id, messages, triageResult.replyHint);
    }

    /**
     * 非 LLM 退出信号评估（纯算法）
     */
    private evaluateExitConditions(topic: Topic, messages: Message[]): ExitSignal | null {
        const now = Date.now();

        // P0: MAX_TURNS 硬上限
        if (topic.turnCount >= topic.maxTurns) {
            return {
                type: "MAX_TURNS",
                confidence: 1.0,
                reason: `已达回复上限 ${topic.maxTurns} 轮`,
                timestamp: now,
            };
        }

        // P1: SOCIAL_PRESSURE（简化检测）
        const recentTexts = messages.map(m => m.text.toLowerCase());
        const pressureWords = ["闭嘴", "别说了", "shut up", "stop", "够了", "烦死了"];
        const hasPressure = recentTexts.some(t => pressureWords.some(w => t.includes(w)));
        if (hasPressure) {
            return {
                type: "SOCIAL_PRESSURE",
                confidence: 0.9,
                reason: "检测到社交压力词汇",
                timestamp: now,
            };
        }

        // P3: TIMEOUT（由 TopicRegistry cleanup 处理，这里不重复）

        // P5: TOPIC_DRIFT（关键词重合度）
        if (topic.keywords.length > 0 && messages.length > 0) {
            const allText = messages.map(m => m.text).join(" ");
            const keywordHits = topic.keywords.filter(kw => allText.includes(kw));
            const hitRate = keywordHits.length / topic.keywords.length;
            if (hitRate === 0 && topic.turnCount >= 2) {
                return {
                    type: "TOPIC_DRIFT",
                    confidence: 0.7,
                    reason: `话题关键词无命中（0/${topic.keywords.length}），可能已漂移`,
                    timestamp: now,
                };
            }
        }

        // P6: CROWDED_OUT（在 onMessage 中处理，这里不重复）

        return null;
    }

    /**
     * quickTriage — 轻量级 LLM 多维度判定
     *
     * 合并多个判断维度到一次 cheap model 调用。
     */
    private async quickTriage(topic: Topic, messages: Message[]): Promise<QuickTriageResult> {
        const newMsgStr = messages.map(m => `${m.senderName}: ${m.text}`).join("\n");

        const prompt = QUICK_TRIAGE_PROMPT
            .replace("{TOPIC_LABEL}", topic.label)
            .replace("{TURN_COUNT}", String(topic.turnCount))
            .replace("{MAX_TURNS}", String(topic.maxTurns))
            .replace("{CONTEXT}", topic.recentContext)
            .replace("{NEW_MESSAGES}", newMsgStr);

        const llmMessages: ChatMessage[] = [
            { role: "system", content: "你是一个精确的 JSON 输出助手。只输出合法 JSON，不要任何其他内容。" },
            { role: "user", content: prompt },
        ];

        try {
            const response = await callLLM(llmMessages, this.llmConfig, {
                temperature: 0.2,
                maxTokens: 65536,
            });

            const jsonStr = response.content
                .replace(/```json\s*/g, "")
                .replace(/```\s*/g, "")
                .trim();

            return JSON.parse(jsonStr) as QuickTriageResult;
        } catch (err) {
            log.warn("quickTriage LLM 失败，默认继续", {
                error: err instanceof Error ? err.message : String(err),
            });
            return {
                identityProbing: 0,
                shouldContinue: true,
                naturalConclusion: false,
                reason: "LLM 失败，默认继续",
                replyHint: "",
            };
        }
    }

    /**
     * 退出处理
     */
    async handleExit(topic: Topic, signal: ExitSignal): Promise<void> {
        topic.exitSignals.push(signal);
        log.info("退出触发", {
            topicId: topic.id,
            label: topic.label,
            signal: signal.type,
            reason: signal.reason,
        });

        const style = this.selectExitStyle(signal);

        switch (style) {
            case "NATURAL_END":
                topic.nextReplyInstruction = "wrap_up";
                topic.exitAfterNextReply = true;
                this.registry.transition(topic.id, "EXITING");
                break;

            case "FADE_OUT":
                topic.nextReplyInstruction = "minimal_acknowledgment";
                topic.exitAfterNextReply = true;
                this.registry.transition(topic.id, "EXITING");
                break;

            case "GRACEFUL_REDIRECT":
                topic.nextReplyInstruction = "redirect_to_others";
                topic.exitAfterNextReply = true;
                this.registry.transition(topic.id, "EXITING");
                break;

            case "SILENT_WITHDRAWAL":
            case "GRADUAL_WITHDRAWAL":
                // 直接进冷却，不发最后一条消息
                this.registry.transition(topic.id, "EXITING");
                this.registry.transition(topic.id, "COOLDOWN");
                break;
        }

        this.emit("engaged:exit", topic.id, signal, style);
    }

    /**
     * 选择退出风格
     */
    private selectExitStyle(signal: ExitSignal): ExitStyle {
        switch (signal.type) {
            case "MAX_TURNS":
            case "NATURAL_CONCLUSION":
                return "NATURAL_END";

            case "IDENTITY_PROBING":
                return signal.confidence > 0.8 ? "FADE_OUT" : "GRADUAL_WITHDRAWAL";

            case "SOCIAL_PRESSURE":
            case "TIMEOUT":
            case "CROWDED_OUT":
                return "SILENT_WITHDRAWAL";

            case "DIMINISHING_RETURNS":
                return "FADE_OUT";

            case "TOPIC_DRIFT":
                return "SILENT_WITHDRAWAL";

            default:
                return "NATURAL_END";
        }
    }

    /**
     * 获取动态 MAX_TURNS
     */
    getMaxTurns(topic: Topic): number {
        let base = 5;
        if (topic.participantIds.size <= 2) base = 6;        // 一对一多聊几轮
        if (topic.decision?.intervention_type === "QUESTION_ANSWER") base = 7;
        if (topic.decision?.intervention_type === "CASUAL_CHAT") base = 3;
        return base;
    }

    /**
     * 清理定时器
     */
    dispose(): void {
        for (const timer of this.responseTimers.values()) {
            clearTimeout(timer);
        }
        this.responseTimers.clear();
    }
}
