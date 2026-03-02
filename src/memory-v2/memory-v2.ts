/**
 * memory-v2/memory-v2.ts — Memory V2 占位实现
 *
 * 读空 + 写弃模式的 MemoryStoreV2 实现。
 * 所有读方法返回空结果，所有写方法静默丢弃。
 * 确保现有流程（main loop、compaction、CLI、sandbox）可正常运行。
 *
 * 后续接入真实数据层时，替换此文件中的方法实现即可。
 *
 * 在整体架构中的位置：
 * - 替代旧的 src/memory.ts（MemoryStore）
 * - 被 main.ts、compaction.ts、cli.ts 导入使用
 * - 在 sandbox-worker.ts 中以精简版注入到 Agent 运行环境
 */

import { createLogger } from "../core/logger.js";
import type {
    IMemoryStoreV2,
    MemoryEntry,
    PersonProfile,
    ConversationSummary,
    TodoItem,
    RecallOptions,
    RecallResult,
    HistoryBrowseRequest,
    HistoryBrowseResult,
    ReflectionResult,
    PersonGroupProfile,
} from "./types.js";

const log = createLogger("memory-v2");

/** 生成简单的伪 ULID（占位用，不依赖 ulid 库） */
function stubId(): string {
    const ts = Date.now().toString(36).toUpperCase().padStart(10, "0");
    const rand = Math.random().toString(36).substring(2, 8).toUpperCase();
    return `${ts}${rand}`;
}

/**
 * MemoryStoreV2 — 占位实现
 *
 * 读空 + 写弃模式。所有方法均可安全调用，但不持久化任何数据。
 * 使用 logger 输出 debug 级别日志，方便调试。
 *
 * @example
 * ```ts
 * const mem = new MemoryStoreV2("workspace/memory.db");
 * mem.store("alice 喜欢抹茶", {}); // 静默丢弃
 * mem.search("抹茶");              // 返回 []
 * ```
 */
export class MemoryStoreV2 implements IMemoryStoreV2 {
    private dbPath: string;

    /**
     * 创建 MemoryStoreV2 占位实例
     * @param dbPath - SQLite 数据库文件路径（仅记录，不初始化）
     */
    constructor(dbPath: string) {
        this.dbPath = dbPath;
        log.info("Memory V2 stub 初始化", { dbPath, mode: "read-empty/write-discard" });
    }

    // ─── V1 兼容方法（读空+写弃） ───

    /**
     * 搜索记忆 — 始终返回空数组
     */
    search(query: string, limit: number = 10): MemoryEntry[] {
        log.debug("[stub] search", { query, limit });
        return [];
    }

    /**
     * 存入一条记忆 — 返回 ID 但不实际存储
     */
    store(content: string, metadata: Record<string, unknown> = {}): string {
        const id = stubId();
        log.debug("[stub] store (discarded)", { id, contentLen: content.length });
        return id;
    }

    /**
     * 获取群友画像 — 始终返回 null
     */
    getPerson(userId: string): PersonProfile | null {
        log.debug("[stub] getPerson", { userId });
        return null;
    }

    /**
     * 更新群友画像 — 静默丢弃
     */
    updatePerson(userId: string, updates: Partial<PersonProfile>): void {
        log.debug("[stub] updatePerson (discarded)", { userId, keys: Object.keys(updates) });
    }

    /**
     * 获取最近的对话摘要 — 始终返回空数组
     */
    getRecentConversations(chatId?: string, limit: number = 10): ConversationSummary[] {
        log.debug("[stub] getRecentConversations", { chatId, limit });
        return [];
    }

    /**
     * 存入对话摘要 — 返回 ID 但不实际存储
     */
    storeConversation(summary: Omit<ConversationSummary, "id" | "timestamp">): string {
        const id = stubId();
        log.debug("[stub] storeConversation (discarded)", { id, chatId: summary.chatId });
        return id;
    }

    /**
     * 获取待办事项 — 始终返回空数组
     */
    getPendingTasks(includeCompleted: boolean = false): TodoItem[] {
        log.debug("[stub] getPendingTasks", { includeCompleted });
        return [];
    }

    /**
     * 添加待办事项 — 返回 ID 但不实际存储
     */
    addTodo(description: string, dueDate?: string): string {
        const id = stubId();
        log.debug("[stub] addTodo (discarded)", { id, description: description.slice(0, 50) });
        return id;
    }

    /**
     * 直接执行 SQL 查询 — 返回空结果
     *
     * SELECT/WITH 查询返回空数组，其他返回 { changes: 0 }
     */
    rawQuery(sql: string, ...params: unknown[]): unknown {
        log.debug("[stub] rawQuery (no-op)", { sqlPreview: sql.slice(0, 60) });
        const trimmed = sql.trim().toUpperCase();
        if (trimmed.startsWith("SELECT") || trimmed.startsWith("WITH")) {
            return [];
        }
        return { changes: 0, lastInsertRowid: 0 };
    }

    /**
     * 关闭数据库连接 — 空操作
     */
    close(): void {
        log.debug("[stub] close");
    }

    // ─── V2 新方法（读空+写弃） ───

    /**
     * 统一记忆检索入口 — 返回空结果
     */
    async recall(query: string, options?: RecallOptions): Promise<RecallResult> {
        log.debug("[stub] recall", { query, options });
        return {
            topics: [],
            facts: [],
            persons: [],
        };
    }

    /**
     * 消息档案检索 — 返回空结果
     */
    async browseHistory(request: HistoryBrowseRequest): Promise<HistoryBrowseResult> {
        log.debug("[stub] browseHistory", { intent: request.intent });
        return {
            answer: "[Memory V2 stub] 消息档案尚未接入，暂无结果。",
            segments: [],
            messagesRead: 0,
        };
    }

    /**
     * 对指定群组进行反思总结 — 返回空结果
     */
    async reflect(chatId: string): Promise<ReflectionResult> {
        log.debug("[stub] reflect", { chatId });
        return {
            reflectedPeriod: { from: new Date().toISOString(), to: new Date().toISOString() },
            topicsSummary: [],
            personUpdates: [],
            groupUpdates: "",
            newCoreFacts: [],
            mergedEpisodes: 0,
            insights: "[Memory V2 stub] 反思功能尚未接入。",
        };
    }

    /**
     * 更新某人在某群的画像 — 返回空变更
     */
    async updatePersonProfile(userId: string, chatId: string): Promise<{
        before: Partial<PersonGroupProfile>;
        after: Partial<PersonGroupProfile>;
        changes: string;
    }> {
        log.debug("[stub] updatePersonProfile", { userId, chatId });
        return {
            before: {},
            after: {},
            changes: "[Memory V2 stub] 画像更新功能尚未接入。",
        };
    }
}
