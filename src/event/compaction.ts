/**
 * compaction.ts — Session 压缩与归档
 *
 * 每个 CodeAct session 结束后，调用 LLM 生成结构化摘要，
 * 将事实写入 core_facts、画像写入 person_group_profiles，
 * 并更新 agent-state.md。
 *
 * Memory V2 改造：
 * - 事实 → storeFact()（带 category/subject）
 * - 画像 → upsertPersonIdentity() + upsertPersonGroupProfile()
 * - 对话摘要/待办 → 由 Recording Pipeline topics 覆盖，此处不再写入
 *
 * 在整体架构中的位置：
 * - main.ts 在每个 session 结束后调用 runCompaction
 * - 使用独立的 LLM 调用（不是 agent 自己做的），保证归档可靠性
 * - 即使 agent 忘记存记忆，系统也会自动归档
 */

import { callLLM, LLMConfig, ChatMessage } from "../core/llm.js";
import { MemoryStoreV2 } from "../memory-v2/index.js";
import { SessionResult } from "../sandbox/session-runner.js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// ─── 常量 ───

/** Agent state 文件路径 */
const AGENT_STATE_PATH = "workspace/agent-state.md";

/** 摘要中每个对话最后取多少条消息用于压缩 */
const LAST_N_MESSAGES = 10;

// ─── Compaction Prompt ───

const PROMPTS_DIR = join(process.cwd(), "system-prompts");

let _compactionPrompt: string | null = null;

function getCompactionPrompt(): string {
    if (!_compactionPrompt) {
        try {
            _compactionPrompt = readFileSync(
                join(PROMPTS_DIR, "compaction-system.md"), "utf-8"
            ).trim();
        } catch {
            _compactionPrompt = "你是一个信息提取助手。请分析以下对话记录，提取结构化信息。请输出严格的 JSON 格式。";
        }
    }
    return _compactionPrompt;
}

// ─── 类型 ───

/** Compaction 结果的结构（V2） */
interface CompactionResult {
    summary: string;
    keyPoints: string[];
    newFacts: Array<{
        subject: string;
        content: string;
        category: string;
    }>;
    personUpdates: Array<{
        userId: string;
        displayName?: string;
        traits?: string[];
        interests?: string[];
        communicationStyle?: string;
    }>;
    agentStateUpdate: string;
}

// ─── Compaction 逻辑 ───

/**
 * 从 session 消息历史中提取用于 compaction 的文本
 */
function extractSessionText(session: SessionResult): string {
    const messages = session.messages;

    // 取最后 N 条消息
    const recentMessages = messages.slice(-LAST_N_MESSAGES);

    return recentMessages
        .map((m) => {
            const role = m.role === "system" ? "系统" : m.role === "user" ? "用户/观察" : "Agent";
            const content = m.content.length > 500
                ? m.content.slice(0, 500) + "...[截断]"
                : m.content;
            return `[${role}] ${content}`;
        })
        .join("\n\n---\n\n");
}

/**
 * 解析 LLM 返回的 JSON compaction 结果
 */
function parseCompactionResult(text: string): CompactionResult | null {
    try {
        // 尝试直接解析
        return JSON.parse(text) as CompactionResult;
    } catch {
        // 尝试从 markdown 代码块中提取 JSON
        const jsonMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
        if (jsonMatch) {
            try {
                return JSON.parse(jsonMatch[1].trim()) as CompactionResult;
            } catch {
                return null;
            }
        }
        return null;
    }
}

/**
 * 运行 session compaction
 *
 * 调用 LLM 分析对话记录，提取结构化信息，
 * 写入 memory 系统和 agent state。
 *
 * @param session - 完成的 session 结果
 * @param memory - MemoryStore 实例
 * @param llmConfig - LLM 配置
 * @param chatId - 对话所属的聊天 ID（可选）
 * @param chatTitle - 对话所属的聊天标题（可选）
 *
 * @example
 * ```ts
 * await runCompaction(sessionResult, memory, llmConfig, "-100123", "二次元研究所");
 * ```
 */
export async function runCompaction(
    session: SessionResult,
    memory: MemoryStoreV2,
    llmConfig: LLMConfig,
    chatId?: string,
    chatTitle?: string,
): Promise<void> {
    // 跳过太短的 session
    if (session.turns.length <= 1 && session.endReason === "no_code") {
        return;
    }

    const sessionText = extractSessionText(session);

    const messages: ChatMessage[] = [
        { role: "system", content: getCompactionPrompt() },
        { role: "user", content: `以下是对话记录：\n\n${sessionText}` },
    ];

    try {
        const response = await callLLM(messages, llmConfig, {
            maxTokens: 65536,
        });

        const result = parseCompactionResult(response.content);
        if (!result) {
            console.error("[Compaction] 无法解析 LLM 返回的 JSON");
            return;
        }

        // ─── V2: 事实 → core_facts ───
        for (const fact of result.newFacts ?? []) {
            if (typeof fact === "object" && fact.content?.trim()) {
                const validCategories = ["biographical", "preference", "anecdote", "opinion", "plan", "relationship", "general"];
                const category = validCategories.includes(fact.category) ? fact.category : "general";
                memory.storeFact(
                    fact.subject || chatId || "unknown",
                    fact.content,
                    category as any,
                    `compaction:${session.sessionId}`,
                );
            }
        }

        // ─── V2: 画像 → person_identities + person_group_profiles ───
        for (const person of result.personUpdates ?? []) {
            if (person.userId || person.displayName) {
                const id = person.userId || person.displayName || "unknown";

                // 更新全局身份
                memory.upsertPersonIdentity(id, {
                    displayName: person.displayName || id,
                    lastSeenAt: new Date().toISOString(),
                });

                // 如果有 chatId，更新群内画像
                if (chatId) {
                    memory.upsertPersonGroupProfile(id, chatId, {
                        ...(person.traits?.length ? { traits: person.traits } : {}),
                        ...(person.interests?.length ? { interests: person.interests } : {}),
                        ...(person.communicationStyle ? { communicationStyle: person.communicationStyle } : {}),
                        lastSeenAt: new Date().toISOString(),
                    });
                }
            }
        }

        // ─── 更新 agent state ───
        if (result.agentStateUpdate?.trim()) {
            updateAgentState(result.agentStateUpdate, result.summary);
        }

        console.log(
            `[Compaction] 完成: ${result.newFacts?.length ?? 0} facts, ` +
            `${result.personUpdates?.length ?? 0} person updates`
        );
    } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error(`[Compaction] 失败: ${errorMsg}`);
        // Compaction 失败不影响主流程
    }
}

/**
 * 更新 agent-state.md
 *
 * 追加新的状态更新到文件末尾，保持文件简洁。
 */
function updateAgentState(stateUpdate: string, summary: string): void {
    const timestamp = new Date().toISOString();
    let currentState = "";

    if (existsSync(AGENT_STATE_PATH)) {
        currentState = readFileSync(AGENT_STATE_PATH, "utf-8");
    }

    // 追加新条目
    const entry = `\n## ${timestamp}\n\n**摘要**: ${summary}\n\n${stateUpdate}\n`;
    const newState = currentState + entry;

    // 如果文件太长，只保留最后 3000 字符
    const maxChars = 3500;
    const finalState =
        newState.length > maxChars
            ? "# Agent State\n\n...[早期记录已省略]\n\n" +
            newState.slice(newState.length - maxChars)
            : newState.startsWith("# Agent State")
                ? newState
                : "# Agent State\n" + newState;

    writeFileSync(AGENT_STATE_PATH, finalState, "utf-8");
}
