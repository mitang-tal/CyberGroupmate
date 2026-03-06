/**
 * embedding.ts — 文本向量化模块
 *
 * 提供文本 → 向量的转换能力，支持两种模式：
 * 1. OpenAI 兼容 API（生产环境，base_url/api_key/model 全部可配）
 * 2. 本地 hash-based embedding（测试/无 API 环境）
 *
 * 配置统一由 config.yaml 的 embedding 节管理（见 config.ts EmbeddingConfig）。
 *
 * 相似度计算支持多种度量：cosine / dot_product / euclidean / manhattan。
 * 通过 `getSimilarityFn(metric)` 动态选择。
 */

import { createLogger } from "../core/logger.js";
import type { EmbeddingConfig, SimilarityMetric } from "../core/config.js";

const log = createLogger("embedding");

// 重新导出给消费者使用
export type { EmbeddingConfig, SimilarityMetric } from "../core/config.js";

// ─── 常量 ───

const MAX_RETRIES = 3;
const RETRY_DELAYS = [500, 1000, 2000];
const LOCAL_DIMENSIONS = 128;

// ─── 主入口 ───

/**
 * 批量文本向量化
 *
 * @param texts - 待向量化的文本数组
 * @param config - Embedding 配置（来自 config.yaml 或直接传入）
 * @returns 与 texts 等长的 Float32Array 数组
 */
export async function embed(
    texts: string[],
    config: EmbeddingConfig,
): Promise<Float32Array[]> {
    if (texts.length === 0) return [];

    if (config.provider === "openai") {
        return callEmbeddingAPI(texts, config);
    }

    // 本地模式：同步生成
    const dims = config.dimensions ?? LOCAL_DIMENSIONS;
    log.debug("embed: 本地模式", { count: texts.length, dims });
    return texts.map(t => localEmbed(t, dims));
}

// ─── OpenAI 兼容 Embedding API ───

/**
 * 调用 OpenAI 兼容的 embedding API
 *
 * 支持任意 base_url + api_key + model 组合（OpenAI / Azure / 本地部署）。
 * 自带重试和错误处理。
 */
async function callEmbeddingAPI(
    texts: string[],
    config: EmbeddingConfig,
): Promise<Float32Array[]> {
    const baseUrl = config.baseUrl.replace(/\/$/, "");
    const model = config.model;
    const dimensions = config.dimensions;

    log.debug("embed: API 调用", { count: texts.length, model, dimensions, baseUrl });

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            const response = await fetch(`${baseUrl}/embeddings`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    ...(config.apiKey ? { "Authorization": `Bearer ${config.apiKey}` } : {}),
                },
                body: JSON.stringify({
                    model,
                    input: texts,
                    dimensions,
                }),
            });

            if (!response.ok) {
                const body = await response.text().catch(() => "");
                throw new Error(`Embedding API error ${response.status}: ${body}`);
            }

            const data = await response.json() as {
                data: Array<{ embedding: number[]; index: number }>;
            };

            // 按 index 排序确保顺序正确
            const sorted = data.data.sort((a, b) => a.index - b.index);
            return sorted.map(d => new Float32Array(d.embedding));
        } catch (err) {
            const isRetryable = err instanceof Error && (
                err.message.includes("429") ||
                err.message.includes("500") ||
                err.message.includes("502") ||
                err.message.includes("503")
            );

            if (isRetryable && attempt < MAX_RETRIES) {
                const delay = RETRY_DELAYS[attempt] ?? 2000;
                log.warn("embed: API 重试", { attempt: attempt + 1, delay });
                await new Promise(r => setTimeout(r, delay));
                continue;
            }

            log.error("embed: API 失败", { error: String(err) });
            throw err;
        }
    }

    throw new Error("Embedding API failed after all retries");
}

// ─── 本地 Hash-based Embedding ───

/**
 * 本地 hash-based 向量生成
 *
 * 使用 FNV-1a hash 的变体生成确定性伪随机向量。
 * 相似文本会产生有一定余弦相似度的向量（通过 n-gram 重叠实现）。
 *
 * 注意：这不是真正的语义 embedding，仅用于测试和无 API 环境。
 *
 * @param text - 输入文本
 * @param dims - 向量维度（默认 128）
 * @returns 归一化的 Float32Array
 */
