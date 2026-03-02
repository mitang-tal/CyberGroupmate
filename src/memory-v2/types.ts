/**
 * memory-v2/types.ts — Memory V2 类型定义
 *
 * 定义三层记忆模型所需的全部 TypeScript 接口。
 * 参考设计文档 memory.md。
 *
 * 在整体架构中的位置：
 * - 被 MemoryStoreV2 实现类使用
 * - 被 compaction.ts、main.ts、cli.ts 等消费者导入
 * - 场景类型定义 scenes/memory.d.ts 的实际对应类型
 */

// ─── 事实分类 ───

/** 核心事实的分类枚举 */
export type FactCategory =
    | "biographical"    // 个人信息（"alice 是前端程序员"）
    | "preference"      // 喜好（"bob 喜欢抹茶拿铁"）
    | "anecdote"        // 趣事/黑历史（永不过期、永不在合并中删除）
    | "opinion"         // 观点（"alice 觉得 Rust 比 Go 好"）
    | "plan"            // 计划（"alice 下周去东京"，带 expires_at）
    | "relationship"    // 人际关系（"alice 和 bob 是同事"）
    | "general";        // 通用事实

// ─── 话题节点 ───

/** 话题节点 — 中期记忆的核心数据结构 */
export interface TopicNode {
    /** UUID v4 */
    id: string;
    /** 所属群组 */
    chatId: string;
    /** 话题标签（如 "新番推荐"） */
    label: string;
    /** 话题摘要（1-3句话） */
    summary: string;
    /** 关键要点 */
    keyPoints: string[];
    /** 参与者 userId 列表 */
    participants: string[];
    /** 原始消息范围 */
    messageRange: {
        firstMessageId: number;
        lastMessageId: number;
        count: number;
    };
    /** 话题开始时间 (ISO 8601) */
    startedAt: string;
    /** 话题结束时间（null=仍在进行） */
    endedAt: string | null;
    /** 情感倾向 */
    sentiment: "positive" | "neutral" | "negative" | "mixed";
    /** 关联话题 ID 列表 */
    relatedTopicIds: string[];
    /** 自动提取的标签 */
    tags: string[];
    /** 向量表示（语义检索用） */
    embedding?: Float32Array;
    /** 创建时间 (ISO 8601) */
    createdAt: string;
    /** 更新时间 (ISO 8601) */
    updatedAt: string;
}

// ─── 个体画像：双层模型 ───

/** 个体身份（全局，跨群共享） */
export interface PersonIdentity {
    /** 主键（Telegram userId） */
    userId: string;
    /** 最常用的名字 */
    displayName: string;
    /** 所有已知昵称/曾用名 */
    aliases: string[];
    /** 跨群总消息数 */
    totalMessageCount: number;
    /** 最后出现时间 (ISO 8601) */
    lastSeenAt: string;
    /** 首次出现时间 (ISO 8601) */
    firstSeenAt: string;
    /** 更新时间 (ISO 8601) */
    updatedAt: string;
}

/** 个体群内画像（每群独立） */
export interface PersonGroupProfile {
    /** 用户 ID（联合主键） */
    userId: string;
    /** 群组 ID（联合主键） */
    chatId: string;
    /** 邓巴分层 1=核心<=15, 2=熟悉<=50, 3=认识<=150, 4=陌生 */
    dunbarTier: 1 | 2 | 3 | 4;
    /** LLM 给出的分层理由 */
    dunbarReason: string;
    /** 在这个群的性格表现 */
    traits: string[];
    /** 在这个群的兴趣话题 */
    interests: string[];
    /** 在这个群的说话风格 */
    communicationStyle: string;
    /** 在这个群与 agent 的关系描述 */
    relationToAgent: string;
    /** 近 7 天的详细交互 */
    recentEpisodes: InteractionEpisode[];
    /** 更早的合并后记忆 */
    mergedMemory: MergedMemory[];
    /** 此群的消息数 */
    messageCount: number;
    /** 最后出现时间 (ISO 8601) */
    lastSeenAt: string;
    /** 活跃时段分布（0-23） */
    activeHours: number[];
    /** 首次出现时间 (ISO 8601) */
    firstSeenAt: string;
    /** 更新时间 (ISO 8601) */
    updatedAt: string;
}

/** 近期的详细交互记录（7 天内保留） */
export interface InteractionEpisode {
    /** UUID v4 */
    id: string;
    /** ISO date */
    date: string;
    /** 关联话题 */
    topicId: string | null;
    /** 交互类型 */
    type: "agent_replied" | "agent_mentioned" | "direct_message" | "reaction";
    /** 详细描述 */
    summary: string;
    /** 情感倾向 */
    sentiment: "positive" | "neutral" | "negative";
    /** 重要程度 0-1 */
    significance: number;
}

