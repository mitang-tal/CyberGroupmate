/**
 * TTLQueryCache — 通用 TTL 查询缓存
 *
 * 供 FailureExtractor.queryRelevantExperience 与 SimulationEngine 共用，
 * 避免 Dispatch / Replan / 推演等热路径重复查库。
 */

interface CacheEntry {
    value: unknown;
    expiresAt: number;
}

export class TTLQueryCache {
    private store = new Map<string, CacheEntry>();
    private ttlMs: number;
    private hits = 0;
    private misses = 0;

    constructor(ttlMs = 5_000) {
        this.ttlMs = ttlMs;
    }

    get<T>(key: string): T | undefined {
        const entry = this.store.get(key);
        if (!entry) {
            this.misses += 1;
            return undefined;
        }
        if (entry.expiresAt < Date.now()) {
            this.store.delete(key);
            this.misses += 1;
            return undefined;
        }
        this.hits += 1;
        // 浅拷贝，避免调用方 mutate 污染缓存结果
        return Array.isArray(entry.value) ? ([...entry.value] as T) : (entry.value as T);
    }

    set(key: string, value: unknown): void {
        this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    }

    invalidate(key?: string): void {
        if (key) {
            this.store.delete(key);
        } else {
            this.store.clear();
        }
    }

    stats(): { hits: number; misses: number; size: number } {
        return { hits: this.hits, misses: this.misses, size: this.store.size };
    }
}