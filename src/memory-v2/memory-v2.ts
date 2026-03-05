/**
 * memory-v2/memory-v2.ts — Memory V2 真实 SQLite 实现
 *
 * 基于 better-sqlite3 的 MemoryStoreV2 实现。
 * 参考设计文档 memory.md v3.0。
 *
 * 在整体架构中的位置：
 * - 被 main.ts、compaction.ts、cli.ts 导入使用
 * - Recording Pipeline Step 4 调用写入方法（upsertTopic, storeMessageBatch）
 * - 在 sandbox-worker.ts 中以精简版注入到 Agent 运行环境
 */

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { createLogger } from "../core/logger.js";
import type {
    IMemoryStoreV2,
    TopicNode,
    PersonIdentity,
    PersonGroupProfile,
    InteractionEpisode,
    GroupModel,
    CoreFact,
    FactCategory,
    MessageLogEntry,
    RecallOptions,
    RecallResult,
    HistoryBrowseRequest,
    HistoryBrowseResult,
    ReflectionResult,
} from "./types.js";

const log = createLogger("memory-v2");

// ─── JSON 工具函数 ───

function toJSON(value: unknown): string {
    return JSON.stringify(value ?? []);
}

function fromJSON<T>(raw: string | null | undefined, fallback: T): T {
    if (!raw) return fallback;
    try {
        return JSON.parse(raw) as T;
    } catch {
        return fallback;
    }
}

function now(): string {
    return new Date().toISOString();
}

// ─── MemoryStoreV2 实现 ───

/**
 * MemoryStoreV2 — SQLite 实现
 *
 * 使用 better-sqlite3 同步 API。所有 JSON 数组字段以 TEXT 存储。
 * FTS5 虚拟表用于中文全文搜索（Phase M1 基础版）。
 *
 * @example
 * ```ts
 * const mem = new MemoryStoreV2("workspace/memory.db");
 * mem.upsertTopic("t_001", { label: "京都旅行", summary: "讨论京都岚山" });
 * const result = await mem.recall("京都");
 * ```
 */
export class MemoryStoreV2 implements IMemoryStoreV2 {
    private db: Database.Database;

    constructor(dbPath: string) {
        this.db = new Database(dbPath);
        this.db.pragma("journal_mode = WAL");
        this.db.pragma("foreign_keys = ON");
        this.initTables();
        log.info("Memory V2 SQLite 初始化完成", { dbPath });
    }

    // ─── 建表 ───