/** 合并后的记忆（周/月/季度/年粒度） */
export interface MergedMemory {
    /** 时期开始 */
    periodStart: string;
    /** 时期结束 */
    periodEnd: string;
    /** 粒度级别 */
    granularity: "week" | "month" | "quarter" | "year";
    /** 整体情感倾向 */
    overallSentiment: "positive" | "neutral" | "negative" | "mixed";
    /** 该时期的交互次数 */
    interactionCount: number;
    /** 只保留重要事件（significance > 0.7）的摘要 */
    highlights: string[];
    /** 关系变化描述 */
    relationshipTrend: string;
}

// ─── 群组画像 ───

/** 群组画像 */
export interface GroupModel {
    /** 主键 */
    chatId: string;
    /** 群组标题 */
    chatTitle: string;
    /** 群组描述/定位 */
    description: string;
    /** 主要语言 */
    dominantLanguage: string;
    /** 交流规范 */
    communicationNorms: string[];
    /** 活跃成员数 */
    activeMembers: number;
    /** 日均消息量 */
    avgMessagesPerDay: number;
    /** 活跃高峰时段 */
    peakHours: number[];
    /** agent 在群中扮演的角色 */
    agentRole: string;
    /** 参与度级别 */
    engagementLevel: "high" | "medium" | "low";
    /** 最近收到的反馈总结 */
    recentFeedback: string;
    /** 近期热门话题 */
    hotTopics: string[];
    /** 不宜讨论的话题 */
    tabooTopics: string[];
    /** 上次反思时间 (ISO 8601) */
    lastReflectedAt: string | null;
    /** 更新时间 (ISO 8601) */
    updatedAt: string;
}

// ─── 核心事实 ───

/** 核心事实（长期记忆，跨群共享） */
export interface CoreFact {
    /** UUID v4 */
    id: string;
    /** userId / chatId / 通用主题 */
    subject: string;
    /** 事实内容 */
    content: string;
    /** 分类 */
    category: FactCategory;
    /** 置信度 0-1 */
    confidence: number;
    /** 来源（topic_id 或 interaction_id） */
    source: string | null;
    /** 向量表示 */
    embedding?: Float32Array;
    /** 创建时间 (ISO 8601) */
    createdAt: string;
    /** 更新时间 (ISO 8601) */
    updatedAt: string;
    /** 时效性事实的过期时间 */
    expiresAt: string | null;
}

// ─── recall() 检索接口 ───

/** recall() 的查询选项 */
export interface RecallOptions {
    /** 限定群组 */
    chatId?: string;
    /** 限定用户 */
    userId?: string;
    /** 时间范围（天） */
    daysBack?: number;
    /** 最大结果数 */
    maxResults?: number;
    /** 按事实类别过滤 */
    categories?: FactCategory[];
    /** 结果 token 超过此值时启用 cheap model 深度总结 */
    deepRecallThreshold?: number;
}

/** recall() 的返回结果 */
export interface RecallResult {
    /** 匹配的话题节点 */
    topics: TopicNode[];
    /** 匹配的核心事实 */
    facts: Array<{
        content: string;
        category: FactCategory;
        subject: string;
        confidence: number;
    }>;
    /** 匹配的个体画像 */
    persons: PersonGroupProfile[];
    /** 如果触发了深度总结，包含 cheap model 综合摘要 */
    deepSummary?: string;
}

// ─── browseHistory() 消息档案接口 ───

/** 消息档案检索请求 */
export interface HistoryBrowseRequest {
    /** 自然语言描述的搜索意图（支持模糊） */
    intent: string;
    /** 搜索提示（可选，缩小范围） */
    hints?: {
        chatId?: string;
        userId?: string;
        topicLabel?: string;
        topicId?: string;
        hoursBack?: number;
        daysBack?: number;
    };
    /** 上下文窗口大小（命中消息前后各多少条），默认 10 */
    contextWindow?: number;
    /** 最大结果数，默认 3 */
    maxSegments?: number;
}

/** 消息档案检索结果 */
export interface HistoryBrowseResult {
    /** cheap model 生成的针对性回答 */
    answer: string;
    /** 定位到的消息段落 */
    segments: Array<{
        topicLabel: string;
        timeRange: { from: string; to: string };
        messages: Array<{
            messageId: number;
            userId: string;
            displayName: string;
            text: string;
            timestamp: string;
        }>;
        relevanceScore: number;
    }>;
    /** 总共阅读了多少条消息 */
    messagesRead: number;
}

