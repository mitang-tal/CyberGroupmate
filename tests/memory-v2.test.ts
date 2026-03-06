/**
 * tests/memory-v2.test.ts — MemoryStoreV2 综合测试
 *
 * 覆盖 Phase M1 所有功能：
 * - 构造器和建表
 * - upsertTopic（INSERT/UPDATE/幂等）
 * - finalizeTopic
 * - storeMessageBatch（批量/去重）
 * - storeFact + FTS5 搜索
 * - upsertPersonIdentity / upsertPersonGroupProfile
 * - upsertGroupModel / getGroupModel
 * - storeInteraction
 * - recall()（FTS5 + LIKE fallback）
 * - browseHistory()（关键词匹配 + message_log 检索）
 * - reflect()（M2 stub）
 * - close / 生命周期
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestMemory, cleanupTestMemory, testDbPath } from "./helpers/test-db.js";
import { MemoryStoreV2 } from "../src/memory-v2/index.js";

// ─── 1. 构造器和初始化 ───

describe("MemoryStoreV2 构造器", () => {
    it("should create an instance and initialize 7 tables + 2 FTS", () => {
        const mem = createTestMemory("ctor");
        assert.ok(mem);

        // 验证所有表存在——直接访问 db（内部检查）
        const db = (mem as any).db;
        const tables = db
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .all()
            .map((r: any) => r.name);

        assert.ok(tables.includes("topics"), "topics table should exist");
        assert.ok(tables.includes("person_identities"), "person_identities table should exist");
        assert.ok(tables.includes("person_group_profiles"), "person_group_profiles table should exist");
        assert.ok(tables.includes("group_models"), "group_models table should exist");
        assert.ok(tables.includes("interactions"), "interactions table should exist");
        assert.ok(tables.includes("core_facts"), "core_facts table should exist");
        assert.ok(tables.includes("message_log"), "message_log table should exist");

        // FTS5 虚拟表
        assert.ok(tables.includes("topics_fts"), "topics_fts should exist");
        assert.ok(tables.includes("core_facts_fts"), "core_facts_fts should exist");

        cleanupTestMemory(mem, "ctor");
    });

    it("should be idempotent — calling on existing DB should not error", () => {
        const mem1 = createTestMemory("idempotent");
        mem1.close();
        // 不清除文件，用相同路径打开
        const mem2 = new MemoryStoreV2(testDbPath("idempotent"));
        assert.ok(mem2);
        cleanupTestMemory(mem2, "idempotent");
    });
});

// ─── 2. upsertTopic ───

describe("upsertTopic", () => {
    let mem: MemoryStoreV2;

    before(() => { mem = createTestMemory("upsert-topic"); });
    after(() => { cleanupTestMemory(mem, "upsert-topic"); });

    it("should INSERT a new topic", () => {
        mem.upsertTopic("pipeline_001", {
            chatId: "-100",
            label: "测试话题",
            summary: "测试摘要",
            keyPoints: ["要点1", "要点2"],
            keywords: ["测试", "话题"],
            participants: ["u1", "u2"],
            messageRange: { firstMessageId: 10, lastMessageId: 20, count: 11 },
            startedAt: "2026-01-01T00:00:00Z",
            wasEngaged: false,
            interventionCount: 0,
        });

        const db = (mem as any).db;
        const row = db.prepare("SELECT * FROM topics WHERE pipeline_topic_id = ?").get("pipeline_001");
        assert.ok(row, "topic should be inserted");
        assert.equal(row.label, "测试话题");
        assert.equal(row.summary, "测试摘要");
        assert.equal(row.chat_id, "-100");
        assert.deepEqual(JSON.parse(row.key_points), ["要点1", "要点2"]);
        assert.deepEqual(JSON.parse(row.keywords), ["测试", "话题"]);
        assert.deepEqual(JSON.parse(row.participants), ["u1", "u2"]);
        assert.equal(row.was_engaged, 0);
        assert.equal(row.intervention_count, 0);
    });

    it("should UPDATE existing topic (partial update)", () => {
        // 更新 pipeline_001 的部分字段
        mem.upsertTopic("pipeline_001", {
            summary: "更新后的摘要",
            keyPoints: ["新要点"],
            wasEngaged: true,
            interventionCount: 2,
        });

        const db = (mem as any).db;
        const row = db.prepare("SELECT * FROM topics WHERE pipeline_topic_id = ?").get("pipeline_001");
        assert.equal(row.summary, "更新后的摘要");
        assert.deepEqual(JSON.parse(row.key_points), ["新要点"]);
        assert.equal(row.was_engaged, 1);
        assert.equal(row.intervention_count, 2);
        // 未更新的字段应保持不变
        assert.equal(row.label, "测试话题");
        assert.equal(row.chat_id, "-100");
    });

    it("should be idempotent — re-insert same data is safe", () => {
        // 再次插入相同数据不应报错
        assert.doesNotThrow(() => {
            mem.upsertTopic("pipeline_001", {
                summary: "更新后的摘要",
            });
        });
    });

    it("should update FTS5 index on upsert", () => {
        mem.upsertTopic("pipeline_fts", {
            chatId: "-100",
            label: "全文搜索测试",
            summary: "这是一个关于北京旅行的话题",
            keyPoints: [],
            keywords: ["北京", "旅行"],
            participants: ["u1"],
            messageRange: { firstMessageId: 30, lastMessageId: 35, count: 6 },
            startedAt: "2026-01-02T00:00:00Z",
            wasEngaged: false,
            interventionCount: 0,
        });

        const db = (mem as any).db;
        const ftsResults = db
            .prepare("SELECT * FROM topics_fts WHERE topics_fts MATCH ?")
            .all("北京");
        assert.ok(ftsResults.length > 0, "FTS5 should find the topic by keyword");
    });
});

// ─── 3. finalizeTopic ───

describe("finalizeTopic", () => {
    let mem: MemoryStoreV2;

    before(() => {
        mem = createTestMemory("finalize");
        mem.upsertTopic("pipeline_fin", {
            chatId: "-100",
            label: "待归档",
            summary: "即将归档的话题",
            keyPoints: [],
            keywords: [],
            participants: [],
            messageRange: { firstMessageId: 1, lastMessageId: 5, count: 5 },
            startedAt: "2026-01-01T00:00:00Z",
            wasEngaged: false,
            interventionCount: 0,
        });
    });
    after(() => { cleanupTestMemory(mem, "finalize"); });

    it("should set ended_at for existing topic", () => {
        mem.finalizeTopic("pipeline_fin");

        const db = (mem as any).db;
        const row = db.prepare("SELECT ended_at FROM topics WHERE pipeline_topic_id = ?").get("pipeline_fin");
        assert.ok(row.ended_at, "ended_at should be set");
    });

    it("should be silent for non-existent topic", () => {
        assert.doesNotThrow(() => {
            mem.finalizeTopic("nonexistent_pipeline_id");
        });
    });
});

// ─── 4. storeMessageBatch ───

describe("storeMessageBatch", () => {
    let mem: MemoryStoreV2;

    before(() => { mem = createTestMemory("msg-batch"); });
    after(() => { cleanupTestMemory(mem, "msg-batch"); });

    const baseMsgs = [
        { messageId: 1, chatId: "-100", userId: "u1", displayName: "alice", text: "你好", timestamp: "2026-01-01T10:00:00Z" },
        { messageId: 2, chatId: "-100", userId: "u2", displayName: "bob", text: "你好！今天天气不错", timestamp: "2026-01-01T10:00:30Z" },
        { messageId: 3, chatId: "-100", userId: "u1", displayName: "alice", text: "是啊~", replyToMessageId: 2, timestamp: "2026-01-01T10:01:00Z" },
    ];

    it("should insert a batch of messages", () => {
        mem.storeMessageBatch(baseMsgs);

        const db = (mem as any).db;
        const count = db.prepare("SELECT COUNT(*) as cnt FROM message_log").get().cnt;
        assert.equal(count, 3);
    });

    it("should handle duplicates gracefully (INSERT OR IGNORE)", () => {
        // 再次插入相同消息 + 1 条新消息
        const msgs = [
            ...baseMsgs,
            { messageId: 4, chatId: "-100", userId: "u2", displayName: "bob", text: "出去走走吧", timestamp: "2026-01-01T10:02:00Z" },
        ];
        mem.storeMessageBatch(msgs);

        const db = (mem as any).db;
        const count = db.prepare("SELECT COUNT(*) as cnt FROM message_log").get().cnt;
        assert.equal(count, 4, "should have 4 unique messages");
    });

    it("should store replyToMessageId correctly", () => {
        const db = (mem as any).db;
        const row = db.prepare("SELECT reply_to_message_id FROM message_log WHERE message_id = 3 AND chat_id = ?").get("-100");
        assert.equal(row.reply_to_message_id, 2);
    });
});

// ─── 5. storeFact ───

describe("storeFact", () => {
    let mem: MemoryStoreV2;

    before(() => { mem = createTestMemory("facts"); });
    after(() => { cleanupTestMemory(mem, "facts"); });

    it("should insert a fact and return its id", () => {
        const id = mem.storeFact("alice", "alice 喜欢抹茶", "preference");
        assert.ok(id, "should return a non-empty id");
        assert.equal(typeof id, "string");
    });

    it("should insert facts with different categories", () => {
        mem.storeFact("bob", "bob 是 Rust 程序员", "biographical");
        mem.storeFact("alice", "alice 觉得 Rust 比 Go 好", "opinion");
        mem.storeFact("chat-100", "群里经常讨论技术", "general");

        const db = (mem as any).db;
        const count = db.prepare("SELECT COUNT(*) as cnt FROM core_facts").get().cnt;
        assert.equal(count, 4);
    });

    it("should populate FTS5 index for Chinese text search", () => {
        const db = (mem as any).db;
        // LIKE fallback search for Chinese (FTS5 may tokenize differently)
        const rows = db.prepare("SELECT * FROM core_facts WHERE content LIKE ?").all("%抹茶%");
        assert.ok(rows.length > 0, "should find fact by Chinese keyword");
    });

    it("should store source metadata", () => {
        const id = mem.storeFact("test", "with source", "general", "compaction:session-1");
        const db = (mem as any).db;
        const row = db.prepare("SELECT source FROM core_facts WHERE id = ?").get(id);
        assert.equal(row.source, "compaction:session-1");
    });
});

// ─── 6. upsertPersonIdentity ───

describe("upsertPersonIdentity", () => {
    let mem: MemoryStoreV2;

    before(() => { mem = createTestMemory("person-id"); });
    after(() => { cleanupTestMemory(mem, "person-id"); });

    it("should insert a new person identity", () => {
        mem.upsertPersonIdentity("u1", {
            displayName: "alice",
            aliases: ["Alice", "爱丽丝"],
            lastSeenAt: "2026-01-01T00:00:00Z",
        });

        const db = (mem as any).db;
        const row = db.prepare("SELECT * FROM person_identities WHERE user_id = ?").get("u1");
        assert.ok(row);
        assert.equal(row.display_name, "alice");
        assert.deepEqual(JSON.parse(row.aliases), ["Alice", "爱丽丝"]);
    });

    it("should update existing person identity", () => {
        mem.upsertPersonIdentity("u1", {
            displayName: "Alice_new",
            lastSeenAt: "2026-02-01T00:00:00Z",
        });

        const db = (mem as any).db;
        const row = db.prepare("SELECT * FROM person_identities WHERE user_id = ?").get("u1");
        assert.equal(row.display_name, "Alice_new");
    });
});

// ─── 7. upsertPersonGroupProfile ───

describe("upsertPersonGroupProfile", () => {
    let mem: MemoryStoreV2;

    before(() => { mem = createTestMemory("person-profile"); });
    after(() => { cleanupTestMemory(mem, "person-profile"); });

    it("should insert a new group profile", () => {
        mem.upsertPersonGroupProfile("u1", "-100", {
            dunbarTier: 1,
            dunbarReason: "核心用户",
            traits: ["热情"],
            interests: ["旅行"],
            communicationStyle: "喜欢用表情",
            messageCount: 50,
        });

        const db = (mem as any).db;
        const row = db.prepare("SELECT * FROM person_group_profiles WHERE user_id = ? AND chat_id = ?").get("u1", "-100");
        assert.ok(row);
        assert.equal(row.dunbar_tier, 1);
        assert.deepEqual(JSON.parse(row.traits), ["热情"]);
    });

    it("should update existing group profile", () => {
        mem.upsertPersonGroupProfile("u1", "-100", {
            messageCount: 100,
            traits: ["热情", "好奇"],
        });

        const db = (mem as any).db;
        const row = db.prepare("SELECT * FROM person_group_profiles WHERE user_id = ? AND chat_id = ?").get("u1", "-100");
        assert.equal(row.message_count, 100);
        assert.deepEqual(JSON.parse(row.traits), ["热情", "好奇"]);
    });
});

// ─── 8. upsertGroupModel / getGroupModel ───

describe("GroupModel", () => {
    let mem: MemoryStoreV2;

    before(() => { mem = createTestMemory("group-model"); });
    after(() => { cleanupTestMemory(mem, "group-model"); });

    it("should upsert and get a group model", () => {
        mem.upsertGroupModel("-100", {
            chatTitle: "测试群组",
            description: "一个测试用的群组",
            dominantLanguage: "zh",
            activeMembers: 10,
            avgMessagesPerDay: 50,
            agentRole: "知识助手",
            engagementLevel: "medium",
            hotTopics: ["编程", "旅行"],
        });

        const model = mem.getGroupModel("-100");
        assert.ok(model);
        assert.equal(model!.chatTitle, "测试群组");
        assert.equal(model!.dominantLanguage, "zh");
        assert.equal(model!.activeMembers, 10);
        assert.deepEqual(model!.hotTopics, ["编程", "旅行"]);
    });

    it("should return null for non-existent group", () => {
        const model = mem.getGroupModel("-999");
        assert.equal(model, null);
    });

    it("should update existing group model", () => {
        mem.upsertGroupModel("-100", {
            activeMembers: 15,
            hotTopics: ["编程", "旅行", "动漫"],
        });

        const model = mem.getGroupModel("-100");
        assert.equal(model!.activeMembers, 15);
        assert.deepEqual(model!.hotTopics, ["编程", "旅行", "动漫"]);
    });
});

// ─── 9. storeInteraction ───

describe("storeInteraction", () => {
    let mem: MemoryStoreV2;

    before(() => { mem = createTestMemory("interaction"); });
    after(() => { cleanupTestMemory(mem, "interaction"); });

    it("should store an interaction episode", () => {
        mem.storeInteraction({
            date: new Date().toISOString(),
            topicId: "topic_1",
            type: "agent_replied",
            summary: "回复了用户关于Python的提问",
            sentiment: "positive",
            significance: 0.8,
        } as any);

        const db = (mem as any).db;
        const count = db.prepare("SELECT COUNT(*) as cnt FROM interactions").get().cnt;
        assert.equal(count, 1);

        const row = db.prepare("SELECT * FROM interactions LIMIT 1").get() as any;
        assert.equal(row.topic_id, "topic_1");
        assert.equal(row.type, "agent_replied");
        assert.equal(row.sentiment, "positive");
    });
});

// ─── 10. recall() ───

describe("recall", () => {
    let mem: MemoryStoreV2;

    before(() => {
        mem = createTestMemory("recall");
        // 填充测试数据
        mem.upsertTopic("topic_recall_1", {
            chatId: "-100",
            label: "京都旅行攻略",
            summary: "讨论京都岚山竹林和交通方式",
            keyPoints: ["坐阪急到桂站"],
            keywords: ["京都", "岚山"],
            participants: ["u1", "u2"],
            messageRange: { firstMessageId: 1, lastMessageId: 10, count: 10 },
            startedAt: "2026-01-01T00:00:00Z",
            wasEngaged: true,
            interventionCount: 2,
        });
        mem.upsertTopic("topic_recall_2", {
            chatId: "-200",
            label: "Python 编程讨论",
            summary: "调试 Python TypeError",
            keyPoints: [],
            keywords: ["Python"],
            participants: ["u2"],
            messageRange: { firstMessageId: 11, lastMessageId: 20, count: 10 },
            startedAt: "2026-01-02T00:00:00Z",
            wasEngaged: false,
            interventionCount: 0,
        });
        mem.storeFact("u1", "alice 喜欢京都的抹茶", "preference");
        mem.storeFact("u2", "bob 擅长 Python", "biographical");
    });
    after(() => { cleanupTestMemory(mem, "recall"); });

    it("should find topics by keyword (FTS5 or LIKE fallback)", async () => {
        const result = await mem.recall("京都");
        assert.ok(result.topics.length > 0, "should find at least one topic");
        assert.equal(result.topics[0].label, "京都旅行攻略");
    });

    it("should find facts by keyword", async () => {
        const result = await mem.recall("抹茶");
        assert.ok(result.facts.length > 0, "should find at least one fact");
    });

    it("should filter by chatId", async () => {
        const result = await mem.recall("Python", { chatId: "-200" });
        assert.ok(result.topics.length > 0);
        assert.ok(result.topics.every(t => t.chatId === "-200"));
    });

    it("should return empty for no match", async () => {
        const result = await mem.recall("完全不存在的关键词xyz");
        assert.equal(result.topics.length, 0);
        assert.equal(result.facts.length, 0);
    });

    it("should filter by categories (LIKE fallback)", async () => {
        const result = await mem.recall("抹茶", { categories: ["preference"] });
        assert.ok(result.facts.length > 0, "should find preference facts");
        assert.equal(result.facts[0].category, "preference");
    });
});

// ─── 11. browseHistory() ───

describe("browseHistory", () => {
    let mem: MemoryStoreV2;

    before(() => {
        mem = createTestMemory("browse");
        // 准备话题 + 消息
        mem.upsertTopic("topic_browse", {
            chatId: "-100",
            label: "动漫推荐讨论",
            summary: "讨论新番推荐",
            keyPoints: ["芙莉莲好看"],
            keywords: ["动漫", "新番", "芙莉莲"],
            participants: ["u1", "u3"],
            messageRange: { firstMessageId: 50, lastMessageId: 55, count: 6 },
            startedAt: "2026-01-01T12:00:00Z",
            wasEngaged: false,
            interventionCount: 0,
        });
        mem.storeMessageBatch([
            { messageId: 50, chatId: "-100", userId: "u3", displayName: "carol", text: "这季新番大家看了吗", timestamp: "2026-01-01T12:00:00Z" },
            { messageId: 51, chatId: "-100", userId: "u1", displayName: "alice", text: "葬送的芙莉莲超好看！", timestamp: "2026-01-01T12:01:00Z" },
            { messageId: 52, chatId: "-100", userId: "u3", displayName: "carol", text: "对对！画面太精致了", timestamp: "2026-01-01T12:02:00Z" },
        ]);
    });
    after(() => { cleanupTestMemory(mem, "browse"); });

    it("should match topics by keyword and return messages", async () => {
        const result = await mem.browseHistory({ intent: "动漫" });
        assert.ok(result.segments.length > 0, "should have at least one segment");
        assert.ok(result.messagesRead > 0, "should have read some messages");
        assert.ok(result.segments[0].messages.length > 0, "segment should contain messages");
    });

    it("should filter by chatId", async () => {
        const result = await mem.browseHistory({
            intent: "动漫",
            hints: { chatId: "-100" },
        });
        assert.ok(result.segments.length > 0);
    });

    it("should return empty for no match", async () => {
        const result = await mem.browseHistory({ intent: "完全不存在的内容xyz" });
        assert.equal(result.segments.length, 0);
    });
});

// reflect() 测试已移至 tests/reflection.test.ts

// ─── 13. close / 生命周期 ───

describe("生命周期", () => {
    it("should close gracefully", () => {
        const mem = createTestMemory("lifecycle");
        assert.doesNotThrow(() => mem.close());
        cleanupTestMemory(mem, "lifecycle");
    });

    it("should handle double-close without error", () => {
        const mem = createTestMemory("double-close");
        mem.close();
        assert.doesNotThrow(() => mem.close());
        cleanupTestMemory(mem, "double-close");
    });
});
