/**
 * memory — Meta 跨群实体检索 API。
 *
 * 用于检索人物身份、画像、事实、近期话题和历史 session digest。适合在跨群转述或派发前查证不确定事实。
 */

type MetaFactCategory =
    | "identity"
    | "preference"
    | "relationship"
    | "event"
    | "topic"
    | "skill"
    | "boundary"
    | "other";

interface MemorySearchEntitiesOptions {
    /** 限定群组。 */
    chatId?: string;
    /** ISO 时间下限。 */
    after?: string;
    /** ISO 时间上限。 */
    before?: string;
    /** 事实分类过滤。 */
    categories?: MetaFactCategory[];
    /** 默认 10，最大 50。 */
    limit?: number;
}

interface MemoryIdentityMatch {
    identity: {
        userId: string;
        aliases: string[];
        displayName: string;
        username?: string;
    };
    profile: {
        recentFacts?: unknown[];
        dunbarTier?: number;
    };
}

interface MemorySearchEntitiesResult {
    identities: MemoryIdentityMatch[];
    recentSessions: Array<{
        topicId: string;
        chatId: string;
        label: string;
        summary: string;
        keywords: string[];
        participants: string[];
    }>;
    sessionDigests: Array<{ createdAt: string; content: string }>;
    coreFacts: Array<{
        factId: string;
        subject: string;
        content: string;
        category: MetaFactCategory;
        updatedAt: string;
        sourceChatId?: string;
        sourceChatTitle?: string;
        sourceTopicLabel?: string;
        observedAt?: string;
        visibility?: "private" | "contextual" | "public";
        sensitivity?: "low" | "medium" | "high";
    }>;
    topicKeywords: string[];
}

declare const memory: {
    /**
     * 跨群检索实体、事实、话题和历史 session 摘要。
     *
     * 不确定的最新事实先用此方法或 conversations.query() 查证，再做派发决策。
     *
     * @param query 人名、别名、关键词或事实线索。
     * @param options 可选的群组、时间、分类和数量过滤。
     * @returns 与 query 相关的身份、话题、session digest、事实和关键词。
     * @example
     * const result = await memory.searchEntities("团建", { limit: 5 });
     * console.log(JSON.stringify(result.coreFacts, null, 2));
     */
    searchEntities(query: string, options?: MemorySearchEntitiesOptions): Promise<MemorySearchEntitiesResult>;
};
