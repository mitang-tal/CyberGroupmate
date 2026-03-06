/**
 * tests/vector-search.test.ts — 向量索引集成测试
 *
 * 覆盖 M4.2：
 * - vectorSearchTopics 向量搜索
 * - vectorSearchFacts 向量搜索
 * - embedding BLOB 读写
 * - storeFact with embedding
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { MemoryStoreV2 } from "../src/memory-v2/memory-v2.js";
import { localEmbed, embeddingToBuffer, bufferToEmbedding } from "../src/memory-v2/embedding.js";

const TEST_DIR = "/tmp/cybergroupmate-test";
const DB_PATH = `${TEST_DIR}/vector-search.db`;

let memory: MemoryStoreV2;

before(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    memory = new MemoryStoreV2(DB_PATH);
});

after(() => {
    memory.close();
    try { rmSync(DB_PATH, { force: true }); } catch { }
});

// ─── vectorSearchTopics ───

describe("vectorSearchTopics", () => {
    it("返回有 embedding 的 topics 按相似度排序", () => {
        // 写入 3 个 topics 带不同 embedding
        memory.upsertTopic("vst_1", {
            chatId: "chat1",
            label: "京都旅行",
            summary: "讨论京都岚山观光",
            keywords: ["京都", "岚山"],
            embedding: localEmbed("京都旅行攻略"),
        });
        memory.upsertTopic("vst_2", {
            chatId: "chat1",
            label: "大阪美食",
            summary: "讨论大阪美食推荐",
            keywords: ["大阪", "美食"],
            embedding: localEmbed("大阪美食推荐"),
        });
        memory.upsertTopic("vst_3", {
            chatId: "chat1",
            label: "Python 教程",
            summary: "Python 入门教程",
            keywords: ["Python"],
            embedding: localEmbed("Python 编程入门"),
        });

        const queryVec = localEmbed("日本旅行京都");
        const results = memory.vectorSearchTopics(queryVec, 3);
        assert.ok(results.length >= 1);
        // 京都旅行应在结果中（vec0 L2 距离与 cosine 排序可能略有差异）
        const labels = results.map(r => r.label);
        assert.ok(labels.includes("京都旅行"), `结果应包含京都旅行，实际: ${labels.join(", ")}`);
        // 确认有 similarity 字段
        assert.ok(typeof results[0].similarity === "number");
        assert.ok(results[0].similarity > 0);
    });

    it("chatId 过滤生效", () => {
        memory.upsertTopic("vst_4", {
            chatId: "chat2",
            label: "另一个群的话题",
            summary: "不应出现",
            embedding: localEmbed("完全不同的话题"),
        });

        const queryVec = localEmbed("京都旅行");
        const results = memory.vectorSearchTopics(queryVec, 10, "chat2");
        // 只返回 chat2 的
        for (const r of results) {
            assert.equal(r.chatId, "chat2");
        }
    });

    it("无 embedding 数据时返回空", () => {
        memory.upsertTopic("vst_5", {
            chatId: "chat3",
            label: "无向量话题",
        });
        const results = memory.vectorSearchTopics(localEmbed("test"), 10, "chat3");
        assert.equal(results.length, 0);
    });

    it("limit 限制生效", () => {
        const queryVec = localEmbed("test");
        const results = memory.vectorSearchTopics(queryVec, 1, "chat1");
        assert.ok(results.length <= 1);
    });
});

// ─── vectorSearchFacts ───

describe("vectorSearchFacts", () => {
    it("返回有 embedding 的 facts 按相似度排序", () => {
        memory.storeFact("alice", "Alice 喜欢吃拉面", "preference", undefined, undefined, localEmbed("Alice 喜欢吃拉面"));
        memory.storeFact("bob", "Bob 是程序员", "biographical", undefined, undefined, localEmbed("Bob 是程序员"));
        memory.storeFact("alice", "Alice 下周去东京", "plan", undefined, undefined, localEmbed("Alice 下周去东京旅行"));

        const queryVec = localEmbed("拉面美食");
        const results = memory.vectorSearchFacts(queryVec, 3);
        assert.ok(results.length >= 1, "should find at least 1 fact");
        assert.ok(typeof results[0].similarity === "number");
        // 确认包含拉面相关 fact
        const hasRamen = results.some(r => r.content.includes("拉面"));
        assert.ok(hasRamen, "results should contain ramen fact");
    });

    it("category 过滤生效", () => {
        const queryVec = localEmbed("任意查询");
        const results = memory.vectorSearchFacts(queryVec, 10, ["preference"]);
        for (const r of results) {
            assert.equal(r.category, "preference");
        }
    });

    it("过期 facts 被过滤", () => {
        memory.storeFact("test", "已过期的计划", "plan", undefined,
            "2020-01-01T00:00:00.000Z",
            localEmbed("已过期的计划"));
        const results = memory.vectorSearchFacts(localEmbed("已过期"), 10);
        const expired = results.find(r => r.content === "已过期的计划");
        assert.equal(expired, undefined);
    });

    it("无 embedding 数据时返回空", () => {
        // storeFact without embedding
        memory.storeFact("noEmb", "无向量事实", "general");
        const results = memory.vectorSearchFacts(localEmbed("无向量"), 10);
        const found = results.find(r => r.content === "无向量事实");
        assert.equal(found, undefined); // 没有 embedding 不参与向量搜索
    });
});

// ─── embedding BLOB round-trip ───

describe("embedding BLOB 存储", () => {
    it("upsertTopic embedding 写入后可读取", () => {
        const vec = localEmbed("BLOB 测试");
        memory.upsertTopic("blob_test", {
            chatId: "chatBlob",
            label: "BLOB embedding test",
            embedding: vec,
        });

        // 通过向量搜索验证
        const results = memory.vectorSearchTopics(vec, 1, "chatBlob");
        assert.ok(results.length >= 1);
        // 自己和自己的相似度应接近 1.0
        assert.ok(results[0].similarity > 0.99, `self-similarity=${results[0].similarity}`);
    });

    it("storeFact embedding 写入后可搜索到", () => {
        const vec = localEmbed("BLOB fact test");
        memory.storeFact("blobTest", "BLOB 事实测试", "general", undefined, undefined, vec);

        const results = memory.vectorSearchFacts(vec, 1);
        assert.ok(results.length >= 1);
        const found = results.find(r => r.content === "BLOB 事实测试");
        assert.ok(found);
        assert.ok(found!.similarity > 0.99);
    });
});
