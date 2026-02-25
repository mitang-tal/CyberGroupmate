/**
 * session-runner.ts — CodeAct Session Runner
 *
 * 运行一个完整的 CodeAct 交互 session：LLM 生成思考和代码 → 
 * sandbox 执行代码 → 结果作为 observation 反馈 → 重复直到完成。
 *
 * 在整体架构中的位置：
 * - Orchestrator (main.ts) 在处理事件时调用 runCodeActSession
 * - Bootstrap 流程使用此 runner 让 agent 自主完成初始化
 * - 每个 session 的完整对话记录保存到 data/sessions/
 */

import { Sandbox, ExecutionResult } from "./sandbox.js";
import { NotificationCenter } from "./notification-center.js";
import { callLLM, ChatMessage, LLMResponse } from "./llm.js";
import type { LLMConfig } from "./config.js";
import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { ulid } from "ulid";
import { createLogger } from "./logger.js";

const log = createLogger("session");

// ─── 常量 ───

/** 最大交互轮次 */
const MAX_TURNS = 15;

/** 代码执行输出最大字符数 */
const MAX_OUTPUT_CHARS = 4000;

/** 每隔多少轮检查新通知 */
const NOTIFICATION_CHECK_INTERVAL = 5;

// ─── 类型 ───

/** Session 中的一个交互轮次记录 */
export interface SessionTurn {
    /** 轮次编号 */
    turn: number;
    /** LLM 原始 response */
    assistantMessage: string;
    /** 解析出的思考文本 */
    thinking: string;
    /** 解析出的代码块列表 */
    codeBlocks: string[];
    /** 各代码块执行结果 */
    executionResults: ExecutionResult[];
    /** LLM token 用量 */
    usage?: LLMResponse["usage"];
}

/** Session 最终结果 */
export interface SessionResult {
    /** Session ID */
    sessionId: string;
    /** 所有轮次的记录 */
    turns: SessionTurn[];
    /** 完整的消息历史 */
    messages: ChatMessage[];
    /** 结束原因：no_code（agent 完成）| max_turns（达到上限）| error */
    endReason: "no_code" | "max_turns" | "error";
    /** 如果因为 error 结束，错误信息 */
    error?: string;
}

// ─── 代码块解析 ───

/**
 * 从 LLM response 中提取思考文本和代码块
 *
 * 代码块匹配 ```typescript, ```ts, ```js, ```javascript 围栏。
 * 围栏外的文本作为「思考」返回。
 *
 * @param response - LLM 的原始响应文本
 * @returns 思考文本和代码块数组
 */
export function parseResponse(response: string): {
    thinking: string;
    codeBlocks: string[];
} {
    const codeBlocks: string[] = [];
    let thinking = response;

    // 匹配 ```typescript/ts/js/javascript ... ``` 代码块
    const codeBlockRegex =
        /```(?:typescript|ts|javascript|js)\s*\n([\s\S]*?)```/g;

    let match;
    while ((match = codeBlockRegex.exec(response)) !== null) {
        codeBlocks.push(match[1].trim());
    }

    // 思考 = 原文去掉所有代码块
    thinking = response.replace(codeBlockRegex, "").trim();

    return { thinking, codeBlocks };
}

// ─── Session Runner ───

/**
 * 运行一个完整的 CodeAct 交互 session
 *
 * 流程：
 * 1. 调用 LLM 获取 response
 * 2. 解析 response：分离思考和代码块
 * 3. 没有代码块 → session 结束
 * 4. 有代码块 → 在 sandbox 中依次执行，收集输出
 * 5. 输出作为 [Execution Output] 追加到消息历史
 * 6. 每隔 5 轮检查是否有新通知
 * 7. 重复直到无代码块或达到最大轮次
 *
 * @param initialMessages - 初始消息（含 system prompt、context 等）
 * @param sandbox - Sandbox 实例
 * @param nc - NotificationCenter 实例（用于检查新通知）
 * @param llmConfig - LLM 配置
 * @param sessionsDir - Session transcript 保存目录
 * @returns Session 结果
 *
 * @example
 * ```ts
 * const result = await runCodeActSession(
 *   [{ role: "system", content: systemPrompt }, { role: "user", content: eventContext }],
 *   sandbox, nc, llmConfig, "workspace/sessions"
 * );
 * ```
 */