export function localEmbed(text: string, dims: number = LOCAL_DIMENSIONS): Float32Array {
    if (!text) return new Float32Array(dims);

    const vec = new Float32Array(dims);

    const ngrams = extractNgrams(text, 3);
    for (const ngram of ngrams) {
        const hash = fnv1a(ngram);
        const idx = Math.abs(hash) % dims;
        const sign = (hash & 1) === 0 ? 1.0 : -1.0;
        vec[idx] += sign;
    }

    for (const ch of text) {
        const hash = fnv1a(ch);
        const idx = Math.abs(hash) % dims;
        vec[idx] += 0.3;
    }

    const bigrams = extractNgrams(text, 2);
    for (const bg of bigrams) {
        const hash = fnv1a(bg);
        const idx = Math.abs(hash) % dims;
        const sign = (hash & 1) === 0 ? 0.5 : -0.5;
        vec[idx] += sign;
    }

    normalizeL2(vec);
    return vec;
}

function extractNgrams(text: string, n: number): string[] {
    const clean = text.toLowerCase().replace(/\s+/g, " ").trim();
    if (clean.length < n) return [clean];
    const result: string[] = [];
    for (let i = 0; i <= clean.length - n; i++) {
        result.push(clean.slice(i, i + n));
    }
    return result;
}

function fnv1a(str: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}

function normalizeL2(vec: Float32Array): void {
    let norm = 0;
    for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm);
    if (norm > 0) {
        for (let i = 0; i < vec.length; i++) vec[i] /= norm;
    }
}

// ─── 相似度计算 ───

/**
 * 余弦相似度 — 范围 [-1, 1]，1=完全相同
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length) {
        log.warn("cosineSimilarity: 向量维度不匹配", { a: a.length, b: b.length });
        return 0;
    }
    if (a.length === 0) return 0;

    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
}

/**
 * 点积 — 范围 (-∞, ∞)。归一化向量下等价余弦但更快。
 */
export function dotProduct(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length) {
        log.warn("dotProduct: 向量维度不匹配", { a: a.length, b: b.length });
        return 0;
    }
    let dot = 0;
    for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
    return dot;
}

/**
 * 欧氏距离（L2） — 范围 [0, ∞)，0=完全相同。
 * 返回负数以保持"越大越相似"的排序约定：similarity = -distance。
 */
export function euclideanSimilarity(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length) {
        log.warn("euclideanSimilarity: 向量维度不匹配", { a: a.length, b: b.length });
        return 0;
    }
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
        const d = a[i] - b[i];
        sum += d * d;
    }
    return -Math.sqrt(sum); // 取负，使 "更近 = 更大的值"
}

/**
 * 曼哈顿距离（L1） — 范围 [0, ∞)，0=完全相同。
 * 返回负数以保持"越大越相似"的排序约定。
 */
export function manhattanSimilarity(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length) {
        log.warn("manhattanSimilarity: 向量维度不匹配", { a: a.length, b: b.length });
        return 0;
    }
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
    return -sum; // 取负
}

/** 相似度计算函数类型 */
export type SimilarityFn = (a: Float32Array, b: Float32Array) => number;

/**
 * 根据配置的度量方法返回对应的相似度函数
 */
export function getSimilarityFn(metric: SimilarityMetric = "cosine"): SimilarityFn {
    switch (metric) {
        case "cosine": return cosineSimilarity;
        case "dot_product": return dotProduct;
        case "euclidean": return euclideanSimilarity;
        case "manhattan": return manhattanSimilarity;
        default:
            log.warn("未知相似度度量，fallback cosine", { metric });
            return cosineSimilarity;
    }
}

/**
 * Top-K 相似度检索（使用指定度量方法）
 */
export function topKSimilar<T extends { id: string; embedding: Float32Array }>(
    queryVec: Float32Array,
    candidates: T[],
    k: number,
    threshold: number = -Infinity,
    metric: SimilarityMetric = "cosine",
): Array<T & { similarity: number }> {
    if (candidates.length === 0 || k <= 0) return [];

    const simFn = getSimilarityFn(metric);
    const scored = candidates
        .map(c => ({ ...c, similarity: simFn(queryVec, c.embedding) }))
        .filter(c => c.similarity >= threshold)
        .sort((a, b) => b.similarity - a.similarity);

    log.debug("topKSimilar", {
        candidates: candidates.length, k, threshold, metric,
        returned: Math.min(scored.length, k),
        topScore: scored[0]?.similarity ?? 0,
    });

    return scored.slice(0, k);
}

// ─── BLOB 转换工具 ───

/**
 * Float32Array 转 Buffer（用于 SQLite BLOB 存储）
 */
export function embeddingToBuffer(embedding: Float32Array): Buffer {
    return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

/**
 * Buffer 转 Float32Array（从 SQLite BLOB 读取）
 */
export function bufferToEmbedding(buf: Buffer): Float32Array {
    const aligned = new ArrayBuffer(buf.length);
    const view = new Uint8Array(aligned);
    view.set(buf);
    return new Float32Array(aligned);
}
