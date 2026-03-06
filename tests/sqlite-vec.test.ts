/**
 * tests/sqlite-vec.test.ts — sqlite-vec 向量索引集成测试
 *
 * 覆盖 M4.7：
 * - sqlite-vec 扩展加载 + vec0 虚拟表创建
 * - topics_vec / facts_vec 写入同步
 * - vec0 KNN 查询路径 vs. 纯 JS fallback
 * - rebuildVecIndex 批量迁移
 * - partition key (chatId) 过滤
 * - 过期 facts 在 vec0 结果中被过滤
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { MemoryStoreV2 } from "../src/memory-v2/memory-v2.js";
import { localEmbed } from "../src/memory-v2/embedding.js";

const TEST_DIR = "/tmp/cybergroupmate-test";
const DB_PATH = `${TEST_DIR}/sqlite-vec-test.db`;

let memory: MemoryStoreV2;

before(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    memory = new MemoryStoreV2(DB_PATH);
});

after(() => {
    memory.close();
    try { rmSync(DB_PATH, { force: true }); } catch { }
});

// ─── 1. 扩展加载 ───

describe("sqlite-vec 扩展加载", () => {
    it("sqlite-vec 应被成功加载", () => {
        assert.equal(memory.sqliteVecAvailable, true, "sqlite-vec 应可用");
    });
});

// ─── 2. vec0 写入同步 ───

describe("vec0 写入同步", () => {
    it("upsertTopic 同时写入 topics_vec", () => {
        const embedding = localEmbed("京都旅行攻略");
        memory.upsertTopic("svt_1", {
            chatId: "chat_sv1",
            label: "京都旅行",
            summary: "讨论京都岚山观光",
            embedding,
        });

        // 用 vec0 搜索应该能找到
        const results = memory.vectorSearchTopics(embedding, 1, "chat_sv1");
        assert.ok(results.length >= 1, "应找到至少 1 个 topic");
        assert.equal(results[0].label, "京都旅行");
        // vec0 使用 L2 距离，归一化向量自身距离接近 0 → similarity 接近 1
        assert.ok(results[0].similarity > 0.9, `自身相似度 ${results[0].similarity} 应 > 0.9`);
    });

    it("storeFact 同时写入 facts_vec", () => {
        const embedding = localEmbed("Alice 喜欢吃拉面");
        memory.storeFact("alice", "Alice 喜欢吃拉面", "preference", undefined, undefined, embedding);

        const results = memory.vectorSearchFacts(embedding, 1);
        assert.ok(results.length >= 1, "应找到至少 1 个 fact");
        assert.ok(results[0].content.includes("拉面"));
        assert.ok(results[0].similarity > 0.9, `自身相似度 ${results[0].similarity} 应 > 0.9`);
    });

    it("upsertTopic 更新 embedding 时 vec0 同步更新", () => {
        // 首次写入
        const emb1 = localEmbed("Python 编程");
        memory.upsertTopic("svt_update", {
            chatId: "chat_sv1",
            label: "Python 教程",
            summary: "Python 入门",
            embedding: emb1,
        });

        // 更新 embedding
        const emb2 = localEmbed("大阪美食推荐");
        memory.upsertTopic("svt_update", {
            label: "大阪美食",
            summary: "大阪美食推荐",
            embedding: emb2,
        });

        // 用更新后的 embedding 搜索应命中更新后的话题
        const results = memory.vectorSearchTopics(emb2, 5, "chat_sv1");
        const found = results.find(r => r.label === "大阪美食");
        assert.ok(found, "应找到更新后的话题");
        assert.ok(found!.similarity > 0.9, "更新后的 embedding 应匹配");
    });
});

// ─── 3. vec0 KNN 查询 ───

describe("vec0 KNN 查询", () => {
    before(() => {
        // 插入多个有不同 embedding 的 topics
        const topics = [
            { id: "knn_1", chatId: "chat_knn", label: "旅行攻略", text: "东京旅行攻略大全" },
            { id: "knn_2", chatId: "chat_knn", label: "编程语言", text: "Rust 编程入门教程" },
            { id: "knn_3", chatId: "chat_knn", label: "美食推荐", text: "日本拉面美食推荐" },
            { id: "knn_4", chatId: "chat_other", label: "另一群话题", text: "游戏讨论" },
        ];
        for (const t of topics) {
            memory.upsertTopic(t.id, {
                chatId: t.chatId,
                label: t.label,
                summary: t.text,
                embedding: localEmbed(t.text),
            });
        }
    });

    it("语义搜索返回最相关结果", () => {
        const queryVec = localEmbed("日本旅行东京");
        const results = memory.vectorSearchTopics(queryVec, 3, "chat_knn");
        assert.ok(results.length >= 1);
        // 旅行攻略应排第一
        assert.equal(results[0].label, "旅行攻略");
    });

    it("chatId partition key 过滤生效", () => {
        const queryVec = localEmbed("任意查询");
        const results = memory.vectorSearchTopics(queryVec, 10, "chat_other");
        for (const r of results) {
            assert.equal(r.chatId, "chat_other");
        }
    });

    it("limit 限制返回数量", () => {
        const queryVec = localEmbed("test");
        const results = memory.vectorSearchTopics(queryVec, 1, "chat_knn");
        assert.ok(results.length <= 1);
    });

    it("无 chatId 时搜索所有", () => {
        const queryVec = localEmbed("test query");
        const results = memory.vectorSearchTopics(queryVec, 100);
        // 应返回所有有 embedding 的 topics
        assert.ok(results.length >= 4, `应至少 4 个结果，实际 ${results.length}`);
    });

    it("facts vec0 KNN 查询正确", () => {
        memory.storeFact("bob", "Bob 是程序员", "biographical", undefined, undefined, localEmbed("Bob 是前端程序员"));
        memory.storeFact("carol", "Carol 喜欢猫", "preference", undefined, undefined, localEmbed("Carol 喜欢养猫"));

        const queryVec = localEmbed("编程 程序员");
        const results = memory.vectorSearchFacts(queryVec, 3);
        assert.ok(results.length >= 1);
        const hasBob = results.some(r => r.content.includes("Bob"));
        assert.ok(hasBob, "应找到 Bob 是程序员的 fact");
    });

    it("facts 带 category 过滤时 fallback 纯 JS", () => {
        const queryVec = localEmbed("喜欢");
        const results = memory.vectorSearchFacts(queryVec, 10, ["preference"]);
        for (const r of results) {
            assert.equal(r.category, "preference");
        }
    });
});

// ─── 4. rebuildVecIndex ───

describe("rebuildVecIndex", () => {
    it("重建索引后搜索仍然正确", () => {
        // 先搜索记录当前状态
        const queryVec = localEmbed("京都旅行");
        const beforeResults = memory.vectorSearchTopics(queryVec, 1, "chat_sv1");
        assert.ok(beforeResults.length >= 1, "重建前应有结果");

        // 重建
        const stats = memory.rebuildVecIndex();
        assert.ok(stats.topics > 0, `rebuild topics ${stats.topics} > 0`);
        assert.ok(stats.facts > 0, `rebuild facts ${stats.facts} > 0`);

        // 重建后搜索结果应一致
        const afterResults = memory.vectorSearchTopics(queryVec, 1, "chat_sv1");
        assert.ok(afterResults.length >= 1, "重建后应有结果");
        assert.equal(afterResults[0].label, beforeResults[0].label);
    });

    it("rebuildVecIndex 返回正确计数", () => {
        const stats = memory.rebuildVecIndex();
        assert.ok(typeof stats.topics === "number");
        assert.ok(typeof stats.facts === "number");
    });
});

// ─── 5. 过期 facts ───

describe("vec0 过期 facts 处理", () => {
    it("过期 facts 在 vec0 搜索中被主表过滤", () => {
        const expiredEmb = localEmbed("已过期的计划内容");
        memory.storeFact("test_expire", "过期计划", "plan", undefined,
            "2020-01-01T00:00:00.000Z", expiredEmb);

        const results = memory.vectorSearchFacts(expiredEmb, 10);
        const found = results.find(r => r.content === "过期计划");
        assert.equal(found, undefined, "过期 fact 不应出现在搜索结果中");
    });
});
