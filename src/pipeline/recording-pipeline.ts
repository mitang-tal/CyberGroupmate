/**
 * phase6/recording-pipeline.ts — Recording Pipeline
 *
 * 后台持续运行的观察者任务。将群聊消息结构化沉淀到记忆系统，
 * 同时维护 TopicRegistry 供 Air-Reading Engine 消费。
 *
 * 核心机制：
 * - 消息缓冲：50 条 OR 2 分钟静默，取先到者
 * - 强信号加速：检测到强信号时缓冲阈值降为 15 条 / 30 秒
 * - 每次 flush 执行 4 步：
 *   1. LLM 话题聚类（cheap model）
 *   2. LLM 话题摘要 + Triage（cheap model）
 *   3. 更新 TopicRegistry
 *   4. Memory V2 写入（当前为 stub）
 */

import { EventEmitter } from "node:events";
import { createLogger } from "../core/logger.js";
import { callLLM, type LLMConfig, type ChatMessage } from "../core/llm.js";
import type { TopicRegistry } from "./topic-registry.js";
import type {
    Message,
    TopicClusteringResult,
    TopicSummaryTriageResult,
    Topic,
    TriageDecision,
} from "./types.js";

const log = createLogger("recording-pipeline");

// ─── 常量 ───

/** 正常缓冲阈值（条数） */
const NORMAL_THRESHOLD = 50;

/** 加速缓冲阈值（条数） */
const EAGER_THRESHOLD = 15;

/** 正常静默触发（毫秒） */
const NORMAL_SILENCE = 2 * 60 * 1000;  // 2 min

/** 加速静默触发（毫秒） */
const EAGER_SILENCE = 30 * 1000;       // 30 sec

// ─── Prompt 模板 ───

const TOPIC_CLUSTERING_PROMPT = `你是一个群聊消息话题分析器。
请分析以下群聊消息，将每条消息归属到一个话题中。

已有话题列表（如果有的话）：
{EXISTING_TOPICS}

新消息列表：
{MESSAGES}

请输出 JSON 格式：
{
  "assignments": [
    { "messageId": <数字>, "topicId": "<已有话题ID或NEW_1/NEW_2等>", "topicLabel": "<仅新话题>", "keywords": ["<仅新话题>"] }
  ],
  "evolutions": [
    { "parentTopicId": "<父话题ID>", "newTopicLabel": "<新话题标签>", "reason": "<演变原因>" }
  ]
}

规则：
- 如果消息属于已有话题，直接用已有话题 ID
- 如果是全新话题，用 NEW_1, NEW_2 等临时 ID，并提供 topicLabel 和 keywords
- 如果话题从已有话题演变而来（内容明显偏移但有关联），在 evolutions 中记录
- topicLabel 应为 3-5 个词，概括话题主旨
- 只输出 JSON，不要其他内容`;

const TOPIC_TRIAGE_PROMPT = `你是一个群聊 AI 智能体的决策顾问。
请分析每个话题，判断 AI 智能体是否应该介入。

AI 智能体人设：{PERSONA}

话题列表及其消息：
{TOPIC_MESSAGES}

请输出 JSON 格式：
{
  "topics": [
    {
      "topicId": "<话题ID>",
      "summary": "<一句话摘要>",
      "keyPoints": ["<要点1>", "<要点2>"],
      "should_intervene": true/false,
      "intervention_type": "FACTUAL_CORRECTION|KNOWLEDGE_GAP|QUESTION_ANSWER|RESOURCE_SHARING|CONFLICT_MEDIATION|CONSENSUS_SUMMARY|CASUAL_CHAT|NOT_APPLICABLE",
      "confidence": 0.0-1.0,
      "reason": "<判断理由>"
    }
  ]
}

判断标准：
- confidence < 0.6 一律不介入
- 优先介入：有人提问无人回答、事实性错误、群友求助
- 谨慎介入：闲聊、八卦、争吵
- 不介入：私密对话、敏感话题、已有专业人士在解答
- 注意：群里可能有多个 AI 智能体或者 Bot，看清楚话题是否与人设中描述的那个智能体一致
- 只输出 JSON，不要其他内容`;

