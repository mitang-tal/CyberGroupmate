import type { MemoryStoreV2 } from "../../memory-v2/index.js";

type PolicyMemory = Pick<MemoryStoreV2,
    "policyList" |
    "policyGet" |
    "policyUpsert" |
    "policyRemove" |
    "listGroupModels"
>;

export interface PolicySetInput {
    key: string;
    content: string;
    chatId: string;
    enabled?: boolean;
}

export function createPolicyApi(memory: PolicyMemory) {
    return {
        get: async (key: string, chatId = "meta") => {
            return memory.policyGet(chatId, key);
        },

        list: async (chatId?: string) => {
            const ids = chatId
                ? [chatId]
                : ["meta", ...memory.listGroupModels().map(x => x.chatId)];

            return ids.flatMap(id =>
                memory.policyList(id)
                    .map(item => ({
                        ...item,
                        chatId: id,
                    }))
            );
        },

        set: async (input: PolicySetInput) => {
            return {
                chatId: input.chatId,
                ...memory.policyUpsert(
                    input.chatId,
                    input.key,
                    input.content,
                    input.enabled
                ),
            };
        },

        delete: async (
            key: string,
            chatId = "meta"
        ) => {
            memory.policyRemove(chatId, key);
        },
    };
}