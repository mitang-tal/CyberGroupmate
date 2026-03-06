/**
 * memory-v2/index.ts — Memory V2 模块统一导出
 *
 * 重新导出 MemoryStoreV2 类和所有相关类型。
 * 消费者只需 import { MemoryStoreV2 } from "./memory-v2/index.js" 即可。
 */

export { MemoryStoreV2 } from "./memory-v2.js";
export { runReflection, parseReflectionJSON, mergeEpisodes, trimProfileByTier, DEFAULT_TIER_LIMITS, type ReflectionConfig, type TierLimitEntry, type TierLimitsConfig } from "./reflection.js";

export type {
    // V2 核心类型
    IMemoryStoreV2,
    TopicNode,
    PersonIdentity,
    PersonGroupProfile,
    InteractionEpisode,
    MergedMemory,
    GroupModel,
    CoreFact,
    FactCategory,
    MessageLogEntry,
    RecallOptions,
    RecallResult,
    HistoryBrowseRequest,
    HistoryBrowseResult,
    ReflectionResult,
} from "./types.js";
