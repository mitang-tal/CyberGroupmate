/**
 * scene-manager.test.ts — SceneManager 单元测试
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SceneManager } from "../src/scenes/scene-manager.js";
import { registerBuiltinScenes } from "../src/scenes/index.js";

describe("SceneManager", () => {
    function makeManager(): SceneManager {
        const sm = new SceneManager();
        sm.register({
            name: "home",
            description: "通知中心",
            typeDefs: "declare const scene: { enter(name: string): void };",
        });
        sm.register({
            name: "telegram",
            description: "Telegram 操作",
            typeDefs: "interface TelegramClient { sendText(...): Promise<Message> }",
            fullTypeDefs: "// Full telegram types ...\n// 500 lines of types",
            contextSetup: "ctx.tg 是 TelegramClient 实例",
        });
        sm.register({
            name: "memory",
            description: "记忆系统",
            typeDefs: "interface MemoryStore { search(q: string): MemoryEntry[] }",
        });
        return sm;
    }

    it("should start with 'home' as current scene", () => {
        const sm = makeManager();
        assert.equal(sm.current, "home");
    });

    it("should register and list scenes", () => {
        const sm = makeManager();
        const list = sm.list();
        assert.equal(list.length, 3);
        assert.deepEqual(
            list.map((s) => s.name),
            ["home", "telegram", "memory"]
        );
    });

    it("should not allow duplicate scene registration", () => {
        const sm = makeManager();
        assert.throws(
            () =>
                sm.register({
                    name: "home",
                    description: "duplicate",
                    typeDefs: "...",
                }),
            { message: /already registered/ }
        );
    });

    it("should enter a scene and return its info", () => {
        const sm = makeManager();
        const info = sm.enter("telegram");

        assert.equal(info.name, "telegram");
        assert.equal(info.description, "Telegram 操作");
        assert.ok(info.typeDefs.includes("TelegramClient"));
        assert.equal(info.contextSetup, "ctx.tg 是 TelegramClient 实例");
        assert.equal(sm.current, "telegram");
    });

    it("should throw when entering non-existent scene", () => {
        const sm = makeManager();
        assert.throws(() => sm.enter("nonexistent"), {
            message: /not found/,
        });
    });

    it("should show full types for current scene", () => {
        const sm = makeManager();
        sm.enter("telegram");
        const full = sm.showFullTypes();
        assert.ok(full.includes("Full telegram types"));
    });

    it("should return fallback message when no full types available", () => {
        const sm = makeManager();
        sm.enter("memory");
        const full = sm.showFullTypes();
        assert.ok(full.includes("No extended type definitions"));
    });

    it("should track scene switching correctly", () => {
        const sm = makeManager();
        assert.equal(sm.current, "home");

        sm.enter("telegram");
        assert.equal(sm.current, "telegram");

        sm.enter("memory");
        assert.equal(sm.current, "memory");

        sm.enter("home");
        assert.equal(sm.current, "home");
    });

    it("should check scene existence with hasScene", () => {
        const sm = makeManager();
        assert.equal(sm.hasScene("home"), true);
        assert.equal(sm.hasScene("telegram"), true);
        assert.equal(sm.hasScene("nonexistent"), false);
    });

    it("should list scene names", () => {
        const sm = makeManager();
        const names = sm.listNames();
        assert.deepEqual(names, ["home", "telegram", "memory"]);
    });
});

describe("registerBuiltinScenes", () => {
    it("should register all builtin scenes from .d.ts files", () => {
        const sm = new SceneManager();
        registerBuiltinScenes(sm);

        assert.equal(sm.hasScene("home"), true);
        assert.equal(sm.hasScene("telegram"), true);
        assert.equal(sm.hasScene("memory"), true);

        // Verify type defs contain expected content
        const homeInfo = sm.enter("home");
        assert.ok(homeInfo.typeDefs.includes("scene"));
        assert.ok(homeInfo.typeDefs.includes("runtime"));
        assert.ok(homeInfo.typeDefs.includes("ctx"));

        const tgInfo = sm.enter("telegram");
        assert.ok(tgInfo.typeDefs.includes("TelegramClient"));
        assert.ok(tgInfo.typeDefs.includes("Message"));
        assert.ok(tgInfo.typeDefs.includes("sendText"));

        const memInfo = sm.enter("memory");
        assert.ok(memInfo.typeDefs.includes("MemoryStore"));
        assert.ok(memInfo.typeDefs.includes("search"));
        assert.ok(memInfo.typeDefs.includes("PersonProfile"));
    });
});
