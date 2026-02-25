/**
 * memory.ts — SQLite 记忆存储
 *
 * 基于 better-sqlite3 + FTS5 全文搜索的记忆系统。
 * 提供通用记忆条目、群友画像（PersonProfile）和对话摘要的存储与检索。
 *
 * 在整体架构中的位置：
 * - Agent 通过 memory.search/store 等接口操作记忆
 * - Compaction 流程自动向此模块写入对话摘要和群友信息
 * - 注入到 sandbox 中，Agent 在 memory 场景中使用
 */

import Database from "better-sqlite3";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { ulid } from "ulid";

/** 通用记忆条目 */
export interface MemoryEntry {
    /** 记忆 ID (ULID) */
    id: string;
    /** 记忆内容 */
    content: string;
    /** 元数据（JSON 对象） */
    metadata: Record<string, unknown>;
    /** 时间戳 (ISO 8601) */
    timestamp: string;
}

/** 群友画像 */
export interface PersonProfile {
    /** 用户 ID */
    userId: string;
    /** 显示名称 */
    displayName?: string;
    /** 笔记/备注 */
    notes?: string;
    /** 个性特征标签 */
    traits?: string[];
    /** 最后交互时间 (ISO 8601) */
    lastInteraction?: string;
    /** 其他自定义字段 */
    [key: string]: unknown;
}

/** 对话摘要 */
export interface ConversationSummary {
    /** 摘要 ID (ULID) */
    id: string;
    /** 聊天 ID */
    chatId: string;
    /** 聊天标题 */
    chatTitle: string;
    /** 对话摘要文本 */
    summary: string;
    /** 关键要点 */
    keyPoints: string[];
    /** 时间戳 (ISO 8601) */
    timestamp: string;
}

/** 待办事项 */
export interface TodoItem {
    /** 待办 ID (ULID) */
    id: string;
    /** 描述 */
    description: string;
    /** 创建时间 (ISO 8601) */
    createdAt: string;
    /** 截止日期 (ISO 8601, 可选) */
    dueDate?: string;
    /** 是否已完成 */
    done: boolean;
}

/**
 * MemoryStore — SQLite 记忆存储
 *
 * 提供记忆的存储、搜索和管理。使用 FTS5 全文搜索支持快速文本检索。
 *
 * @example
 * ```ts
 * const mem = new MemoryStore("data/memory.db");
 * mem.store("alice 喜欢喝抹茶", { source: "telegram", chatId: -100123 });
 * const results = mem.search("抹茶", 5);
 * ```
 */
export class MemoryStore {
    private db: Database.Database;

    /**
     * 创建 MemoryStore 实例并初始化数据库表结构
     * @param dbPath - SQLite 数据库文件路径
     */
    constructor(dbPath: string) {
        // 确保目录存在
        const dir = dirname(dbPath);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }

        this.db = new Database(dbPath);

        // 启用 WAL 模式以提高并发性能
        this.db.pragma("journal_mode = WAL");