/**
 * RecordingPipeline — 后台消息观察者
 *
 * Events:
 * - `flush:start` (messageCount: number)
 * - `flush:complete` (topics: Topic[])
 * - `flush:error` (error: Error)
 * - `topic:triage-passed` (topic: Topic, decision: TriageDecision)
 */
export class RecordingPipeline extends EventEmitter {
    private buffer: Message[] = [];
    private isEagerMode = false;
    private silenceTimer: ReturnType<typeof setTimeout> | null = null;
    private isFlushing = false;
    private disposed = false;

    constructor(
        private registry: TopicRegistry,
        private llmConfig: LLMConfig,
        private personaDescription: string = "赛博群友"
    ) {
        super();
    }

    /**
     * 消息入口 — 由 FastRouter 调用
     */
    onMessage(msg: Message): void {
        if (this.disposed) return;

        this.buffer.push(msg);

        // 重置静默计时器
        this.resetSilenceTimer();

        // 检查是否达到 flush 阈值
        const threshold = this.isEagerMode ? EAGER_THRESHOLD : NORMAL_THRESHOLD;
        if (this.buffer.length >= threshold) {
            this.triggerFlush();
            return;
        }

        // 检测强信号
        if (!this.isEagerMode && this.hasStrongSignal(msg)) {
            this.isEagerMode = true;
            log.debug("强信号检测，切换到加速模式", { msgId: msg.id });
            // 重置静默定时器为更短的间隔
            this.resetSilenceTimer();
        }
    }

    /**
     * 强信号检测
     */
    private hasStrongSignal(msg: Message): boolean {
        if (!msg.text) return false;
        return (
            msg.text.includes("?") ||
            msg.text.includes("？") ||
            msg.text.length > 200 ||
            this.matchesHotTopicKeywords(msg)
        );
    }

    /**
     * 检查是否匹配已知热门话题关键词
     */
    private matchesHotTopicKeywords(msg: Message): boolean {
        if (!msg.text) return false;
        const activeTopics = this.registry.getActive(msg.chatId);
        for (const topic of activeTopics) {
            for (const kw of topic.keywords) {
                if (msg.text.includes(kw)) return true;
            }
        }
        return false;
    }

    /**
     * 重置静默计时器
     */
    private resetSilenceTimer(): void {
        if (this.silenceTimer) {
            clearTimeout(this.silenceTimer);
        }
        const silence = this.isEagerMode ? EAGER_SILENCE : NORMAL_SILENCE;
        this.silenceTimer = setTimeout(() => {
            this.triggerFlush();
        }, silence);
    }

    /**
     * 触发 flush
     */
    private triggerFlush(): void {
        if (this.isFlushing || this.buffer.length === 0) return;
        // 使用 void 忽略 Promise 返回值
        void this.flush();
    }

    /**
     * 核心 flush 流程（4 步）
     */
    async flush(): Promise<void> {
        if (this.isFlushing || this.buffer.length === 0) return;

        this.isFlushing = true;
        const messages = [...this.buffer];
        this.buffer = [];
        this.isEagerMode = false;  // 每次 flush 后重置

        log.info("flush 开始", { messageCount: messages.length });
        this.emit("flush:start", messages.length);

        try {
            // ─── Step 1: 话题聚类 ───
            const groupedByChat = this.groupByChat(messages);

            for (const [chatId, chatMessages] of groupedByChat) {
                const existingTopics = this.registry.getByChat(chatId);

                const clustering = await this.llmTopicClustering(chatMessages, existingTopics);

                // ─── Step 2: 摘要 + Triage ───
                const triageResult = await this.llmTopicSummaryTriage(chatMessages, clustering, chatId);

                // ─── Step 3: 更新 TopicRegistry ───
                const updatedTopics = this.updateRegistry(chatId, chatMessages, clustering, triageResult);

                // ─── Step 4: Memory V2 写入（当前为 stub，静默丢弃） ───
                // TODO: 接入真实 Memory V2 数据层后实现
                log.debug("Memory V2 写入（stub）", { topicCount: updatedTopics.length });

                this.emit("flush:complete", updatedTopics);
            }
        } catch (err) {
            log.error("flush 失败", { error: err instanceof Error ? err.message : String(err) });
            this.emit("flush:error", err);
            // 把消息放回缓冲头部，避免丢失
            this.buffer.unshift(...messages);
        } finally {
            this.isFlushing = false;
        }
    }