    private initTables(): void {
        this.db.exec(`
            -- 话题节点
            CREATE TABLE IF NOT EXISTS topics (
                id TEXT PRIMARY KEY,
                pipeline_topic_id TEXT,
                chat_id TEXT NOT NULL,
                label TEXT NOT NULL,
                summary TEXT NOT NULL DEFAULT '',
                key_points TEXT NOT NULL DEFAULT '[]',
                participants TEXT NOT NULL DEFAULT '[]',
                keywords TEXT NOT NULL DEFAULT '[]',
                first_message_id INTEGER,
                last_message_id INTEGER,
                message_count INTEGER DEFAULT 0,
                started_at TEXT NOT NULL,
                ended_at TEXT,
                sentiment TEXT DEFAULT 'neutral',
                related_topic_ids TEXT DEFAULT '[]',
                was_engaged BOOLEAN DEFAULT 0,
                intervention_count INTEGER DEFAULT 0,
                embedding BLOB,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_topics_chat_date ON topics(chat_id, started_at);
            CREATE INDEX IF NOT EXISTS idx_topics_pipeline_id ON topics(pipeline_topic_id);

            -- 个体身份（全局，跨群）
            CREATE TABLE IF NOT EXISTS person_identities (
                user_id TEXT PRIMARY KEY,
                display_name TEXT NOT NULL DEFAULT '',
                aliases TEXT NOT NULL DEFAULT '[]',
                total_message_count INTEGER DEFAULT 0,
                last_seen_at TEXT,
                first_seen_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            -- 个体群内画像（每群独立）
            CREATE TABLE IF NOT EXISTS person_group_profiles (
                user_id TEXT NOT NULL,
                chat_id TEXT NOT NULL,
                dunbar_tier INTEGER NOT NULL DEFAULT 4,
                dunbar_reason TEXT DEFAULT '',
                traits TEXT NOT NULL DEFAULT '[]',
                interests TEXT NOT NULL DEFAULT '[]',
                communication_style TEXT DEFAULT '',
                relation_to_agent TEXT DEFAULT '',
                recent_episodes TEXT DEFAULT '[]',
                merged_memory TEXT DEFAULT '[]',
                message_count INTEGER DEFAULT 0,
                last_seen_at TEXT,
                active_hours TEXT DEFAULT '[]',
                first_seen_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (user_id, chat_id)
            );
            CREATE INDEX IF NOT EXISTS idx_pgp_chat ON person_group_profiles(chat_id);

            -- 群组画像
            CREATE TABLE IF NOT EXISTS group_models (
                chat_id TEXT PRIMARY KEY,
                chat_title TEXT NOT NULL DEFAULT '',
                description TEXT DEFAULT '',
                dominant_language TEXT DEFAULT 'zh',
                communication_norms TEXT DEFAULT '[]',
                active_members INTEGER DEFAULT 0,
                avg_messages_per_day REAL DEFAULT 0,
                peak_hours TEXT DEFAULT '[]',
                agent_role TEXT DEFAULT '',
                engagement_level TEXT DEFAULT 'medium',
                recent_feedback TEXT DEFAULT '',
                hot_topics TEXT DEFAULT '[]',
                taboo_topics TEXT DEFAULT '[]',
                last_reflected_at TEXT,
                updated_at TEXT NOT NULL
            );

            -- 交互日志
            CREATE TABLE IF NOT EXISTS interactions (
                id TEXT PRIMARY KEY,
                chat_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                topic_id TEXT,
                type TEXT NOT NULL,
                summary TEXT NOT NULL,
                sentiment TEXT DEFAULT 'neutral',
                significance REAL DEFAULT 0.5,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_interactions_user_chat ON interactions(user_id, chat_id, created_at);

            -- 核心事实
            CREATE TABLE IF NOT EXISTS core_facts (
                id TEXT PRIMARY KEY,
                subject TEXT NOT NULL,
                content TEXT NOT NULL,
                category TEXT NOT NULL DEFAULT 'general',
                confidence REAL DEFAULT 1.0,
                source TEXT,
                embedding BLOB,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                expires_at TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_facts_subject ON core_facts(subject);
            CREATE INDEX IF NOT EXISTS idx_facts_category ON core_facts(category);

            -- 消息日志
            CREATE TABLE IF NOT EXISTS message_log (
                message_id INTEGER NOT NULL,
                chat_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                display_name TEXT NOT NULL DEFAULT '',
                text TEXT NOT NULL DEFAULT '',
                reply_to_message_id INTEGER,
                timestamp TEXT NOT NULL,
                PRIMARY KEY (chat_id, message_id)
            );
            CREATE INDEX IF NOT EXISTS idx_msglog_chat_time ON message_log(chat_id, timestamp);
            CREATE INDEX IF NOT EXISTS idx_msglog_user ON message_log(user_id, timestamp);
        `);

        // FTS5 虚拟表（独立模式，手动同步内容）
        try {
            this.db.exec(`
                CREATE VIRTUAL TABLE IF NOT EXISTS topics_fts USING fts5(
                    label, summary, keywords
                );
            `);
        } catch {
            // FTS5 表已存在时忽略
        }

        try {
            this.db.exec(`
                CREATE VIRTUAL TABLE IF NOT EXISTS core_facts_fts USING fts5(
                    content, subject
                );
            `);
        } catch {
            // FTS5 表已存在时忽略
        }
    }

    // ─── 写入方法 ───

