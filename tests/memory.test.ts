/**
 * memory.test.ts — MemoryStoreV2 Stub 单元测试
 *
 * 验证 V2 占位实现的读空/写弃行为。
 * 确保 stub 不报错，返回正确的空值和占位 ID。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MemoryStoreV2 } from "../src/memory-v2/index.js";

describe("MemoryStoreV2 (stub)", () => {
    function makeStore(): MemoryStoreV2 {
        return new MemoryStoreV2("/tmp/test-memory-v2-stub.db");
    }

    describe("constructor", () => {
        it("should create an instance without errors", () => {
            const mem = makeStore();
            assert.ok(mem);
        });
    });

    describe("V1 compatible methods", () => {
        it("search should return empty array", () => {
            const mem = makeStore();
            const results = mem.search("test query", 10);
            assert.deepEqual(results, []);
        });

        it("store should return a string ID", () => {
            const mem = makeStore();
            const id = mem.store("some content", { source: "test" });
            assert.equal(typeof id, "string");
            assert.ok(id.length > 0);
        });

        it("getPerson should return null", () => {
            const mem = makeStore();
            const person = mem.getPerson("user123");
            assert.equal(person, null);
        });

        it("updatePerson should not throw", () => {
            const mem = makeStore();
            assert.doesNotThrow(() => {
                mem.updatePerson("user123", {
                    displayName: "Alice",
                    traits: ["friendly"],
                });
            });
        });

        it("getRecentConversations should return empty array", () => {
            const mem = makeStore();
            const convos = mem.getRecentConversations("-100123", 5);
            assert.deepEqual(convos, []);
        });

        it("storeConversation should return a string ID", () => {
            const mem = makeStore();
            const id = mem.storeConversation({
                chatId: "-100123",
                chatTitle: "Test Group",
                summary: "Test summary",
                keyPoints: ["point1"],
            });
            assert.equal(typeof id, "string");
            assert.ok(id.length > 0);
        });

        it("getPendingTasks should return empty array", () => {
            const mem = makeStore();
            const tasks = mem.getPendingTasks();
            assert.deepEqual(tasks, []);
        });

        it("addTodo should return a string ID", () => {
            const mem = makeStore();
            const id = mem.addTodo("test todo", "2026-12-31");
            assert.equal(typeof id, "string");
            assert.ok(id.length > 0);
        });

        it("rawQuery SELECT should return empty array", () => {
            const mem = makeStore();
            const result = mem.rawQuery("SELECT * FROM some_table");
            assert.deepEqual(result, []);
        });

        it("rawQuery INSERT should return changes: 0", () => {
            const mem = makeStore();
            const result = mem.rawQuery("INSERT INTO some_table VALUES (?)") as { changes: number };
            assert.equal(result.changes, 0);
        });

        it("close should not throw", () => {
            const mem = makeStore();
            assert.doesNotThrow(() => mem.close());
        });
    });

    describe("V2 new methods", () => {
        it("recall should return empty result", async () => {
            const mem = makeStore();
            const result = await mem.recall("test query", {
                userId: "user123",
                categories: ["preference"],
            });
            assert.deepEqual(result.topics, []);
            assert.deepEqual(result.facts, []);
            assert.deepEqual(result.persons, []);
            assert.equal(result.deepSummary, undefined);
        });

        it("browseHistory should return stub answer", async () => {
            const mem = makeStore();
            const result = await mem.browseHistory({
                intent: "谁说过要去京都",
                hints: { chatId: "-100xxx", daysBack: 7 },
            });
            assert.ok(result.answer.includes("stub"));
            assert.deepEqual(result.segments, []);
            assert.equal(result.messagesRead, 0);
        });

        it("reflect should return empty reflection", async () => {
            const mem = makeStore();
            const result = await mem.reflect("-100123");
            assert.ok(result.reflectedPeriod.from);
            assert.ok(result.reflectedPeriod.to);
            assert.deepEqual(result.topicsSummary, []);
            assert.deepEqual(result.personUpdates, []);
            assert.equal(result.mergedEpisodes, 0);
            assert.deepEqual(result.newCoreFacts, []);
        });

        it("updatePersonProfile should return empty changes", async () => {
            const mem = makeStore();
            const result = await mem.updatePersonProfile("user123", "-100123");
            assert.deepEqual(result.before, {});
            assert.deepEqual(result.after, {});
            assert.ok(result.changes.includes("stub"));
        });
    });
});
