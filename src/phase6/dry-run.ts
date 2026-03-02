/**
 * phase6/dry-run.ts — Dry-Run 历史回放评估系统
 *
 * 在历史聊天记录上离线模拟 agent 行为，用于评估和调优决策流水线。
 *
 * 工作方式：
 * 1. 从 JSON 文件加载历史消息
 * 2. 按时间顺序模拟事件到达
 * 3. 每条消息经过 FastRouter + RecordingPipeline + Triage
 * 4. 记录所有决策
 * 5. 输出 JSON 评估报告
 */

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { createLogger } from "../logger.js";
import type { LLMConfig } from "../llm.js";
import { TopicRegistry } from "./topic-registry.js";
import { RecordingPipeline } from "./recording-pipeline.js";
import { EngagedTopicHandler } from "./engaged-topic-handler.js";
import { FastRouter } from "./fast-router.js";
import { ModelRouter } from "./model-router.js";
import type {
    Message,
    DryRunConfig,
    DryRunResult,
    DryRunDecision,
} from "./types.js";

const log = createLogger("dry-run");

/** 历史消息文件格式（每行一个 JSON 对象） */
interface HistoryMessage {
    id: number;
    chat_id: number;
    user_id: number;
    user_name: string;
    text: string;
    date: string;          // ISO 8601
    reply_to?: number;
}

/**
 * 运行 Dry-Run 评估
 */
export async function runDryRun(
    config: DryRunConfig,
    llmConfig: LLMConfig,
    persona: string = "赛博群友",
    agentUserId: number = 0
): Promise<DryRunResult> {
    const startTime = Date.now();
    log.info("Dry-Run 开始", {
        chatId: config.chatId,
        model: config.model,
        pipelineMode: config.pipelineMode,
    });

    // ─── 加载历史消息 ───
    const messages = loadHistoryMessages(config);

    if (messages.length === 0) {
        log.warn("没有找到历史消息");
        return {
            totalMessages: 0,
            wouldReply: 0,
            wouldIgnore: 0,
            decisions: [],
            totalTokens: 0,
            totalTimeMs: Date.now() - startTime,
        };
    }

    // ─── 初始化组件 ───
    const registry = new TopicRegistry();
    const recordingPipeline = new RecordingPipeline(registry, llmConfig, persona);
    const engagedHandler = new EngagedTopicHandler(registry, llmConfig);
    const fastRouter = new FastRouter(registry, engagedHandler, recordingPipeline, agentUserId);
    const modelRouter = new ModelRouter(llmConfig);

    const decisions: DryRunDecision[] = [];
    let totalTokens = 0;

    // 收集 triage 通过的话题
    recordingPipeline.on("topic:triage-passed", (topic, decision) => {
        const route = modelRouter.route(false, decision, []);
        decisions.push({
            triggerMessage: {
                from: "topic",
                text: `话题 "${topic.label}" 通过 Triage`,
                time: new Date(topic.lastActivityAt).toISOString(),
            },
            decision: "reply",
            reason: decision.reason,
            pipelineTrace: [
                `intervention_type=${decision.intervention_type}`,
                `confidence=${decision.confidence}`,
                `model=${route.model}`,
                `mode=${route.pipelineMode}`,
            ],
        });
    });

    // ─── 按时间顺序模拟消息到达 ───
    log.info("开始模拟", { totalMessages: messages.length });

    // 分批处理，每批最多 50 条
    const BATCH_SIZE = 50;
    for (let i = 0; i < messages.length; i += BATCH_SIZE) {
        const batch = messages.slice(i, i + BATCH_SIZE);

        for (const msg of batch) {
            // 模拟消息到达
            const fastPathResults = fastRouter.routeMessage(msg);

            if (fastPathResults.type === "FAST_PATH") {
                decisions.push({
                    triggerMessage: {
                        from: msg.senderName,
                        text: msg.text.slice(0, 200),
                        time: new Date(msg.timestamp).toISOString(),
                    },
                    decision: "reply",
                    reason: `FAST_PATH: ${fastPathResults.reason}`,
                    pipelineTrace: ["FAST_PATH"],
                });
            } else {
                // 消息进入 recording 缓冲
                recordingPipeline.onMessage(msg);
            }
        }

        // 每批结束后强制 flush
        await recordingPipeline.flush();

        // 清理超时话题
        registry.cleanup();
    }

    // 最终 flush
    await recordingPipeline.flush();

    // ─── 生成报告 ───
    const totalTimeMs = Date.now() - startTime;
    const result: DryRunResult = {
        totalMessages: messages.length,
        wouldReply: decisions.filter(d => d.decision === "reply").length,
        wouldIgnore: messages.length - decisions.filter(d => d.decision === "reply").length,
        decisions,
        totalTokens,
        totalTimeMs,
    };

    log.info("Dry-Run 完成", {
        totalMessages: result.totalMessages,
        wouldReply: result.wouldReply,
        wouldIgnore: result.wouldIgnore,
        timeMs: totalTimeMs,
    });

    // 清理
    recordingPipeline.dispose();
    engagedHandler.dispose();

    return result;
}

/**
 * 加载历史消息
 */
function loadHistoryMessages(config: DryRunConfig): Message[] {
    if (config.source === "file" && config.filePath) {
        if (!existsSync(config.filePath)) {
            log.error("历史消息文件不存在", { path: config.filePath });
            return [];
        }

        try {
            const raw = readFileSync(config.filePath, "utf-8");
            const lines = raw.split("\n").filter(l => l.trim());
            const messages: Message[] = [];

            for (const line of lines) {
                try {
                    const hist = JSON.parse(line) as HistoryMessage;
                    if (config.chatId && hist.chat_id !== config.chatId) continue;
                    messages.push({
                        id: hist.id,
                        chatId: hist.chat_id,
                        senderId: hist.user_id,
                        senderName: hist.user_name,
                        text: hist.text,
                        replyToMessageId: hist.reply_to,
                        timestamp: new Date(hist.date).getTime(),
                    });
                } catch {
                    // 跳过无效行
                }
            }

            // 按时间排序
            messages.sort((a, b) => a.timestamp - b.timestamp);

            // 按天数过滤
            if (config.daysBack > 0) {
                const cutoff = Date.now() - config.daysBack * 24 * 60 * 60 * 1000;
                return messages.filter(m => m.timestamp >= cutoff);
            }

            return messages;
        } catch (err) {
            log.error("加载历史消息文件失败", { error: err instanceof Error ? err.message : String(err) });
            return [];
        }
    }

    log.warn("不支持的消息来源", { source: config.source });
    return [];
}

/**
 * 将 Dry-Run 结果输出到文件
 */
export function saveDryRunReport(result: DryRunResult, outputPath: string): void {
    const report = {
        ...result,
        generatedAt: new Date().toISOString(),
        summary: {
            totalMessages: result.totalMessages,
            wouldReply: result.wouldReply,
            wouldIgnore: result.wouldIgnore,
            replyRate: result.totalMessages > 0
                ? (result.wouldReply / result.totalMessages * 100).toFixed(1) + "%"
                : "N/A",
            totalTimeMs: result.totalTimeMs,
        },
    };

    writeFileSync(outputPath, JSON.stringify(report, null, 2));
    log.info("报告已保存", { path: outputPath });
}