// ─── reflect() 反思接口 ───

/** reflect() 的返回结果 */
export interface ReflectionResult {
    reflectedPeriod: { from: string; to: string };
    topicsSummary: Array<{
        label: string;
        summary: string;
        participants: string[];
        sentiment: string;
    }>;
    personUpdates: Array<{
        userId: string;
        chatId: string;
        changes: string;
    }>;
    groupUpdates: string;
    newCoreFacts: string[];
    mergedEpisodes: number;
    insights: string;
}

// ─── 旧接口兼容类型 ───

/** 通用记忆条目（V1 兼容） */
export interface MemoryEntry {
    /** 记忆 ID (ULID) */
    id: string;
    /** 记忆内容 */
    content: string;
    /** 元数据 */
    metadata: Record<string, unknown>;
    /** 时间戳 (ISO 8601) */
    timestamp: string;
}

/** 群友画像（V1 兼容） */
export interface PersonProfile {
    /** 用户 ID */
    userId: string;
    /** 显示名称 */
    displayName?: string;
    /** 笔记/备注 */
    notes?: string;
    /** 个性特征标签 */
    traits?: string[];
    /** 最后交互时间 (ISO 8601) */
    lastInteraction?: string;
    /** 其他自定义字段 */
    [key: string]: unknown;
}

/** 对话摘要（V1 兼容） */
export interface ConversationSummary {
    /** 摘要 ID (ULID) */
    id: string;
    /** 聊天 ID */
    chatId: string;
    /** 聊天标题 */
    chatTitle: string;
    /** 对话摘要文本 */
    summary: string;
    /** 关键要点 */
    keyPoints: string[];
    /** 时间戳 (ISO 8601) */
    timestamp: string;
}

/** 待办事项（V1 兼容） */
export interface TodoItem {
    /** 待办 ID (ULID) */
    id: string;
    /** 描述 */
    description: string;
    /** 创建时间 (ISO 8601) */
    createdAt: string;
    /** 截止日期 (ISO 8601, 可选) */
    dueDate?: string;
    /** 是否已完成 */
    done: boolean;
}

// ─── MemoryStoreV2 接口 ───

/**
 * MemoryStoreV2 — Memory V2 接口
 *
 * 包含旧接口的全部方法（V1 向后兼容）和新的 V2 方法。
 * 当前为占位实现（读空+写弃），后续接入真实数据层。
 */
export interface IMemoryStoreV2 {
    // ─── V1 兼容方法 ───

    /** 搜索记忆（全文搜索 + CJK 子串匹配） */
    search(query: string, limit?: number): MemoryEntry[];

    /** 存入一条记忆 */
    store(content: string, metadata?: Record<string, unknown>): string;

    /** 获取群友画像 */
    getPerson(userId: string): PersonProfile | null;

    /** 更新群友画像（merge 模式） */
    updatePerson(userId: string, updates: Partial<PersonProfile>): void;

    /** 获取最近的对话摘要 */
    getRecentConversations(chatId?: string, limit?: number): ConversationSummary[];

    /** 存入对话摘要 */
    storeConversation(summary: Omit<ConversationSummary, "id" | "timestamp">): string;

    /** 获取待办事项 */
    getPendingTasks(includeCompleted?: boolean): TodoItem[];

    /** 添加待办事项 */
    addTodo(description: string, dueDate?: string): string;

    /** 直接执行 SQL 查询 */
    rawQuery(sql: string, ...params: unknown[]): unknown;

    /** 关闭数据库连接 */
    close(): void;

    // ─── V2 新方法 ───

    /**
     * 统一记忆检索入口
     * 使用向量搜索 + 关键词搜索混合检索
     */
    recall(query: string, options?: RecallOptions): Promise<RecallResult>;

    /**
     * 消息档案检索
     * 话题索引引导 + 模糊搜索 + 上下文窗口 + cheap model 深度阅读
     */
    browseHistory(request: HistoryBrowseRequest): Promise<HistoryBrowseResult>;

    /**
     * 对指定群组进行反思总结
     * 读取上次反思以来的 topics 和 interactions，生成结构化总结
     */
    reflect(chatId: string): Promise<ReflectionResult>;

    /**
     * 更新某人在某群的画像
     */
    updatePersonProfile(userId: string, chatId: string): Promise<{
        before: Partial<PersonGroupProfile>;
        after: Partial<PersonGroupProfile>;
        changes: string;
    }>;
}
