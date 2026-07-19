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

    it("clamps out-of-range maxFlushBatch/maxBufferSize (0/负/小数/Infinity) to safe values", () => {
        // 非法值回退默认（maxFlushBatch=120 / maxBufferSize=1000）：
        // 0 → slice(0,0) 空批 + 每 3s 空转；负/-0 → slice(-0)===slice(0) 保留整个 buffer、封顶失效
        const bad = new RecordingPipeline(new TopicRegistry(), "Miu", "Miu", undefined, undefined, {
            maxFlushBatch: 0,
            maxBufferSize: -5,
        });
        assert.equal((bad as any).maxFlushBatch, 120);
        assert.equal((bad as any).maxBufferSize, 1000);

        // Infinity 也视为非法（等于不封顶＝重新引入死亡螺旋）→ 回退默认
        const infinite = new RecordingPipeline(new TopicRegistry(), "Miu", "Miu", undefined, undefined, {
            maxFlushBatch: Infinity,
        });
        assert.equal((infinite as any).maxFlushBatch, 120);

        // 合法值原样透传，小数向下取整为整数（7.9 → 7）
        const ok = new RecordingPipeline(new TopicRegistry(), "Miu", "Miu", undefined, undefined, {
            maxFlushBatch: 7.9,
            maxBufferSize: 42,
        });
        assert.equal((ok as any).maxFlushBatch, 7);
        assert.equal((ok as any).maxBufferSize, 42);
    });

    it("re-arms drain for a sub-minFlushSize tail on success, but throttles it on error", () => {
        const pipeline = new RecordingPipeline(new TopicRegistry(), "Miu", "Miu", undefined, undefined, {
            minFlushSize: 10,
        });
        // 成功路径：批次上限切剩的 3 条尾巴（< minFlushSize 10）仍要排空，否则滞留到下次活跃/静默才落盘
        (pipeline as any).buffer = makeMessages(3);
        assert.equal((pipeline as any).shouldRearmDrain(false), true);
        // 失败路径：同样 3 条不排空——避免对持续失败的小批次每 3s 热重试刷屏
        assert.equal((pipeline as any).shouldRearmDrain(true), false);
        // 失败路径：积压 >= minFlushSize 仍排空以追赶
        (pipeline as any).buffer = makeMessages(10);
        assert.equal((pipeline as any).shouldRearmDrain(true), true);
        // buffer 空：任何路径都不排空
        (pipeline as any).buffer = [];
        assert.equal((pipeline as any).shouldRearmDrain(false), false);
    });
});
