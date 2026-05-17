import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ContextEngine } from "../src/context-engine/context-engine.js";
import {
    metaGroupModelProvider,
    metaTodosProvider,
} from "../src/context-engine/providers/meta-providers.js";
import type { GroupModel } from "../src/memory-v2/types.js";

function makeGroupModel(overrides: Partial<GroupModel> = {}): GroupModel {
    return {
        chatId: "telegram:g1",
        chatTitle: "测试群",
        isDirectMessage: false,
        description: "测试上下文群",
        dominantLanguage: "中文",
        communicationNorms: ["轻松", "直接"],
        activeMembers: 6,
        avgMessagesPerDay: 42,
        peakHours: [20, 21],
        agentRole: "轻量协助者",
        engagementLevel: "medium",
        recentFeedback: "",
        hotTopics: ["上下文引擎"],
        tabooTopics: ["剧透"],
        lastReflectedAt: null,
        updatedAt: "2026-05-17T00:00:00.000Z",
        ...overrides,
    };
}

describe("Meta delta providers", () => {
    it("metaTodosProvider only emits changed todos and removal tombstones", () => {
        const engine = new ContextEngine("meta-todo-delta-test");
        engine.register(metaTodosProvider);

        const first = engine.render({
            todos: [{ bindingId: "meta", key: "followup", content: "回看构建结果", dueAt: null }],
        });
        assert.match(first.historicalContent, /# 当前 Todo 增量/);
        assert.match(first.historicalContent, /followup: 回看构建结果/);
        engine.commit(first.tree);

        const same = engine.render({
            todos: [{ bindingId: "meta", key: "followup", content: "回看构建结果", dueAt: null }],
        });
        assert.equal(same.historicalContent, "");

        const updated = engine.render({
            todos: [{ bindingId: "meta", key: "followup", content: "回看测试结果", dueAt: null }],
        });
        assert.match(updated.historicalContent, /followup: 回看测试结果/);
        assert.equal(updated.tree[0].deltaStats?.added, 1);
        engine.commit(updated.tree);

        const removed = engine.render({ todos: [] });
        assert.match(removed.historicalContent, /followup: 已移除/);
        assert.equal(removed.tree[0].deltaStats?.added, 1);
    });

    it("metaGroupModelProvider emits only missing or updated profile modules", () => {
        const engine = new ContextEngine("meta-group-model-delta-test");
        engine.register(metaGroupModelProvider);

        const ctx = {
            chatId: "telegram:g1",
            groupModel: makeGroupModel(),
            tonePreset: "轻松自然",
        };
        const first = engine.render(ctx);
        assert.match(first.historicalContent, /## 聊天画像增量/);
        assert.match(first.historicalContent, /交流规范: 轻松, 直接/);
        assert.match(first.historicalContent, /热点话题: 上下文引擎/);
        engine.commit(first.tree);

        const same = engine.render(ctx);
        assert.equal(same.historicalContent, "");

        const changed = engine.render({
            ...ctx,
            groupModel: makeGroupModel({
                hotTopics: ["上下文引擎", "增量注入"],
                recentFeedback: "最近希望 Meta 少重复旧画像",
            }),
        });
        assert.match(changed.historicalContent, /热点话题: 上下文引擎, 增量注入/);
        assert.match(changed.historicalContent, /最近反馈: 最近希望 Meta 少重复旧画像/);
        assert.doesNotMatch(changed.historicalContent, /标题: 测试群/);
        assert.equal(changed.tree[0].deltaStats?.added, 2);
    });
});