export async function runCodeActSession(
    initialMessages: ChatMessage[],
    sandbox: Sandbox,
    nc: NotificationCenter,
    llmConfig: LLMConfig,
    sessionsDir: string = "workspace/sessions",
    /** 每段代码的执行超时（毫秒），默认 30s，bootstrap 可设 5min */
    executeTimeout: number = 30000
): Promise<SessionResult> {
    const sessionId = ulid();
    const messages: ChatMessage[] = [...initialMessages];
    const turns: SessionTurn[] = [];

    // 确保 session 目录存在
    if (!existsSync(sessionsDir)) {
        mkdirSync(sessionsDir, { recursive: true });
    }
    const transcriptPath = join(sessionsDir, `${sessionId}.jsonl`);

    for (let turnNum = 0; turnNum < MAX_TURNS; turnNum++) {
        // ─── 调用 LLM ───
        let llmResponse: LLMResponse;
        try {
            llmResponse = await callLLM(messages, llmConfig);
        } catch (err: unknown) {
            const errorMsg =
                err instanceof Error ? err.message : String(err);
            return {
                sessionId,
                turns,
                messages,
                endReason: "error",
                error: `LLM call failed: ${errorMsg}`,
            };
        }

        const assistantText = llmResponse.content;
        messages.push({ role: "assistant", content: assistantText });

        // ─── 解析 response ───
        const { thinking, codeBlocks } = parseResponse(assistantText);

        const turn: SessionTurn = {
            turn: turnNum,
            assistantMessage: assistantText,
            thinking,
            codeBlocks,
            executionResults: [],
            usage: llmResponse.usage,
        };

        // ─── Debug: 输出本轮的思考和代码 ───
        log.debug(`Turn ${turnNum}: thinking`, { text: thinking.slice(0, 200) });
        for (let i = 0; i < codeBlocks.length; i++) {
            log.debug(`Turn ${turnNum}: code[${i}]`, { code: codeBlocks[i].slice(0, 300) });
        }

        // ─── 无代码块 → session 结束 ───
        if (codeBlocks.length === 0) {
            log.debug(`Turn ${turnNum}: 无代码块，session 结束`);
            turns.push(turn);
            appendTranscript(transcriptPath, turn);
            return {
                sessionId,
                turns,
                messages,
                endReason: "no_code",
            };
        }

        // ─── 执行代码块 ───
        const outputParts: string[] = [];

        for (const code of codeBlocks) {
            try {
                const result = await sandbox.execute(code, executeTimeout);
                turn.executionResults.push(result);

                // Debug: 输出执行结果
                log.debug(`Turn ${turnNum}: exec[${codeBlocks.indexOf(code)}]`, {
                    error: result.error,
                    output: result.output.slice(0, 300),
                });

                if (result.output) {
                    const truncated = truncateOutput(result.output);
                    const prefix = result.error
                        ? "[⚠ Execution Error]"
                        : "[Execution Output]";
                    outputParts.push(`${prefix}\n${truncated}`);
                } else if (result.error) {
                    outputParts.push("[⚠ Execution completed with error, no output]");
                }
            } catch (err: unknown) {
                const errorMsg =
                    err instanceof Error ? err.message : String(err);
                turn.executionResults.push({
                    output: errorMsg,
                    error: true,
                });
                outputParts.push(`[⚠ Sandbox Error]\n${errorMsg}`);
            }
        }

        turns.push(turn);
        appendTranscript(transcriptPath, turn);

        // ─── 组装 observation ───
        let observation = outputParts.join("\n\n");

        // 每隔 N 轮检查新通知
        if (
            (turnNum + 1) % NOTIFICATION_CHECK_INTERVAL === 0 &&
            nc.pendingCount > 0
        ) {
            const newEvents = await nc.drain(0, 5);
            if (newEvents.length > 0) {
                const eventSummary = newEvents
                    .map((e) => {
                        const preview =
                            JSON.stringify(e).slice(0, 300);
                        return `- ${e.type}: ${preview}`;
                    })
                    .join("\n");
                observation += `\n\n[📬 新通知到达 (${newEvents.length} 条)]\n${eventSummary}`;
            }
        }

        // 将 observation 作为 user 消息追加
        if (observation.trim()) {
            messages.push({ role: "user", content: observation });
        }
    }

    // 达到最大轮次
    return {
        sessionId,
        turns,
        messages,
        endReason: "max_turns",
    };
}

/**
 * 截断执行输出到最大字符数
 */
function truncateOutput(output: string): string {
    if (output.length <= MAX_OUTPUT_CHARS) return output;
    return (
        output.slice(0, MAX_OUTPUT_CHARS) +
        `\n...[truncated, ${output.length - MAX_OUTPUT_CHARS} chars omitted]`
    );
}

/**
 * 追加一个 turn 记录到 session transcript
 */
function appendTranscript(path: string, turn: SessionTurn): void {
    try {
        const record = {
            turn: turn.turn,
            thinking: turn.thinking.slice(0, 500),
            codeBlocks: turn.codeBlocks.length,
            results: turn.executionResults.map((r) => ({
                error: r.error,
                outputLength: r.output.length,
            })),
            usage: turn.usage,
            timestamp: new Date().toISOString(),
        };
        appendFileSync(path, JSON.stringify(record) + "\n", "utf-8");
    } catch {
        // 写入失败不影响主流程
    }
}