    /**
     * Step 1: LLM 话题聚类
     */
    private async llmTopicClustering(
        messages: Message[],
        existingTopics: Topic[]
    ): Promise<TopicClusteringResult> {
        // 取最近 10 个话题（按活跃时间倒排），避免上下文过长
        const recentTopics = existingTopics
            .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
            .slice(0, 10);

        const existingTopicsStr = recentTopics.length > 0
            ? recentTopics.map(t => {
                const parts = [`- ${t.id}: "${t.label}" [${t.state}] (关键词: ${t.keywords.join(", ")})`];
                parts.push(`  消息数: ${t.messageCount}, 参与人数: ${t.participantIds.size}`);
                if (t.recentContext) {
                    parts.push(`  最近消息:\n${t.recentContext.split("\n").map(l => `    ${l}`).join("\n")}`);
                }
                return parts.join("\n");
            }).join("\n")
            : "（暂无已有话题）";

        const messagesStr = messages.map(m =>
            `[${m.id}] ${m.senderName} (${new Date(m.timestamp).toLocaleTimeString()}): ${m.text}`
        ).join("\n");

        const prompt = TOPIC_CLUSTERING_PROMPT
            .replace("{EXISTING_TOPICS}", existingTopicsStr)
            .replace("{MESSAGES}", messagesStr);

        const llmMessages: ChatMessage[] = [
            { role: "system", content: "你是一个精确的 JSON 输出助手。只输出合法 JSON，不要任何其他内容。" },
            { role: "user", content: prompt },
        ];

        const response = await callLLM(llmMessages, this.llmConfig, {
            temperature: 0.5,
            maxTokens: 65536,
        });

        try {
            // 提取 JSON（处理可能的 markdown 包裹）
            const jsonStr = response.content
                .replace(/```json\s*/g, "")
                .replace(/```\s*/g, "")
                .trim();
            return JSON.parse(jsonStr) as TopicClusteringResult;
        } catch {
            log.warn("话题聚类 LLM 输出解析失败，使用默认归类", { raw: response.content.slice(0, 200) });
            // 回退：所有消息归为一个新话题
            return {
                assignments: messages.map(m => ({
                    messageId: m.id,
                    topicId: "NEW_1",
                    topicLabel: "群聊讨论",
                    keywords: [],
                })),
                evolutions: [],
            };
        }
    }

    /**
     * Step 2: LLM 话题摘要 + Triage
     */
    private async llmTopicSummaryTriage(
        messages: Message[],
        clustering: TopicClusteringResult,
        chatId: number
    ): Promise<TopicSummaryTriageResult> {
        // 按话题分组消息
        const topicGroups = new Map<string, Message[]>();
        for (const assignment of clustering.assignments) {
            const msg = messages.find(m => m.id === assignment.messageId);
            if (!msg) continue;
            const group = topicGroups.get(assignment.topicId) ?? [];
            group.push(msg);
            topicGroups.set(assignment.topicId, group);
        }

        const topicMessagesStr = Array.from(topicGroups.entries()).map(([topicId, msgs]) => {
            const label = clustering.assignments.find(a => a.topicId === topicId)?.topicLabel ?? topicId;
            const msgLines = msgs.map(m => `  ${m.senderName}: ${m.text}`).join("\n");
            return `### 话题: ${label} (ID: ${topicId})\n${msgLines}`;
        }).join("\n\n");

        const prompt = TOPIC_TRIAGE_PROMPT
            .replace("{PERSONA}", this.personaDescription)
            .replace("{TOPIC_MESSAGES}", topicMessagesStr);

        const llmMessages: ChatMessage[] = [
            { role: "system", content: "你是一个精确的 JSON 输出助手。只输出合法 JSON，不要任何其他内容。" },
            { role: "user", content: prompt },
        ];

        const response = await callLLM(llmMessages, this.llmConfig, {
            temperature: 0.5,
            maxTokens: 65536,
        });

        try {
            const jsonStr = response.content
                .replace(/```json\s*/g, "")
                .replace(/```\s*/g, "")
                .trim();
            return JSON.parse(jsonStr) as TopicSummaryTriageResult;
        } catch {
            log.warn("话题摘要 Triage LLM 输出解析失败", { raw: response.content.slice(0, 200) });
            return { topics: [] };
        }
    }

