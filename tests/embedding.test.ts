/**
 * embedding.test.ts — embedding 模块单元测试
 *
 * 测试本地 embedding 生成、4 种相似度计算、BLOB 转换、getSimilarityFn 动态选择。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    localEmbed,
    cosineSimilarity,
    dotProduct,
    euclideanSimilarity,
    manhattanSimilarity,
    getSimilarityFn,
    topKSimilar,
    embed,
    embeddingToBuffer,
    bufferToEmbedding,
} from "../src/memory-v2/embedding.js";
import type { EmbeddingConfig } from "../src/core/config.js";

// ─── localEmbed ─────────────────────────────────────────

describe("localEmbed", () => {
    it("生成指定维度的向量", () => {
        const vec = localEmbed("测试文本", 64);
        assert.equal(vec.length, 64);
    });

    it("默认 128 维", () => {
        const vec = localEmbed("hello");
        assert.equal(vec.length, 128);
    });

    it("空字符串 → 零向量", () => {
        const vec = localEmbed("");
        assert.equal(vec.length, 128);
        assert.equal(vec.every(v => v === 0), true);
    });

    it("L2 归一化（单位向量）", () => {
        const vec = localEmbed("任意文本");
        let norm = 0;
        for (const v of vec) norm += v * v;
        assert.ok(Math.abs(Math.sqrt(norm) - 1.0) < 0.001);
    });

    it("确定性：相同输入产生相同向量", () => {
        const a = localEmbed("确定性测试");
        const b = localEmbed("确定性测试");
        assert.deepEqual(Array.from(a), Array.from(b));
    });

    it("相似文本的余弦相似度高于不同文本", () => {
        const base = localEmbed("今天吃了拉面");
        const similar = localEmbed("今天吃了乌冬面");
        const different = localEmbed("量子力学");
        assert.ok(cosineSimilarity(base, similar) > cosineSimilarity(base, different));
    });

    it("不同维度可自定义", () => {
        const v16 = localEmbed("test", 16);
        const v256 = localEmbed("test", 256);
        assert.equal(v16.length, 16);
        assert.equal(v256.length, 256);
    });
});

// ─── cosineSimilarity ───────────────────────────────────

describe("cosineSimilarity", () => {
    it("相同向量 → 1.0", () => {
        const v = new Float32Array([1, 2, 3]);
        assert.ok(Math.abs(cosineSimilarity(v, v) - 1.0) < 0.001);
    });

    it("正交向量 → 0.0", () => {
        const a = new Float32Array([1, 0, 0]);
        const b = new Float32Array([0, 1, 0]);
        assert.ok(Math.abs(cosineSimilarity(a, b)) < 0.001);
    });

    it("反向向量 → -1.0", () => {
        const a = new Float32Array([1, 2, 3]);
        const b = new Float32Array([-1, -2, -3]);
        assert.ok(Math.abs(cosineSimilarity(a, b) + 1.0) < 0.001);
    });

    it("空向量 → 0.0", () => {
        assert.equal(cosineSimilarity(new Float32Array([]), new Float32Array([])), 0);
    });

    it("零向量 → 0.0", () => {
        const z = new Float32Array([0, 0, 0]);
        assert.equal(cosineSimilarity(z, z), 0);
    });

    it("维度不匹配 → 0.0", () => {
        assert.equal(cosineSimilarity(new Float32Array([1, 2]), new Float32Array([1, 2, 3])), 0);
    });
});

// ─── dotProduct ─────────────────────────────────────────

describe("dotProduct", () => {
    it("相同向量 → 正值", () => {
        const v = new Float32Array([1, 2, 3]);
        assert.equal(dotProduct(v, v), 14); // 1+4+9
    });

    it("归一化向量等价 cosine", () => {
        const a = localEmbed("测试A");
        const b = localEmbed("测试B");
        // 对归一化向量, dot ≈ cosine
        assert.ok(Math.abs(dotProduct(a, b) - cosineSimilarity(a, b)) < 0.01);
    });

    it("正交向量 → 0", () => {
        assert.equal(dotProduct(new Float32Array([1, 0]), new Float32Array([0, 1])), 0);
    });

    it("维度不匹配 → 0", () => {
        assert.equal(dotProduct(new Float32Array([1]), new Float32Array([1, 2])), 0);
    });
});

// ─── euclideanSimilarity ────────────────────────────────

describe("euclideanSimilarity", () => {
    it("相同向量 → 0（负距离）", () => {
        const v = new Float32Array([1, 2, 3]);
        assert.ok(Math.abs(euclideanSimilarity(v, v)) < 0.001);
    });

    it("不同向量 → 负值", () => {
        const a = new Float32Array([0, 0]);
        const b = new Float32Array([3, 4]);
        assert.ok(Math.abs(euclideanSimilarity(a, b) + 5) < 0.001); // -sqrt(9+16) = -5
    });

    it("更近的向量有更大的值", () => {
        const base = new Float32Array([0, 0]);
        const near = new Float32Array([1, 0]);
        const far = new Float32Array([10, 0]);
        assert.ok(euclideanSimilarity(base, near) > euclideanSimilarity(base, far));
    });

    it("维度不匹配 → 0", () => {
        assert.equal(euclideanSimilarity(new Float32Array([1]), new Float32Array([1, 2])), 0);
    });
});

// ─── manhattanSimilarity ────────────────────────────────

describe("manhattanSimilarity", () => {
    it("相同向量 → 0", () => {
        const v = new Float32Array([1, 2, 3]);
        assert.ok(Math.abs(manhattanSimilarity(v, v)) < 0.001);
    });

    it("已知距离", () => {
        const a = new Float32Array([0, 0]);
        const b = new Float32Array([3, 4]);
        assert.ok(Math.abs(manhattanSimilarity(a, b) + 7) < 0.001); // -(3+4) = -7
    });

    it("更近的向量有更大的值", () => {
        const base = new Float32Array([0, 0]);
        const near = new Float32Array([1, 1]);
        const far = new Float32Array([10, 10]);
        assert.ok(manhattanSimilarity(base, near) > manhattanSimilarity(base, far));
    });

    it("维度不匹配 → 0", () => {
        assert.equal(manhattanSimilarity(new Float32Array([1]), new Float32Array([1, 2])), 0);
    });
});

// ─── getSimilarityFn ────────────────────────────────────

describe("getSimilarityFn", () => {
    it("cosine → cosineSimilarity", () => {
        assert.equal(getSimilarityFn("cosine"), cosineSimilarity);
    });
    it("dot_product → dotProduct", () => {
        assert.equal(getSimilarityFn("dot_product"), dotProduct);
    });
    it("euclidean → euclideanSimilarity", () => {
        assert.equal(getSimilarityFn("euclidean"), euclideanSimilarity);
    });
    it("manhattan → manhattanSimilarity", () => {
        assert.equal(getSimilarityFn("manhattan"), manhattanSimilarity);
    });
    it("默认 → cosineSimilarity", () => {
        assert.equal(getSimilarityFn(), cosineSimilarity);
    });
    it("未知 → fallback cosine", () => {
        assert.equal(getSimilarityFn("unknown" as any), cosineSimilarity);
    });
});

// ─── topKSimilar ────────────────────────────────────────

describe("topKSimilar", () => {
    const q = new Float32Array([1, 0, 0]);
    const candidates = [
        { id: "a", embedding: new Float32Array([1, 0, 0]) },
        { id: "b", embedding: new Float32Array([0, 1, 0]) },
        { id: "c", embedding: new Float32Array([0.9, 0.1, 0]) },
    ];

    it("返回 top-K 最相似的候选（cosine）", () => {
        const r = topKSimilar(q, candidates, 2, -Infinity, "cosine");
        assert.equal(r.length, 2);
        assert.equal(r[0].id, "a");
    });

    it("按相似度降序排列", () => {
        const r = topKSimilar(q, candidates, 3);
        for (let i = 1; i < r.length; i++) {
            assert.ok(r[i - 1].similarity >= r[i].similarity);
        }
    });

    it("threshold 过滤", () => {
        const r = topKSimilar(q, candidates, 3, 0.5);
        for (const c of r) assert.ok(c.similarity >= 0.5);
    });

    it("空候选 → 空结果", () => {
        assert.equal(topKSimilar(q, [], 3).length, 0);
    });

    it("k=0 → 空结果", () => {
        assert.equal(topKSimilar(q, candidates, 0).length, 0);
    });

    it("dot_product metric 排序正确", () => {
        const r = topKSimilar(q, candidates, 3, -Infinity, "dot_product");
        assert.equal(r[0].id, "a"); // dot(q, a)=1 最大
    });
});

// ─── embed() ────────────────────────────────────────────

describe("embed()", () => {
    const localConfig: EmbeddingConfig = {
        provider: "local",
        baseUrl: "",
        apiKey: "",
        model: "",
        dimensions: 64,
        similarityMetric: "cosine",
    };

    it("空数组 → 空数组", async () => {
        const r = await embed([], localConfig);
        assert.equal(r.length, 0);
    });

    it("本地模式批量生成", async () => {
        const r = await embed(["a", "b"], localConfig);
        assert.equal(r.length, 2);
        assert.equal(r[0].length, 64);
    });
});

// ─── embeddingToBuffer / bufferToEmbedding ──────────────

describe("embeddingToBuffer / bufferToEmbedding", () => {
    it("round-trip 一致", () => {
        const vec = localEmbed("round-trip");
        const buf = embeddingToBuffer(vec);
        const restored = bufferToEmbedding(buf);
        assert.equal(vec.length, restored.length);
        for (let i = 0; i < vec.length; i++) {
            assert.ok(Math.abs(vec[i] - restored[i]) < 1e-6);
        }
    });

    it("Buffer 类型正确", () => {
        const buf = embeddingToBuffer(new Float32Array([1, 2, 3]));
        assert.ok(Buffer.isBuffer(buf));
    });
});
