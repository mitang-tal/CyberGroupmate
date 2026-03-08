import type {
    GroupModel,
    IMemoryStoreV2,
    PersonGroupProfile,
    PersonIdentity,
    TopicNode,
} from "../memory-v2/index.js";
import type { Message } from "./types.js";

export interface ContextTarget {
    scene: string;
    chatId: string;
    chatType?: string;
    displayName?: string;
}

export interface ContextAssemblyInput {
    scene: string;
    chatId: string;
    messages: Message[];
    recentContext?: string;
}

export interface ContextAssemblyResult {
    sceneFocusBlock: string;
    latentMemoryBlock: string;
}

function unique<T>(items: T[]): T[] {
    return Array.from(new Set(items));
}

function shorten(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text;
    return `${text.slice(0, Math.max(0, maxLen - 1))}…`;
}

function formatIdentity(identity: PersonIdentity | null): string | null {
    if (!identity) return null;
    const aliases = identity.aliases.filter(Boolean).slice(0, 5);
    if (aliases.length === 0) return `${identity.displayName} (user:${identity.userId})`;
    return `${identity.displayName} (user:${identity.userId}, aliases:${aliases.join("/")})`;
}

function formatProfile(profile: PersonGroupProfile | undefined): string | null {
    if (!profile) return null;
    const parts: string[] = [];
    parts.push(`tier=${profile.dunbarTier}`);
    if (profile.relationToAgent) parts.push(`relation=${profile.relationToAgent}`);
    if (profile.communicationStyle) parts.push(`style=${profile.communicationStyle}`);
    if (profile.traits.length > 0) parts.push(`traits=${profile.traits.slice(0, 4).join("/")}`);
    if (profile.interests.length > 0) parts.push(`interests=${profile.interests.slice(0, 4).join("/")}`);
    return parts.join("; ");
}

function formatGroupModel(model: GroupModel | null): string | null {
    if (!model) return null;
    const parts: string[] = [];
    if (model.chatTitle) parts.push(`title=${model.chatTitle}`);
    if (model.description) parts.push(`desc=${shorten(model.description, 120)}`);
    if (model.agentRole) parts.push(`agentRole=${model.agentRole}`);
    parts.push(`engagement=${model.engagementLevel}`);
    if (model.communicationNorms.length > 0) parts.push(`norms=${model.communicationNorms.slice(0, 3).join("/")}`);
    if (model.hotTopics.length > 0) parts.push(`hot=${model.hotTopics.slice(0, 4).join("/")}`);
    if (model.recentFeedback) parts.push(`feedback=${shorten(model.recentFeedback, 120)}`);
    return parts.join("; ");
}

function formatTopics(topics: TopicNode[]): string | null {
    if (topics.length === 0) return null;
    return topics
        .slice(0, 3)
        .map(topic => topic.label)
        .filter(Boolean)
        .join(" / ");
}

function formatRecentMessages(messages: Message[]): string[] {
    return messages.slice(-3).map(message => {
        const platform = message.platform ?? message.scene ?? "unknown";
        const chatType = message.chatType ?? (message.isDirectMessage ? "private" : "chat");
        return `- [${platform}/${chatType}] ${message.senderName}: ${message.text}`;
    });
}

export class ContextAssembler {
    constructor(private memory: Pick<IMemoryStoreV2,
        "getGroupModel" | "getPersonIdentity" | "getProfilesForChat" | "getTopicsSince">) {}

    assemble(input: ContextAssemblyInput): ContextAssemblyResult {
        const latestMessage = input.messages[input.messages.length - 1];
        const targetName = latestMessage?.senderName ?? "未知对象";
        const chatType = latestMessage?.chatType ?? (latestMessage?.isDirectMessage ? "private" : undefined);

        const profileList = typeof this.memory.getProfilesForChat === "function"
            ? this.memory.getProfilesForChat(input.chatId)
            : [];
        const relevantUserIds = unique(input.messages.map(msg => msg.senderId).filter(Boolean));
        const identities = relevantUserIds
            .map(userId => typeof this.memory.getPersonIdentity === "function"
                ? this.memory.getPersonIdentity(userId)
                : null)
            .filter((identity): identity is PersonIdentity => Boolean(identity));
        const relevantProfiles = relevantUserIds
            .map(userId => profileList.find(profile => profile.userId === userId))
            .filter((profile): profile is PersonGroupProfile => Boolean(profile));
        const groupModel = typeof this.memory.getGroupModel === "function"
            ? this.memory.getGroupModel(input.chatId)
            : null;
        const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const recentTopics = typeof this.memory.getTopicsSince === "function"
            ? this.memory.getTopicsSince(input.chatId, since)
            : [];

        const focusLines = [
            "[Scene Focus]",
            `scene=${input.scene} chat=${input.chatId}${chatType ? ` type=${chatType}` : ""} target=${targetName}`,
            ...formatRecentMessages(input.messages).length > 0
                ? ["recent:", ...formatRecentMessages(input.messages)]
                : [],
        ];

        const latentLines = [
            "[Latent Memory]",
            ...(identities.length > 0
                ? [`identities=${identities.map(formatIdentity).filter(Boolean).join(" | ")}`]
                : []),
            ...(relevantProfiles.length > 0
                ? [`profiles=${relevantProfiles.map(formatProfile).filter(Boolean).join(" | ")}`]
                : []),
            ...(groupModel ? [`group=${formatGroupModel(groupModel)}`] : []),
            ...(recentTopics.length > 0 ? [`recentTopics=${formatTopics(recentTopics)}`] : []),
            ...(input.recentContext ? [`recentContext=${shorten(input.recentContext, 200)}`] : []),
        ];

        return {
            sceneFocusBlock: focusLines.join("\n"),
            latentMemoryBlock: latentLines.length > 1 ? latentLines.join("\n") : "[Latent Memory]\n（暂无可用潜意识上下文）",
        };
    }
}