    upsertTopic(pipelineTopicId: string, data: Partial<TopicNode>): string {
        const existing = this.db
            .prepare("SELECT id FROM topics WHERE pipeline_topic_id = ?")
            .get(pipelineTopicId) as { id: string } | undefined;

        const ts = now();

        if (existing) {
            // UPDATE — 只更新非 undefined 的字段
            const sets: string[] = [];
            const values: unknown[] = [];

            if (data.chatId !== undefined) { sets.push("chat_id = ?"); values.push(data.chatId); }
            if (data.label !== undefined) { sets.push("label = ?"); values.push(data.label); }
            if (data.summary !== undefined) { sets.push("summary = ?"); values.push(data.summary); }
            if (data.keyPoints !== undefined) { sets.push("key_points = ?"); values.push(toJSON(data.keyPoints)); }
            if (data.participants !== undefined) { sets.push("participants = ?"); values.push(toJSON(data.participants)); }
            if (data.keywords !== undefined) { sets.push("keywords = ?"); values.push(toJSON(data.keywords)); }
            if (data.messageRange !== undefined) {
                sets.push("first_message_id = ?", "last_message_id = ?", "message_count = ?");
                values.push(data.messageRange.firstMessageId, data.messageRange.lastMessageId, data.messageRange.count);
            }
            if (data.startedAt !== undefined) { sets.push("started_at = ?"); values.push(data.startedAt); }
            if (data.endedAt !== undefined) { sets.push("ended_at = ?"); values.push(data.endedAt); }
            if (data.sentiment !== undefined) { sets.push("sentiment = ?"); values.push(data.sentiment); }
            if (data.relatedTopicIds !== undefined) { sets.push("related_topic_ids = ?"); values.push(toJSON(data.relatedTopicIds)); }
            if (data.wasEngaged !== undefined) { sets.push("was_engaged = ?"); values.push(data.wasEngaged ? 1 : 0); }
            if (data.interventionCount !== undefined) { sets.push("intervention_count = ?"); values.push(data.interventionCount); }
            if (data.embedding !== undefined) { sets.push("embedding = ?"); values.push(Buffer.from(data.embedding.buffer)); }

            sets.push("updated_at = ?");
            values.push(ts);
            values.push(existing.id);

            if (sets.length > 1) {
                this.db.prepare(`UPDATE topics SET ${sets.join(", ")} WHERE id = ?`).run(...values);

                // 同步更新 FTS5
                this.syncTopicFTS(existing.id);
            }

            log.debug("upsertTopic: UPDATE", { id: existing.id, pipelineTopicId });
            return existing.id;
        } else {
            // INSERT
            const id = randomUUID();
            this.db.prepare(`
                INSERT INTO topics (
                    id, pipeline_topic_id, chat_id, label, summary, key_points, participants,
                    keywords, first_message_id, last_message_id, message_count,
                    started_at, ended_at, sentiment, related_topic_ids,
                    was_engaged, intervention_count, embedding,
                    created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                id,
                pipelineTopicId,
                data.chatId ?? "",
                data.label ?? "",
                data.summary ?? "",
                toJSON(data.keyPoints),
                toJSON(data.participants),
                toJSON(data.keywords),
                data.messageRange?.firstMessageId ?? null,
                data.messageRange?.lastMessageId ?? null,
                data.messageRange?.count ?? 0,
                data.startedAt ?? ts,
                data.endedAt ?? null,
                data.sentiment ?? "neutral",
                toJSON(data.relatedTopicIds),
                data.wasEngaged ? 1 : 0,
                data.interventionCount ?? 0,
                data.embedding ? Buffer.from(data.embedding.buffer) : null,
                ts,
                ts,
            );

            // 插入 FTS5
            this.syncTopicFTS(id);

            log.debug("upsertTopic: INSERT", { id, pipelineTopicId });
            return id;
        }
    }

    /** 同步 topics_fts 与 topics 表中某行的数据（独立 FTS5 模式） */
    private syncTopicFTS(topicId: string): void {
        try {
            const row = this.db.prepare(
                "SELECT rowid, label, summary, keywords FROM topics WHERE id = ?"
            ).get(topicId) as { rowid: number; label: string; summary: string; keywords: string } | undefined;
            if (!row) return;

            // 独立 FTS5：先删后插，使用 rowid 关联
            this.db.prepare("DELETE FROM topics_fts WHERE rowid = ?").run(row.rowid);
            this.db.prepare(
                "INSERT INTO topics_fts(rowid, label, summary, keywords) VALUES (?, ?, ?, ?)"
            ).run(row.rowid, row.label, row.summary, row.keywords);
        } catch (err) {
            log.warn("syncTopicFTS 失败", { topicId, error: String(err) });
        }
    }

    finalizeTopic(pipelineTopicId: string): void {
        const ts = now();
        this.db.prepare(
            "UPDATE topics SET ended_at = ?, updated_at = ? WHERE pipeline_topic_id = ? AND ended_at IS NULL"
        ).run(ts, ts, pipelineTopicId);
        log.debug("finalizeTopic", { pipelineTopicId });
    }

    storeMessageBatch(messages: MessageLogEntry[]): void {
        if (messages.length === 0) return;

        const insert = this.db.prepare(`
            INSERT OR IGNORE INTO message_log
                (message_id, chat_id, user_id, display_name, text, reply_to_message_id, timestamp)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `);

        const batch = this.db.transaction((msgs: MessageLogEntry[]) => {
            for (const m of msgs) {
                insert.run(
                    m.messageId, m.chatId, m.userId, m.displayName,
                    m.text, m.replyToMessageId ?? null, m.timestamp,
                );
            }
        });

        batch(messages);
        log.debug("storeMessageBatch", { count: messages.length });
    }

    storeFact(subject: string, content: string, category: FactCategory, source?: string): string {
        const id = randomUUID();
        const ts = now();
        this.db.prepare(`
            INSERT INTO core_facts (id, subject, content, category, confidence, source, created_at, updated_at)
            VALUES (?, ?, ?, ?, 1.0, ?, ?, ?)
        `).run(id, subject, content, category, source ?? null, ts, ts);

        // 同步 FTS5
        try {
            const row = this.db.prepare("SELECT rowid FROM core_facts WHERE id = ?").get(id) as { rowid: number } | undefined;
            if (row) {
                this.db.prepare(
                    "INSERT INTO core_facts_fts(rowid, content, subject) VALUES (?, ?, ?)"
                ).run(row.rowid, content, subject);
            }
        } catch (err) {
            log.warn("storeFact FTS sync 失败", { id, error: String(err) });
        }

        log.debug("storeFact", { id, subject, category });
        return id;
    }

    upsertPersonIdentity(userId: string, data: Partial<PersonIdentity>): void {
        const ts = now();
        const existing = this.db.prepare("SELECT user_id FROM person_identities WHERE user_id = ?").get(userId);

        if (existing) {
            const sets: string[] = [];
            const values: unknown[] = [];

            if (data.displayName !== undefined) { sets.push("display_name = ?"); values.push(data.displayName); }
            if (data.aliases !== undefined) { sets.push("aliases = ?"); values.push(toJSON(data.aliases)); }
            if (data.totalMessageCount !== undefined) { sets.push("total_message_count = ?"); values.push(data.totalMessageCount); }
            if (data.lastSeenAt !== undefined) { sets.push("last_seen_at = ?"); values.push(data.lastSeenAt); }

            sets.push("updated_at = ?");
            values.push(ts);
            values.push(userId);

            this.db.prepare(`UPDATE person_identities SET ${sets.join(", ")} WHERE user_id = ?`).run(...values);
        } else {
            this.db.prepare(`
                INSERT INTO person_identities (user_id, display_name, aliases, total_message_count, last_seen_at, first_seen_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(
                userId,
                data.displayName ?? "",
                toJSON(data.aliases),
                data.totalMessageCount ?? 0,
                data.lastSeenAt ?? ts,
                data.firstSeenAt ?? ts,
                ts,
            );
        }
    }

    upsertPersonGroupProfile(userId: string, chatId: string, data: Partial<PersonGroupProfile>): void {
        const ts = now();
        const existing = this.db.prepare(
            "SELECT user_id FROM person_group_profiles WHERE user_id = ? AND chat_id = ?"
        ).get(userId, chatId);

        if (existing) {
            const sets: string[] = [];
            const values: unknown[] = [];

            if (data.dunbarTier !== undefined) { sets.push("dunbar_tier = ?"); values.push(data.dunbarTier); }
            if (data.dunbarReason !== undefined) { sets.push("dunbar_reason = ?"); values.push(data.dunbarReason); }
            if (data.traits !== undefined) { sets.push("traits = ?"); values.push(toJSON(data.traits)); }
            if (data.interests !== undefined) { sets.push("interests = ?"); values.push(toJSON(data.interests)); }
            if (data.communicationStyle !== undefined) { sets.push("communication_style = ?"); values.push(data.communicationStyle); }
            if (data.relationToAgent !== undefined) { sets.push("relation_to_agent = ?"); values.push(data.relationToAgent); }
            if (data.recentEpisodes !== undefined) { sets.push("recent_episodes = ?"); values.push(toJSON(data.recentEpisodes)); }
            if (data.mergedMemory !== undefined) { sets.push("merged_memory = ?"); values.push(toJSON(data.mergedMemory)); }
            if (data.messageCount !== undefined) { sets.push("message_count = ?"); values.push(data.messageCount); }
            if (data.lastSeenAt !== undefined) { sets.push("last_seen_at = ?"); values.push(data.lastSeenAt); }
            if (data.activeHours !== undefined) { sets.push("active_hours = ?"); values.push(toJSON(data.activeHours)); }

            sets.push("updated_at = ?");
            values.push(ts);
            values.push(userId);
            values.push(chatId);

            this.db.prepare(
                `UPDATE person_group_profiles SET ${sets.join(", ")} WHERE user_id = ? AND chat_id = ?`
            ).run(...values);
        } else {
            this.db.prepare(`
                INSERT INTO person_group_profiles (
                    user_id, chat_id, dunbar_tier, dunbar_reason, traits, interests,
                    communication_style, relation_to_agent, recent_episodes, merged_memory,
                    message_count, last_seen_at, active_hours, first_seen_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                userId, chatId,
                data.dunbarTier ?? 4,
                data.dunbarReason ?? "",
                toJSON(data.traits),
                toJSON(data.interests),
                data.communicationStyle ?? "",
                data.relationToAgent ?? "",
                toJSON(data.recentEpisodes),
                toJSON(data.mergedMemory),
                data.messageCount ?? 0,
                data.lastSeenAt ?? ts,
                toJSON(data.activeHours),
                data.firstSeenAt ?? ts,
                ts,
            );
        }
    }

    upsertGroupModel(chatId: string, data: Partial<GroupModel>): void {
        const ts = now();
        const existing = this.db.prepare("SELECT chat_id FROM group_models WHERE chat_id = ?").get(chatId);

        if (existing) {
            const sets: string[] = [];
            const values: unknown[] = [];

            if (data.chatTitle !== undefined) { sets.push("chat_title = ?"); values.push(data.chatTitle); }
            if (data.description !== undefined) { sets.push("description = ?"); values.push(data.description); }
            if (data.dominantLanguage !== undefined) { sets.push("dominant_language = ?"); values.push(data.dominantLanguage); }
            if (data.communicationNorms !== undefined) { sets.push("communication_norms = ?"); values.push(toJSON(data.communicationNorms)); }
            if (data.activeMembers !== undefined) { sets.push("active_members = ?"); values.push(data.activeMembers); }
            if (data.avgMessagesPerDay !== undefined) { sets.push("avg_messages_per_day = ?"); values.push(data.avgMessagesPerDay); }
            if (data.peakHours !== undefined) { sets.push("peak_hours = ?"); values.push(toJSON(data.peakHours)); }
            if (data.agentRole !== undefined) { sets.push("agent_role = ?"); values.push(data.agentRole); }
            if (data.engagementLevel !== undefined) { sets.push("engagement_level = ?"); values.push(data.engagementLevel); }
            if (data.recentFeedback !== undefined) { sets.push("recent_feedback = ?"); values.push(data.recentFeedback); }
            if (data.hotTopics !== undefined) { sets.push("hot_topics = ?"); values.push(toJSON(data.hotTopics)); }
            if (data.tabooTopics !== undefined) { sets.push("taboo_topics = ?"); values.push(toJSON(data.tabooTopics)); }
            if (data.lastReflectedAt !== undefined) { sets.push("last_reflected_at = ?"); values.push(data.lastReflectedAt); }

            sets.push("updated_at = ?");
            values.push(ts);
            values.push(chatId);

            this.db.prepare(`UPDATE group_models SET ${sets.join(", ")} WHERE chat_id = ?`).run(...values);
        } else {
            this.db.prepare(`
                INSERT INTO group_models (
                    chat_id, chat_title, description, dominant_language, communication_norms,
                    active_members, avg_messages_per_day, peak_hours, agent_role,
                    engagement_level, recent_feedback, hot_topics, taboo_topics,
                    last_reflected_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                chatId,
                data.chatTitle ?? "",
                data.description ?? "",
                data.dominantLanguage ?? "zh",
                toJSON(data.communicationNorms),
                data.activeMembers ?? 0,
                data.avgMessagesPerDay ?? 0,
                toJSON(data.peakHours),
                data.agentRole ?? "",
                data.engagementLevel ?? "medium",
                data.recentFeedback ?? "",
                toJSON(data.hotTopics),
                toJSON(data.tabooTopics),
                data.lastReflectedAt ?? null,
                ts,
            );
        }
    }

    getGroupModel(chatId: string): GroupModel | null {
        const row = this.db.prepare("SELECT * FROM group_models WHERE chat_id = ?").get(chatId) as Record<string, unknown> | undefined;
        if (!row) return null;

        return {
            chatId: row.chat_id as string,
            chatTitle: row.chat_title as string,
            description: row.description as string,
            dominantLanguage: row.dominant_language as string,
            communicationNorms: fromJSON(row.communication_norms as string, []),
            activeMembers: row.active_members as number,
            avgMessagesPerDay: row.avg_messages_per_day as number,
            peakHours: fromJSON(row.peak_hours as string, []),
            agentRole: row.agent_role as string,
            engagementLevel: (row.engagement_level as string) as GroupModel["engagementLevel"],
            recentFeedback: row.recent_feedback as string,
            hotTopics: fromJSON(row.hot_topics as string, []),
            tabooTopics: fromJSON(row.taboo_topics as string, []),
            lastReflectedAt: (row.last_reflected_at as string) ?? null,
            updatedAt: row.updated_at as string,
        };
    }

    storeInteraction(episode: Omit<InteractionEpisode, "id">): string {
        const id = randomUUID();
        const ts = now();
        this.db.prepare(`
            INSERT INTO interactions (id, chat_id, user_id, topic_id, type, summary, sentiment, significance, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            id,
            (episode as unknown as { chatId: string }).chatId ?? "",
            (episode as unknown as { userId: string }).userId ?? "",
            episode.topicId ?? null,
            episode.type,
            episode.summary,
            episode.sentiment ?? "neutral",
            episode.significance ?? 0.5,
            episode.date ?? ts,
        );
        log.debug("storeInteraction", { id, type: episode.type });
        return id;
    }

    // ─── 检索方法 ───

    async recall(query: string, options?: RecallOptions): Promise<RecallResult> {
        const topics: TopicNode[] = [];
        const facts: Array<{ content: string; category: FactCategory; subject: string; confidence: number }> = [];

        const maxResults = options?.maxResults ?? 10;
        const chatIdFilter = options?.chatId;
        const daysBack = options?.daysBack;

        // FTS5 搜索 topics
        try {
            let topicQuery = `
                SELECT t.* FROM topics t
                INNER JOIN topics_fts fts ON t.rowid = fts.rowid
                WHERE topics_fts MATCH ?
            `;
            const params: unknown[] = [query];

            if (chatIdFilter) {
                topicQuery += " AND t.chat_id = ?";
                params.push(chatIdFilter);
            }
            if (daysBack) {
                const cutoff = new Date(Date.now() - daysBack * 86400000).toISOString();
                topicQuery += " AND t.started_at >= ?";
                params.push(cutoff);
            }

            topicQuery += ` LIMIT ?`;
            params.push(maxResults);

            const rows = this.db.prepare(topicQuery).all(...params) as Record<string, unknown>[];
            for (const row of rows) {
                topics.push(this.rowToTopicNode(row));
            }
        } catch (err) {
            log.debug("recall: FTS5 topics 失败", { error: String(err) });
        }

        // FTS5 结果为空时，回退到 LIKE 搜索（支持 CJK 文本）
        if (topics.length === 0) {
            try {
                let likeQuery = "SELECT * FROM topics WHERE (label LIKE ? OR summary LIKE ? OR keywords LIKE ?)";
                const likePattern = `%${query}%`;
                const params: unknown[] = [likePattern, likePattern, likePattern];

                if (chatIdFilter) { likeQuery += " AND chat_id = ?"; params.push(chatIdFilter); }
                if (daysBack) {
                    const cutoff = new Date(Date.now() - daysBack * 86400000).toISOString();
                    likeQuery += " AND started_at >= ?";
                    params.push(cutoff);
                }
                likeQuery += " LIMIT ?";
                params.push(maxResults);

                const rows = this.db.prepare(likeQuery).all(...params) as Record<string, unknown>[];
                for (const row of rows) {
                    topics.push(this.rowToTopicNode(row));
                }
            } catch { /* LIKE 也失败，返回空 */ }
        }

        // FTS5 搜索 core_facts
        try {
            let factQuery = `
                SELECT cf.* FROM core_facts cf
                INNER JOIN core_facts_fts fts ON cf.rowid = fts.rowid
                WHERE core_facts_fts MATCH ?
            `;
            const params: unknown[] = [query];

            if (options?.categories?.length) {
                const placeholders = options.categories.map(() => "?").join(", ");
                factQuery += ` AND cf.category IN (${placeholders})`;
                params.push(...options.categories);
            }

            factQuery += ` LIMIT ?`;
            params.push(maxResults);

            const rows = this.db.prepare(factQuery).all(...params) as Record<string, unknown>[];
            for (const row of rows) {
                facts.push({
                    content: row.content as string,
                    category: row.category as FactCategory,
                    subject: row.subject as string,
                    confidence: row.confidence as number,
                });
            }
        } catch (err) {
            log.debug("recall: FTS5 facts 失败", { error: String(err) });
        }

        // FTS5 结果为空时，回退到 LIKE
        if (facts.length === 0) {
            try {
                const likePattern = `%${query}%`;
                let likeQuery = "SELECT * FROM core_facts WHERE (content LIKE ? OR subject LIKE ?)";
                const params: unknown[] = [likePattern, likePattern];

                if (options?.categories?.length) {
                    const placeholders = options.categories.map(() => "?").join(", ");
                    likeQuery += ` AND category IN (${placeholders})`;
                    params.push(...options.categories);
                }
                likeQuery += " LIMIT ?";
                params.push(maxResults);

                const rows = this.db.prepare(likeQuery).all(...params) as Record<string, unknown>[];
                for (const row of rows) {
                    facts.push({
                        content: row.content as string,
                        category: row.category as FactCategory,
                        subject: row.subject as string,
                        confidence: row.confidence as number,
                    });
                }
            } catch { /* 空 */ }
        }

        log.debug("recall", { query, topicsFound: topics.length, factsFound: facts.length });
        return { topics, facts, persons: [] };
    }

    async browseHistory(request: HistoryBrowseRequest): Promise<HistoryBrowseResult> {
        const segments: HistoryBrowseResult["segments"] = [];
        const contextWindow = request.contextWindow ?? 10;
        const maxSegments = request.maxSegments ?? 3;

        // 按关键词匹配 topics
        const keywords = request.intent.split(/\s+/).filter(w => w.length > 0);
        if (keywords.length === 0) {
            return { answer: "", segments: [], messagesRead: 0 };
        }

        // 构建 LIKE 查询（多个关键词 OR）
        const conditions = keywords.map(() => "(label LIKE ? OR keywords LIKE ? OR summary LIKE ?)").join(" OR ");
        const params: unknown[] = [];
        for (const kw of keywords) {
            const p = `%${kw}%`;
            params.push(p, p, p);
        }

        // 应用 hints 过滤
        let whereClause = `WHERE (${conditions})`;
        if (request.hints?.chatId) {
            whereClause += " AND chat_id = ?";
            params.push(request.hints.chatId);
        }
        if (request.hints?.daysBack) {
            const cutoff = new Date(Date.now() - request.hints.daysBack * 86400000).toISOString();
            whereClause += " AND started_at >= ?";
            params.push(cutoff);
        }
        if (request.hints?.topicId) {
            whereClause += " AND id = ?";
            params.push(request.hints.topicId);
        }

        params.push(maxSegments);

        const topicRows = this.db.prepare(
            `SELECT * FROM topics ${whereClause} ORDER BY started_at DESC LIMIT ?`
        ).all(...params) as Record<string, unknown>[];

        let totalMessagesRead = 0;

        for (const topicRow of topicRows) {
            const firstMsgId = topicRow.first_message_id as number | null;
            const lastMsgId = topicRow.last_message_id as number | null;
            const chatId = topicRow.chat_id as string;

            if (firstMsgId == null || lastMsgId == null) continue;

            // 拉取 messageRange 内的消息（加上 contextWindow）
            const msgRows = this.db.prepare(`
                SELECT * FROM message_log
                WHERE chat_id = ? AND message_id >= ? AND message_id <= ?
                ORDER BY message_id ASC
            `).all(
                chatId,
                Math.max(0, firstMsgId - contextWindow),
                lastMsgId + contextWindow,
            ) as Record<string, unknown>[];

            const messages = msgRows.map(r => ({
                messageId: r.message_id as number,
                userId: r.user_id as string,
                displayName: r.display_name as string,
                text: r.text as string,
                timestamp: r.timestamp as string,
            }));

            totalMessagesRead += messages.length;

            segments.push({
                topicLabel: topicRow.label as string,
                timeRange: {
                    from: topicRow.started_at as string,
                    to: (topicRow.ended_at as string) ?? now(),
                },
                messages,
                relevanceScore: 1.0,
            });
        }

        // M1 基础版：不调 LLM，直接拼接 answer
        const answer = segments.length > 0
            ? `找到 ${segments.length} 个相关话题：${segments.map(s => s.topicLabel).join("、")}`
            : "";

        log.debug("browseHistory", { intent: request.intent, segmentsFound: segments.length, totalMessagesRead });
        return { answer, segments, messagesRead: totalMessagesRead };
    }

    async reflect(chatId: string): Promise<ReflectionResult> {
        // M1: stub, M2 实现真实 Reflection
        log.debug("[stub] reflect", { chatId });
        return {
            reflectedPeriod: { from: now(), to: now() },
            topicsSummary: [],
            personUpdates: [],
            groupUpdates: "",
            newCoreFacts: [],
            mergedEpisodes: 0,
            insights: "[Memory V2 M1] Reflection 功能将在 Phase M2 实现。",
        };
    }

    // ─── 生命周期 ───

    close(): void {
        this.db.close();
        log.info("Memory V2 SQLite 已关闭");
    }

    // ─── 内部工具方法 ───

    /** 将 SQLite 行映射为 TopicNode */
    private rowToTopicNode(row: Record<string, unknown>): TopicNode {
        return {
            id: row.id as string,
            pipelineTopicId: (row.pipeline_topic_id as string) ?? undefined,
            chatId: row.chat_id as string,
            label: row.label as string,
            summary: row.summary as string,
            keyPoints: fromJSON(row.key_points as string, []),
            participants: fromJSON(row.participants as string, []),
            messageRange: {
                firstMessageId: (row.first_message_id as number) ?? 0,
                lastMessageId: (row.last_message_id as number) ?? 0,
                count: (row.message_count as number) ?? 0,
            },
            startedAt: row.started_at as string,
            endedAt: (row.ended_at as string) ?? null,
            sentiment: (row.sentiment as TopicNode["sentiment"]) ?? "neutral",
            relatedTopicIds: fromJSON(row.related_topic_ids as string, []),
            keywords: fromJSON(row.keywords as string, []),
            wasEngaged: !!(row.was_engaged as number),
            interventionCount: (row.intervention_count as number) ?? 0,
            embedding: row.embedding ? new Float32Array((row.embedding as Buffer).buffer) : undefined,
            createdAt: row.created_at as string,
            updatedAt: row.updated_at as string,
        };
    }
}