    /**
     * Step 3: 更新 TopicRegistry
     */
    private updateRegistry(
        chatId: number,
        messages: Message[],
        clustering: TopicClusteringResult,
        triageResult: TopicSummaryTriageResult
    ): Topic[] {
        const updatedTopics: Topic[] = [];

        // 按话题分组消息
        const topicMsgMap = new Map<string, Message[]>();
        for (const assignment of clustering.assignments) {
            const msg = messages.find(m => m.id === assignment.messageId);
            if (!msg) continue;
            const group = topicMsgMap.get(assignment.topicId) ?? [];
            group.push(msg);
            topicMsgMap.set(assignment.topicId, group);
        }

        for (const [topicId, topicMsgs] of topicMsgMap) {
            let topic: Topic | undefined;

            if (topicId.startsWith("NEW_")) {
                // 新话题
                const assignment = clustering.assignments.find(a => a.topicId === topicId);
                const label = assignment?.topicLabel ?? "未命名话题";
                const keywords = assignment?.keywords ?? [];

                // 检查是否是流变
                const evolution = clustering.evolutions.find(e => e.newTopicLabel === label);
                topic = this.registry.create(chatId, label, keywords, topicMsgs, evolution?.parentTopicId);

                if (evolution?.parentTopicId) {
                    this.registry.inheritDecision(evolution.parentTopicId, topic.id);
                }
            } else {
                // 已有话题
                topic = this.registry.get(topicId);
                if (topic) {
                    this.registry.addMessages(topicId, topicMsgs);
                }
            }

            if (!topic) continue;

            // 只对 ACTIVE 状态的话题应用 Triage（已 IGNORED/ENGAGED 的不重复 triage）
            if (topic.state !== "ACTIVE") {
                log.debug("跳过已决策话题", { topicId: topic.id, state: topic.state, label: topic.label });
                updatedTopics.push(topic);
                continue;
            }

            const triage = triageResult.topics.find(t => t.topicId === topicId);
            if (triage) {
                const decision: TriageDecision = {
                    should_intervene: triage.should_intervene,
                    reason: triage.reason,
                    intervention_type: triage.intervention_type,
                    confidence: triage.confidence,
                    pipelineMode: triage.confidence > 0.8 ? "GUIDED" : "ENFORCED",
                };

                // 冷却增强：提高置信度阈值
                const threshold = topic.cooldownBoost ? 0.75 : 0.6;

                this.registry.transition(topic.id, "TRIAGING");

                if (triage.should_intervene && triage.confidence >= threshold) {
                    this.registry.setDecision(topic.id, decision);
                    this.registry.transition(topic.id, "PRELOADING");
                    this.registry.transition(topic.id, "ENGAGED");
                    this.emit("topic:triage-passed", topic, decision);
                } else {
                    this.registry.setDecision(topic.id, decision);
                    const ignoreState = triage.confidence < 0.3
                        ? "IGNORED_LOW_VALUE" as const
                        : "IGNORED" as const;
                    topic.ignoreReason = triage.reason;
                    this.registry.transition(topic.id, ignoreState);
                }
            }

            updatedTopics.push(topic);
        }

        return updatedTopics;
    }

    /**
     * 按 chatId 分组消息
     */
    private groupByChat(messages: Message[]): Map<number, Message[]> {
        const groups = new Map<number, Message[]>();
        for (const msg of messages) {
            const group = groups.get(msg.chatId) ?? [];
            group.push(msg);
            groups.set(msg.chatId, group);
        }
        return groups;
    }

    /**
     * 直接添加消息到缓冲区（不触发定时器/自动 flush）
     *
     * 用于 dry-run 模式，由外部控制 flush 时机。
     */
    addMessageDirect(msg: Message): void {
        this.buffer.push(msg);
    }

    /**
     * 获取当前缓冲大小（调试用）
     */
    get bufferSize(): number {
        return this.buffer.length;
    }

    /**
     * 停止 Pipeline
     */
    dispose(): void {
        this.disposed = true;
        if (this.silenceTimer) {
            clearTimeout(this.silenceTimer);
            this.silenceTimer = null;
        }
    }
}
