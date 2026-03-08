/**
 * reply-pipeline.test.ts — ReplyPipeline 单元测试
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ReplyPipeline } from "../src/pipeline/reply-pipeline.js";
import { TopicRegistry } from "../src/pipeline/topic-registry.js";
import { ModelRouter } from "../src/pipeline/model-router.js";
import type { LLMConfig } from "../src/core/config.js";
import type { Message, TriageDecision } from "../src/pipeline/types.js";

const llmConfig: LLMConfig = {
    provider: "openai",
    baseUrl: "https://example.invalid/v1",
    apiKey: "test-key",
    model: "gpt-4o-mini",
    temperature: 0.3,
    maxTokens: 4096,
};

function makeMessage(overrides: Partial<Message> = {}): Message {
    return {
        id: "1",
        chatId: "-1001",
        senderId: "101",
        senderName: "Alice",
        text: "京都怎么去？",
        timestamp: Date.now(),
        ...overrides,
    };
}

describe("ReplyPipeline", () => {
    it("should build direct tasks grouped by chat", () => {
        const registry = new TopicRegistry();
        const router = new ModelRouter(llmConfig);
        const pipeline = new ReplyPipeline({
            recall: async () => ({ topics: [], facts: [], persons: [] }),
        } as any, registry, router, llmConfig);

        const tasks = pipeline.buildDirectTasks([
            makeMessage({ id: "1", chatId: "-1001" }),
            makeMessage({ id: "2", chatId: "-1001", senderName: "Bob" }),
            makeMessage({ id: "3", chatId: "-1002", text: "hello" }),
        ]);

        assert.equal(tasks.length, 2);
        assert.ok(tasks.every(task => task.source === "FAST_PATH"));
        assert.ok(tasks[0].prompt.includes("Reply Pipeline"));
    });

    it("should build topic task with memory recall context", async () => {
        const registry = new TopicRegistry();
        const router = new ModelRouter(llmConfig);
        const pipeline = new ReplyPipeline({
            recall: async () => ({
                topics: [{ id: "t1", chatId: "-1001", label: "京都旅行", summary: "", keyPoints: [], participants: [], messageRange: { messageIds: [], count: 0 }, startedAt: "", endedAt: null, sentiment: "neutral", relatedTopicIds: [], keywords: [], wasEngaged: false, interventionCount: 0, createdAt: "", updatedAt: "" }],
                facts: [{ content: "Alice 喜欢京都", category: "preference", subject: "alice", confidence: 0.8 }],
                persons: [],
            }),
        } as any, registry, router, llmConfig);

        const topic = registry.create("-1001", "京都交通", ["京都", "交通"], [
            makeMessage({ id: "1", text: "京都交通怎么安排？" }),
        ]);
        const decision: TriageDecision = {
            should_intervene: true,
            reason: "有人提问无人回答",
            intervention_type: "QUESTION_ANSWER",
            confidence: 0.9,
            pipelineMode: "GUIDED",
        };
        registry.setDecision(topic.id, decision);

        const task = await pipeline.buildTopicTask(topic.id);
        assert.ok(task);
        assert.equal(task!.source, "TOPIC_TRIAGE");
        assert.ok(task!.prompt.includes("京都交通"));
        assert.ok(task!.prompt.includes("Alice 喜欢京都"));
    });

    it("should build engaged task with reply hint", async () => {
        const registry = new TopicRegistry();
        const router = new ModelRouter(llmConfig);
        const pipeline = new ReplyPipeline({
            recall: async () => ({ topics: [], facts: [], persons: [] }),
        } as any, registry, router, llmConfig);

        const topic = registry.create("-1001", "Rust 性能", ["Rust"], [
            makeMessage({ id: "1", text: "Rust 真比 Go 快吗？" }),
        ]);
        registry.transition(topic.id, "TRIAGING");
        registry.transition(topic.id, "PRELOADING");
        registry.transition(topic.id, "ENGAGED");

        const task = await pipeline.buildEngagedTask(
            topic.id,
            [makeMessage({ id: "2", text: "那内存占用呢？" })],
            "先回答差异，再补一个 caveat"
        );

        assert.ok(task);
        assert.equal(task!.source, "ENGAGED");
        assert.ok(task!.prompt.includes("先回答差异"));
        assert.equal(task!.topicId, topic.id);
    });
});
