/**
 * policy - Meta agent behavior rules API.
 *
 * Used to store persistent agent behavior policies.
 * Policies affect decision making and response behavior.
 * chatId can be a composite chat id or "meta".
 */

interface MetaPolicySetInput {
    key: string;
    content: string;
    chatId: string;
    enabled?: boolean;
}

interface MetaPolicyItem {
    chatId: string;
    key: string;
    content: string;
    enabled: boolean;
    createdAt: string;
    updatedAt: string;
}

declare const policy: {
    /**
     * Create or update an agent policy.
     *
     * @param input Policy key, content and target chatId.
     */
    set(input: MetaPolicySetInput): Promise<MetaPolicyItem>;

    /**
     * Get one policy by key.
     */
    get(key: string, chatId?: string): Promise<Omit<MetaPolicyItem, "chatId"> | null>;

    /**
     * List policies.
     *
     * Without chatId, returns meta policies and group policies.
     */
    list(chatId?: string): Promise<MetaPolicyItem[]>;

    /**
     * Delete a policy.
     */
    delete(key: string, chatId?: string): Promise<void>;
};