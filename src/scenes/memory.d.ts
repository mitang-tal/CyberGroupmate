/**
 * memory.d.ts — Memory 场景类型定义 (L1)
 *
 * 记忆系统接口。Agent 进入 memory 场景后看到这些类型，
 * 用于搜索、存储记忆，管理群友画像和对话摘要。
 *
 * memory: MemoryStore — 全局可用
 */

// ─── 场景管理（所有场景共用） ───
declare const scene: {
    enter(name: string): void;
    current: string;
    list(): void;
    showFullTypes(): void;
};

declare const runtime: {
    notify(event: { type: string;[key: string]: unknown }): void;
    spawn(name: string, fn: (signal: AbortSignal) => Promise<void>): void;
    kill(name: string): void;
    ps(): void;
    cron(expr: string, name: string, fn: () => Promise<void>): void;
};

declare const ctx: Record<string, any>;

// ─── Memory 类型 ───

/** 记忆条目 */
interface MemoryEntry {
    /** 记忆 ID (ULID) */
    id: string;
    /** 记忆内容 */
    content: string;
    /** 元数据 */
    metadata: Record<string, unknown>;
    /** 时间戳 (ISO 8601) */
    timestamp: string;
}

/** 群友画像 */
interface PersonProfile {
    /** 用户 ID */
    userId: string;
    /** 显示名称 */
    displayName?: string;
    /** 笔记/备注 */
    notes?: string;
    /** 个性特征标签 */
    traits?: string[];
    /** 最后互动时间 */
    lastInteraction?: string;
    /** 其他自定义字段 */
    [key: string]: unknown;
}

/** 对话摘要 */
interface ConversationSummary {
    /** 摘要 ID */
    id: string;
    /** 聊天 ID */
    chatId: string;
    /** 聊天标题 */
    chatTitle: string;
    /** 对话摘要 */
    summary: string;
    /** 关键要点 */
    keyPoints: string[];
    /** 时间戳 */
    timestamp: string;
}

/** 待办事项 */
interface TodoItem {
    /** 待办 ID */
    id: string;
    /** 描述 */
    description: string;
    /** 创建时间 */
    createdAt: string;
    /** 截止日期 */
    dueDate?: string;
    /** 是否已完成 */
    done: boolean;
}

/**
 * 记忆存储系统
 *
 * 基于 SQLite + FTS5 全文搜索。支持 CJK 文本搜索。
 */
interface MemoryStore {
    /**
     * 搜索记忆（全文搜索 + CJK 子串匹配）
     * @param query - 搜索关键词
     * @param limit - 最大返回数量，默认 10
     * @example
     * const results = memory.search("抹茶", 5);
     * results.forEach(r => console.log(r.content));
     */
    search(query: string, limit?: number): MemoryEntry[];

    /**
     * 存入一条记忆
     * @param content - 记忆内容文本
     * @param metadata - 附加元数据（来源、聊天 ID 等）
     * @returns 记忆 ID
     * @example memory.store("alice 喜欢抹茶", { source: "chat", chatId: -100123 })
     */
    store(content: string, metadata?: Record<string, unknown>): string;

    /**
     * 获取群友画像
     * @param userId - 用户 ID
     * @returns 画像对象，不存在则返回 null
     */
    getPerson(userId: string): PersonProfile | null;

    /**
     * 更新群友画像（merge 模式，数组字段自动合并去重）
     * @param userId - 用户 ID
     * @param data - 要合并的画像数据
     * @example
     * memory.updatePerson("123", {
     *   displayName: "Alice",
     *   traits: ["friendly"],
     *   notes: "喜欢抹茶拿铁"
     * })
     */
    updatePerson(userId: string, data: Partial<PersonProfile>): void;

    /**
     * 获取最近的对话摘要
     * @param chatId - 可选，过滤特定聊天
     * @param limit - 最大返回数量，默认 10
     */
    getRecentConversations(chatId?: string, limit?: number): ConversationSummary[];

    /**
     * 获取待办事项
     * @param includeCompleted - 是否包含已完成项，默认 false
     */
    getPendingTasks(includeCompleted?: boolean): TodoItem[];

    /**
     * 添加待办事项
     * @param description - 待办描述
     * @param dueDate - 截止日期（ISO 8601，可选）
     * @returns 待办 ID
     */
    addTodo(description: string, dueDate?: string): string;

    /**
     * 直接执行 SQL 查询（高级用法）
     * @param sql - SQL 语句
     * @param params - 参数
     * @returns 查询结果
     * @example
     * const rows = memory.rawQuery("SELECT * FROM memories WHERE content MATCH ?", "keyword");
     */
    rawQuery(sql: string, ...params: unknown[]): unknown;
}

/** 全局记忆存储实例 */
declare const memory: MemoryStore;
