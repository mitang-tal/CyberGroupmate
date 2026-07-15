import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RecordingPipeline } from "../src/pipeline/recording-pipeline.js";
import { TopicRegistry } from "../src/pipeline/topic-registry.js";
import type { Message, TopicClusteringResult } from "../src/pipeline/types.js";

function makeMessages(n: number, chatId = "telegram:-100"): Message[] {
    const base = 1_700_000_000_000;
    return Array.from({ length: n }, (_, i) => ({
        id: String(1000 + i),
        chatId,
        senderId: `u${i % 3}`,
        senderName: `user${i % 3}`,
        text: `msg ${i}`,
        timestamp: base + i * 1000,
    })) as Message[];
}

/** 让 cluster 步骤返回「单话题归类」（模拟保底降级或正常成功），三态不触网。 */
function stubSuccess(pipeline: RecordingPipeline): void {
    (pipeline as any).llmTopicClustering = async (msgs: Message[]): Promise<TopicClusteringResult> => ({
        assignments: msgs.map(m => ({ messageId: m.id, topicId: "NEW_1", topicLabel: "对话讨论", keywords: [] })),
        evolutions: [],
    });
    (pipeline as any).llmTopicSummaryTriage = async () => ({ topics: [] });
}

describe("recording pipeline flush batching + safety floor", () => {
    it("caps a flush to maxFlushBatch, leaving the remainder buffered", async () => {
        // memory 省略 → flush 的 Step4 落盘被 `if (this.memory)` 跳过，只跑聚类/triage/registry
        const pipeline = new RecordingPipeline(new TopicRegistry(), "Miu", "Miu", undefined, undefined, {
            maxFlushBatch: 5,
            minFlushSize: 1,
        });
        stubSuccess(pipeline);
        (pipeline as any).buffer = makeMessages(12);

        await (pipeline as any).flush();

        // 只处理 5 条，其余 7 条留 buffer 下轮排空（输出体积被锁死）
        assert.equal((pipeline as any).buffer.length, 7);
    });

    it("drains a backlog across repeated flushes", async () => {
        const pipeline = new RecordingPipeline(new TopicRegistry(), "Miu", "Miu", undefined, undefined, {
            maxFlushBatch: 5,
            minFlushSize: 1,
        });
        stubSuccess(pipeline);
        (pipeline as any).buffer = makeMessages(12);

        await (pipeline as any).flush();
        assert.equal((pipeline as any).buffer.length, 7);
        await (pipeline as any).flush();
        assert.equal((pipeline as any).buffer.length, 2);
        await (pipeline as any).flush();
        assert.equal((pipeline as any).buffer.length, 0);
    });

    it("caps the buffer on repeated failure instead of growing unbounded (no death spiral)", async () => {
        const pipeline = new RecordingPipeline(new TopicRegistry(), "Miu", "Miu", undefined, undefined, {
            maxFlushBatch: 5,
            maxBufferSize: 10,
            minFlushSize: 1,
        });
        // 模拟持续失败（非 LLM 错误逃逸到 flush catch）
        (pipeline as any).llmTopicClustering = async () => { throw new Error("boom"); };
        (pipeline as any).buffer = makeMessages(12);

        await (pipeline as any).flush();

        // 失败批次 unshift 回去后总量 12 > cap 10 → 丢最旧、封顶在 10，绝不越滚越大
        assert.equal((pipeline as any).buffer.length, 10);
        assert.ok((pipeline as any).buffer.length <= 10);
    });

    it("fallbackClustering assigns every message to a single topic (drains, no re-buffer)", () => {
        const pipeline = new RecordingPipeline(new TopicRegistry(), "Miu", "Miu");
        const msgs = makeMessages(37);

        const result: TopicClusteringResult = (pipeline as any).fallbackClustering(msgs);

        assert.equal(result.assignments.length, 37);
        assert.ok(result.assignments.every(a => a.topicId === "NEW_1"));
        assert.deepEqual(result.evolutions, []);
    });
});
