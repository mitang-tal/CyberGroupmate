/**
 * conversations — Meta 跨群检索 API。
 *
 * 用于在 MetaSandbox 中检索所有聊天的消息和话题。读权限无界限；结果带 chatLabel，方便输出给模型继续决策。
 */

interface ConversationsQueryFilters {
    /** 限定群组 ID；空则搜索全部可见群。 */
    chatIds?: string[];
    /** 人名、别名、username 或 userId，会先解析已知身份。 */
    user?: string;
    /** 精确限定发言者 ID，如 "telegram:123456"。 */
    userId?: string;
    /** 正文关键词；无 user 或 user 未解析时会先匹配 displayName，再匹配正文。 */
    keyword?: string;
    /** ISO 时间下限。 */
    after?: string;
    /** ISO 时间上限。 */
    before?: string;
    /** 结果数上限，默认 20，最大 100。 */
    limit?: number;
}

interface ConversationMessageResult {
    messageId: string;
    chatId: string;
    chatTitle: string;
    /** 形如 "[群名(telegram:-100123)]"，打印时可直接使用。 */
    chatLabel: string;
    userId: string;
    displayName: string;
    content: string;
    timestamp: string;
}

interface ConversationTopicResult {
    topicId: string;
    chatId: string;
    chatTitle: string;
    /** 形如 "[群名(telegram:-100123)]"，打印时可直接使用。 */
    chatLabel: string;
    label: string;
    summary: string;
    keywords: string[];
    participants: string[];
    startedAt: string;
    endedAt?: string | null;
    sentiment?: string;
    callbackPotential?: number;
}

interface ResolvedConversationUser {
    userId: string;
    displayName: string;
    username?: string;
    aliases: string[];
}

interface ConversationsQueryResult {
    messages: ConversationMessageResult[];
    topics: ConversationTopicResult[];
    resolvedUsers: ResolvedConversationUser[];
}

declare const conversations: {
    /**
     * 跨群检索消息与话题。
     *
     * chatLabel 已格式化为 "[群名(compositeId)]"，打印时直接使用它，例如 `${m.chatLabel} ${m.displayName}: ${m.content}`。
     *
     * @param filters 检索条件；不传 chatIds 时搜索全部可见群。
     * @returns 匹配的消息、话题和解析出的用户身份。
     * @example
     * const conv = await conversations.query({
     *   chatIds: ["telegram:-1001234567890"],
     *   keyword: "API 网关 技术方案",
     *   limit: 10
     * });
     * console.log("messages:", conv.messages.length, "topics:", conv.topics.length);
     */
    query(filters?: ConversationsQueryFilters): Promise<ConversationsQueryResult>;
};
