import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ContextAssembler } from "../src/pipeline/context-assembler.js";
import type { Message } from "../src/pipeline/types.js";

describe("ContextAssembler", () => {
    it("should assemble scene focus and latent memory for a target chat", () => {
        const assembler = new ContextAssembler({
            getGroupModel: () => ({
                chatId: "682932098",
                chatTitle: "莫思奇多私聊",
                description: "偏技术、直接交流",
                dominantLanguage: "zh",
                communicationNorms: ["直接", "少废话"],
                activeMembers: 1,
                avgMessagesPerDay: 5,
                peakHours: [9, 10],
                agentRole: "技术搭子",
                engagementLevel: "high",
                recentFeedback: "最近主动来找你聊天",
                hotTopics: ["agent", "Telegram"],
                tabooTopics: [],
                lastReflectedAt: null,
                updatedAt: new Date().toISOString(),
            }),
            getPersonIdentity: () => ({
                userId: "682932098",
                displayName: "莫思奇多",
                aliases: ["mozzie"],
                totalMessageCount: 20,
                lastSeenAt: new Date().toISOString(),
                firstSeenAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            }),
            getProfilesForChat: () => [{
                userId: "682932098",
                chatId: "682932098",
                dunbarTier: 2,
                dunbarReason: "高频互动",
                traits: ["直接", "技术向"],
                interests: ["agent", "系统设计"],
                communicationStyle: "简洁直接",
                relationToAgent: "熟人",
                recentEpisodes: [],
                mergedMemory: [],
                messageCount: 10,
                lastSeenAt: new Date().toISOString(),
                activeHours: [9],
                firstSeenAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            }],
            getTopicsSince: () => [{
                id: "t1",
                chatId: "682932098",
                label: "Phase 6",
                summary: "",
                keyPoints: [],
                participants: ["682932098"],
                messageRange: { messageIds: ["m1"], count: 1 },
                startedAt: new Date().toISOString(),
                endedAt: null,
                sentiment: "neutral",
                relatedTopicIds: [],
                keywords: ["phase6"],
                wasEngaged: true,
                interventionCount: 1,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            }],
        });

        const messages: Message[] = [{
            id: "1354",
            chatId: "682932098",
            senderId: "682932098",
            senderName: "莫思奇多",
            text: "在吗在吗",
            timestamp: Date.now(),
            scene: "telegram",
            platform: "telegram",
            chatType: "private",
            isDirectMessage: true,
        }];

        const result = assembler.assemble({
            scene: "telegram",
            chatId: "682932098",
            messages,
            recentContext: "用户最近在追问 Phase 6 的架构细节",
        });

        assert.ok(result.sceneFocusBlock.includes("[Scene Focus]"));
        assert.ok(result.sceneFocusBlock.includes("scene=telegram chat=682932098 type=private target=莫思奇多"));
        assert.ok(result.latentMemoryBlock.includes("identities=莫思奇多 (user:682932098, aliases:mozzie)"));
        assert.ok(result.latentMemoryBlock.includes("profiles=tier=2"));
        assert.ok(result.latentMemoryBlock.includes("group=title=莫思奇多私聊"));
        assert.ok(result.latentMemoryBlock.includes("recentTopics=Phase 6"));
    });
});