        this.initTables();
    }

    /**
     * 初始化数据库表结构
     */
    private initTables(): void {
        // FTS5 虚拟表：通用记忆
        this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories USING fts5(
        id UNINDEXED,
        content,
        metadata UNINDEXED,
        timestamp UNINDEXED,
        tokenize='unicode61'
      );
    `);

        // 群友画像表
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS person_profiles (
        user_id TEXT PRIMARY KEY,
        data TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL
      );
    `);

        // 对话摘要日志
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_log (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        chat_title TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL DEFAULT '',
        key_points TEXT NOT NULL DEFAULT '[]',
        timestamp TEXT NOT NULL
      );
    `);

        // 待办事项表
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS todos (
        id TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        created_at TEXT NOT NULL,
        due_date TEXT,
        done INTEGER NOT NULL DEFAULT 0
      );
    `);
    }

    /**
     * 搜索记忆
     *
     * 首先尝试 FTS5 全文搜索。如果没有结果（常见于 CJK 文本，因为 unicode61
     * tokenizer 会将中文拆分为单字），则回退到 LIKE 子串匹配。
     *
     * @param query - 搜索关键词
     * @param limit - 最大返回数量，默认 10
     * @returns 匹配的记忆条目
     */
    search(query: string, limit: number = 10): MemoryEntry[] {
        // 先尝试 FTS5 搜索
        try {
            const ftsStmt = this.db.prepare(`
        SELECT id, content, metadata, timestamp
        FROM memories
        WHERE memories MATCH ?
        ORDER BY rank
        LIMIT ?
      `);
            const ftsRows = ftsStmt.all(query, limit) as Array<{
                id: string;
                content: string;
                metadata: string;
                timestamp: string;
            }>;

            if (ftsRows.length > 0) {
                return ftsRows.map((row) => ({
                    id: row.id,
                    content: row.content,
                    metadata: JSON.parse(row.metadata),
                    timestamp: row.timestamp,
                }));
            }
        } catch {
            // FTS5 query syntax error — fall through to LIKE search
        }

        // 回退到 LIKE 子串匹配（处理 CJK 文本等场景）
        const likeStmt = this.db.prepare(`
      SELECT id, content, metadata, timestamp
      FROM memories
      WHERE content LIKE ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);
        const likeRows = likeStmt.all(`%${query}%`, limit) as Array<{
            id: string;
            content: string;
            metadata: string;
            timestamp: string;
        }>;

        return likeRows.map((row) => ({
            id: row.id,
            content: row.content,
            metadata: JSON.parse(row.metadata),
            timestamp: row.timestamp,
        }));
    }

    /**
     * 存入一条记忆
     *
     * @param content - 记忆内容文本
     * @param metadata - 附加元数据
     * @returns 生成的记忆 ID
     */
    store(content: string, metadata: Record<string, unknown> = {}): string {
        const id = ulid();
        const timestamp = new Date().toISOString();

        const stmt = this.db.prepare(`
      INSERT INTO memories (id, content, metadata, timestamp)
      VALUES (?, ?, ?, ?)
    `);

        stmt.run(id, content, JSON.stringify(metadata), timestamp);
        return id;
    }

    /**
     * 获取群友画像
     *
     * @param userId - 用户 ID
     * @returns 群友画像，不存在时返回 null
     */
    getPerson(userId: string): PersonProfile | null {
        const stmt = this.db.prepare(
            "SELECT data FROM person_profiles WHERE user_id = ?"
        );
        const row = stmt.get(userId) as { data: string } | undefined;
        if (!row) return null;

        const data = JSON.parse(row.data) as PersonProfile;
        data.userId = userId;
        return data;
    }

    /**
     * 更新群友画像（merge 模式）
     *
     * 如果画像不存在则创建。更新时将新数据与现有数据合并，
     * 数组类型字段（如 traits）会合并去重。
     *
     * @param userId - 用户 ID
     * @param updates - 要合并的画像数据
     */
    updatePerson(userId: string, updates: Partial<PersonProfile>): void {
        const existing = this.getPerson(userId);
        const merged: Record<string, unknown> = existing
            ? { ...existing }
            : { userId };

        // Merge updates
        for (const [key, value] of Object.entries(updates)) {
            if (key === "userId") continue;
            if (
                Array.isArray(value) &&
                Array.isArray(merged[key])
            ) {
                // 数组字段合并去重
                merged[key] = [...new Set([...(merged[key] as unknown[]), ...value])];
            } else {
                merged[key] = value;
            }
        }

        const stmt = this.db.prepare(`
      INSERT INTO person_profiles (user_id, data, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
    `);

        stmt.run(userId, JSON.stringify(merged), new Date().toISOString());
    }

    /**
     * 获取最近的对话摘要
     *
     * @param chatId - 过滤特定聊天（可选）
     * @param limit - 最大返回数量，默认 10
     * @returns 对话摘要数组，按时间降序
     */
    getRecentConversations(
        chatId?: string,
        limit: number = 10
    ): ConversationSummary[] {
        let sql = `
      SELECT id, chat_id, chat_title, summary, key_points, timestamp
      FROM conversation_log
    `;
        const params: unknown[] = [];

        if (chatId) {
            sql += " WHERE chat_id = ?";
            params.push(chatId);
        }

        sql += " ORDER BY timestamp DESC LIMIT ?";
        params.push(limit);

        const stmt = this.db.prepare(sql);
        const rows = stmt.all(...params) as Array<{
            id: string;
            chat_id: string;
            chat_title: string;
            summary: string;
            key_points: string;
            timestamp: string;
        }>;

        return rows.map((row) => ({
            id: row.id,
            chatId: row.chat_id,
            chatTitle: row.chat_title,
            summary: row.summary,
            keyPoints: JSON.parse(row.key_points),
            timestamp: row.timestamp,
        }));
    }

    /**
     * 存入对话摘要
     *
     * @param summary - 对话摘要数据
     * @returns 生成的摘要 ID
     */
    storeConversation(
        summary: Omit<ConversationSummary, "id" | "timestamp">
    ): string {
        const id = ulid();
        const timestamp = new Date().toISOString();

        const stmt = this.db.prepare(`
      INSERT INTO conversation_log (id, chat_id, chat_title, summary, key_points, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

        stmt.run(
            id,
            summary.chatId,
            summary.chatTitle,
            summary.summary,
            JSON.stringify(summary.keyPoints),
            timestamp
        );

        return id;
    }

    /**
     * 获取待办事项
     *
     * @param includeCompleted - 是否包含已完成的待办，默认 false
     * @returns 待办事项数组
     */
    getPendingTasks(includeCompleted: boolean = false): TodoItem[] {
        let sql = "SELECT * FROM todos";
        if (!includeCompleted) {
            sql += " WHERE done = 0";
        }
        sql += " ORDER BY created_at DESC";

        const stmt = this.db.prepare(sql);
        const rows = stmt.all() as Array<{
            id: string;
            description: string;
            created_at: string;
            due_date: string | null;
            done: number;
        }>;

        return rows.map((row) => ({
            id: row.id,
            description: row.description,
            createdAt: row.created_at,
            dueDate: row.due_date ?? undefined,
            done: row.done === 1,
        }));
    }

    /**
     * 添加待办事项
     *
     * @param description - 待办描述
     * @param dueDate - 截止日期（可选）
     * @returns 生成的待办 ID
     */
    addTodo(description: string, dueDate?: string): string {
        const id = ulid();
        const stmt = this.db.prepare(`
      INSERT INTO todos (id, description, created_at, due_date, done)
      VALUES (?, ?, ?, ?, 0)
    `);
        stmt.run(id, description, new Date().toISOString(), dueDate ?? null);
        return id;
    }

    /**
     * 直接执行 SQL 查询
     *
     * Agent 高级用法——CodeAct "直接使用现有软件包" 的体现。
     *
     * @param sql - SQL 语句
     * @param params - 参数
     * @returns 查询结果
     */
    rawQuery(sql: string, ...params: unknown[]): unknown {
        const stmt = this.db.prepare(sql);
        if (
            sql.trim().toUpperCase().startsWith("SELECT") ||
            sql.trim().toUpperCase().startsWith("WITH")
        ) {
            return stmt.all(...params);
        }
        return stmt.run(...params);
    }

    /**
     * 关闭数据库连接
     */
    close(): void {
        this.db.close();
    }
}
