/**
 * memory.test.ts — MemoryStore 单元测试
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../src/memory.js";
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

function createTempDb(): string {
    return join(tmpdir(), `mem-test-${randomUUID()}`, "test.db");
}

describe("MemoryStore", () => {
    const tempPaths: string[] = [];

    function makeStore(): MemoryStore {
        const p = createTempDb();
        tempPaths.push(p);
        return new MemoryStore(p);
    }

    after(() => {
        for (const p of tempPaths) {
            const dir = join(p, "..");
            if (existsSync(dir)) {
                rmSync(dir, { recursive: true, force: true });
            }
        }
    });

    describe("store and search", () => {
        it("should store and retrieve a memory via FTS5 search", () => {
            const mem = makeStore();
            mem.store("alice 喜欢喝抹茶拿铁", { source: "telegram" });
            mem.store("bob 最近在学日语", { source: "telegram" });

            const results = mem.search("抹茶");
            assert.equal(results.length, 1);
            assert.ok(results[0].content.includes("抹茶"));
            assert.equal(results[0].metadata.source, "telegram");
            assert.ok(results[0].id);
            assert.ok(results[0].timestamp);

            mem.close();
        });

        it("should return empty for no matches", () => {
            const mem = makeStore();
            mem.store("some content");

            const results = mem.search("nonexistent");
            assert.equal(results.length, 0);

            mem.close();
        });

        it("should respect limit parameter", () => {
            const mem = makeStore();
            for (let i = 0; i < 20; i++) {
                mem.store(`memory entry number ${i}`);
            }

            const results = mem.search("memory", 5);
            assert.equal(results.length, 5);

            mem.close();
        });

        it("should store with metadata", () => {
            const mem = makeStore();
            const id = mem.store("test content", {
                chatId: -100123,
                fromUser: "alice",
                custom: { nested: true },
            });

            assert.ok(id);

            // 通过 rawQuery 验证
            const rows = mem.rawQuery(
                "SELECT metadata FROM memories WHERE id = ?",
                id
            ) as Array<{ metadata: string }>;
            const meta = JSON.parse(rows[0].metadata);
            assert.equal(meta.chatId, -100123);
            assert.equal(meta.fromUser, "alice");
            assert.deepEqual(meta.custom, { nested: true });

            mem.close();
        });
    });

    describe("person profiles", () => {
        it("should return null for non-existent person", () => {
            const mem = makeStore();
            const person = mem.getPerson("nonexistent");
            assert.equal(person, null);
            mem.close();
        });

        it("should create and retrieve a person profile", () => {
            const mem = makeStore();
            mem.updatePerson("user123", {
                displayName: "Alice",
                notes: "喜欢喝奶茶",
                traits: ["friendly", "tech-savvy"],
            });

            const person = mem.getPerson("user123");
            assert.ok(person);
            assert.equal(person!.userId, "user123");
            assert.equal(person!.displayName, "Alice");
            assert.equal(person!.notes, "喜欢喝奶茶");
            assert.deepEqual(person!.traits, ["friendly", "tech-savvy"]);

            mem.close();
        });

        it("should merge-update person profile", () => {
            const mem = makeStore();

            // Initial profile
            mem.updatePerson("user456", {
                displayName: "Bob",
                traits: ["funny"],
            });

            // Merge update
            mem.updatePerson("user456", {
                notes: "在学日语",
                traits: ["creative"],
            });

            const person = mem.getPerson("user456");
            assert.ok(person);
            assert.equal(person!.displayName, "Bob"); // preserved
            assert.equal(person!.notes, "在学日语"); // added
            assert.deepEqual(person!.traits, ["funny", "creative"]); // merged

            mem.close();
        });

        it("should not duplicate array values on merge", () => {
            const mem = makeStore();

            mem.updatePerson("user789", { traits: ["a", "b"] });
            mem.updatePerson("user789", { traits: ["b", "c"] });

            const person = mem.getPerson("user789");
            assert.deepEqual(person!.traits, ["a", "b", "c"]);

            mem.close();
        });
    });

    describe("conversation log", () => {
        it("should store and retrieve conversations", () => {
            const mem = makeStore();

            mem.storeConversation({
                chatId: "-100123",
                chatTitle: "二次元研究所",
                summary: "讨论了东京旅游的计划",
                keyPoints: ["alice 推荐了秋叶原", "bob 想去富士山"],
            });

            const convos = mem.getRecentConversations();
            assert.equal(convos.length, 1);
            assert.equal(convos[0].chatTitle, "二次元研究所");
            assert.equal(convos[0].summary, "讨论了东京旅游的计划");
            assert.deepEqual(convos[0].keyPoints, [
                "alice 推荐了秋叶原",
                "bob 想去富士山",
            ]);

            mem.close();
        });

        it("should filter by chatId", () => {
            const mem = makeStore();

            mem.storeConversation({
                chatId: "-100111",
                chatTitle: "Group A",
                summary: "Summary A",
                keyPoints: [],
            });
            mem.storeConversation({
                chatId: "-100222",
                chatTitle: "Group B",
                summary: "Summary B",
                keyPoints: [],
            });

            const filtered = mem.getRecentConversations("-100111");
            assert.equal(filtered.length, 1);
            assert.equal(filtered[0].chatTitle, "Group A");

            mem.close();
        });
    });

    describe("todos", () => {
        it("should add and retrieve pending todos", () => {
            const mem = makeStore();
            const id = mem.addTodo("提醒 alice 明天生日");

            const tasks = mem.getPendingTasks();
            assert.equal(tasks.length, 1);
            assert.equal(tasks[0].id, id);
            assert.equal(tasks[0].description, "提醒 alice 明天生日");
            assert.equal(tasks[0].done, false);

            mem.close();
        });

        it("should support due dates", () => {
            const mem = makeStore();
            mem.addTodo("买蛋糕", "2026-03-01T00:00:00Z");

            const tasks = mem.getPendingTasks();
            assert.equal(tasks[0].dueDate, "2026-03-01T00:00:00Z");

            mem.close();
        });
    });

    describe("rawQuery", () => {
        it("should execute raw SELECT queries", () => {
            const mem = makeStore();
            mem.store("raw query test", { tag: "raw" });

            const results = mem.rawQuery(
                "SELECT content FROM memories WHERE content MATCH ?",
                "raw"
            ) as Array<{ content: string }>;
            assert.equal(results.length, 1);
            assert.ok(results[0].content.includes("raw query test"));

            mem.close();
        });

        it("should execute raw INSERT/UPDATE queries", () => {
            const mem = makeStore();

            mem.rawQuery(
                "INSERT INTO todos (id, description, created_at, done) VALUES (?, ?, ?, 0)",
                "custom-id",
                "custom todo",
                new Date().toISOString()
            );

            const tasks = mem.getPendingTasks();
            assert.equal(tasks.length, 1);
            assert.equal(tasks[0].id, "custom-id");

            mem.close();
        });
    });
});
