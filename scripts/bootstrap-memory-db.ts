#!/usr/bin/env npx tsx
/**
 * scripts/bootstrap-memory-db.ts — 生成 Memory V2 测试数据库
 *
 * 用途：为 dry-run / 手动测试 生成一个预填充的 memory.db。
 * 包含 topics / core_facts / message_log / person 数据 + embedding。
 *
 * 使用方法：
 *   npx tsx scripts/bootstrap-memory-db.ts [output-path]
 *   # 默认输出到 workspace/bootstrap-memory.db
 */

import { mkdirSync, existsSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { MemoryStoreV2 } from "../src/memory-v2/memory-v2.js";
import { localEmbed } from "../src/memory-v2/embedding.js";

const DEFAULT_PATH = "workspace/bootstrap-memory.db";
const dbPath = process.argv[2] || DEFAULT_PATH;

// 确保目录存在
mkdirSync(dirname(dbPath), { recursive: true });
if (existsSync(dbPath)) {
    rmSync(dbPath, { force: true });
    console.log(`已删除旧数据库: ${dbPath}`);
}

const memory = new MemoryStoreV2(dbPath);

console.log(`\nsqlite-vec 状态: ${memory.sqliteVecAvailable ? "✅ 可用" : "❌ 不可用（使用纯 JS fallback）"}`);

// ─── 1. 话题（Topics）───

const topics = [
    {
        id: "topic_kyoto",
        chatId: "-100123456",
        label: "京都岚山旅行攻略",
        summary: "alice 想去岚山，讨论了从大阪到岚山的交通方式（阪急转岚电约50分钟），bob 推荐了秋天红叶季，carol 问竹林人少的时间段",
        keyPoints: ["阪急转岚电约50分钟", "关西周游券可用阪急", "竹林早上人少推荐"],
        keywords: ["京都", "岚山", "交通", "红叶"],
        participants: ["111", "222", "333"],
        wasEngaged: true,
        interventionCount: 2,
    },
    {
        id: "topic_anime",
        chatId: "-100123456",
        label: "新番动漫讨论",
        summary: "alice 问新番推荐，Agent 推荐了《变人》，bob 补充了《葬送的芙莉莲》第二季近况",
        keyPoints: ["《变人》治愈系推荐", "芙莉莲第二季即将更新"],
        keywords: ["新番", "动漫", "治愈系"],
        participants: ["111", "222"],
        wasEngaged: true,
        interventionCount: 1,
    },
    {
        id: "topic_programming",
        chatId: "-100123456",
        label: "Rust vs Go 编程语言之争",
        summary: "charlie 和 dave 激烈讨论 Rust 和 Go 各自的优劣，alice 觉得 Rust 的学习曲线太高",
        keyPoints: ["Rust 内存安全优势", "Go 部署简单", "alice 觉得 Rust 难学"],
        keywords: ["Rust", "Go", "编程语言"],
        participants: ["333", "444", "111"],
        wasEngaged: false,
    },
    {
        id: "topic_food",
        chatId: "-100789012",
        label: "大阪美食推荐",
        summary: "bob 推荐了道顿堀的章鱼烧和一风堂拉面，carol 分享了抹茶甜品店",
        keyPoints: ["道顿堀章鱼烧", "一风堂拉面", "中村藤吉抹茶"],
        keywords: ["大阪", "美食", "章鱼烧", "拉面"],
        participants: ["222", "333"],
        wasEngaged: false,
    },
    {
        id: "topic_game",
        chatId: "-100789012",
        label: "Steam 冬季促销讨论",
        summary: "dave 分享了促销清单，charlie 买了《黑神话悟空》，alice 推荐了《空洞骑士》",
        keyPoints: ["《黑神话悟空》好评", "《空洞骑士》2D佳作"],
        keywords: ["Steam", "游戏", "促销"],
        participants: ["444", "333", "111"],
        wasEngaged: true,
        interventionCount: 1,
    },
];

console.log("\n📝 写入话题...");
for (const t of topics) {
    const embText = `${t.label} ${t.summary} ${t.keywords.join(" ")}`;
    memory.upsertTopic(t.id, {
        chatId: t.chatId,
        label: t.label,
        summary: t.summary,
        keyPoints: t.keyPoints,
        keywords: t.keywords,
        participants: t.participants,
        wasEngaged: t.wasEngaged ?? false,
        interventionCount: t.interventionCount ?? 0,
        embedding: localEmbed(embText),
    });
    console.log(`  ✔ ${t.label}`);
}

// ─── 2. 核心事实（Core Facts）───

const facts = [
    { subject: "111", content: "alice 是前端程序员", category: "biographical" as const },
    { subject: "111", content: "alice 喜欢治愈系动漫", category: "preference" as const },
    { subject: "111", content: "alice 觉得 Rust 比 Go 的学习曲线高", category: "opinion" as const },
    { subject: "111", content: "alice 下周去东京旅行", category: "plan" as const, expiresAt: "2026-04-01T00:00:00.000Z" },
    { subject: "222", content: "bob 喜欢吃拉面和章鱼烧", category: "preference" as const },
    { subject: "222", content: "bob 去过京都岚山，推荐秋天红叶", category: "biographical" as const },
    { subject: "333", content: "carol 喜欢猫咪和抹茶甜品", category: "preference" as const },
    { subject: "333", content: "carol 把测试数据推到 prod 炸了整个服务", category: "anecdote" as const },
    { subject: "444", content: "dave 是后端程序员，擅长 Go 语言", category: "biographical" as const },
    { subject: "444", content: "dave 买了《黑神话悟空》", category: "plan" as const },
    { subject: "-100123456", content: "这个群主要讨论技术和旅行", category: "general" as const },
    { subject: "-100789012", content: "这个群主要讨论美食和游戏", category: "general" as const },
];

console.log("\n📌 写入核心事实...");
for (const f of facts) {
    memory.storeFact(f.subject, f.content, f.category, undefined, (f as any).expiresAt, localEmbed(f.content));
    console.log(`  ✔ [${f.category}] ${f.content}`);
}

// ─── 3. 消息日志（Message Log）───

const messages = [
    { messageId: 501, chatId: "-100123456", userId: "111", displayName: "alice", text: "有人去过京都岚山吗", timestamp: "2026-03-05T14:00:00Z" },
    { messageId: 502, chatId: "-100123456", userId: "222", displayName: "bob", text: "去过，秋天红叶超美", timestamp: "2026-03-05T14:01:00Z" },
    { messageId: 503, chatId: "-100123456", userId: "333", displayName: "carol", text: "从大阪过去要多久啊", timestamp: "2026-03-05T14:02:00Z" },
    { messageId: 504, chatId: "-100123456", userId: "111", displayName: "alice", text: "对，交通是不是很复杂", timestamp: "2026-03-05T14:03:00Z" },
    { messageId: 505, chatId: "-100123456", userId: "agent", displayName: "CyberGroupmate", text: "坐阪急到桂站转岚电最快，大概50分钟", timestamp: "2026-03-05T14:18:00Z" },
    { messageId: 506, chatId: "-100123456", userId: "111", displayName: "alice", text: "哦哦谢谢！", timestamp: "2026-03-05T14:19:00Z" },
    { messageId: 507, chatId: "-100123456", userId: "333", displayName: "carol", text: "竹林早上去 get✓", timestamp: "2026-03-05T14:20:00Z" },
    { messageId: 601, chatId: "-100789012", userId: "222", displayName: "bob", text: "道顿堀的章鱼烧真的好吃", timestamp: "2026-03-05T15:00:00Z" },
    { messageId: 602, chatId: "-100789012", userId: "333", displayName: "carol", text: "我更喜欢中村藤吉的抹茶", timestamp: "2026-03-05T15:01:00Z" },
    { messageId: 603, chatId: "-100789012", userId: "222", displayName: "bob", text: "一风堂拉面也不错", timestamp: "2026-03-05T15:02:00Z" },
];

console.log("\n💬 写入消息日志...");
memory.storeMessageBatch(messages);
console.log(`  ✔ ${messages.length} 条消息`);

// ─── 4. 人物（Person）───

const persons = [
    { userId: "111", displayName: "alice", aliases: ["Alice", "爱丽丝"] },
    { userId: "222", displayName: "bob", aliases: ["Bob", "鲍勃"] },
    { userId: "333", displayName: "carol", aliases: ["Carol"] },
    { userId: "444", displayName: "dave", aliases: ["Dave"] },
];

console.log("\n👤 写入人物身份...");
for (const p of persons) {
    memory.upsertPersonIdentity(p.userId, {
        displayName: p.displayName,
        aliases: p.aliases,
        totalMessageCount: messages.filter(m => m.userId === p.userId).length,
    });
    console.log(`  ✔ ${p.displayName} (${p.userId})`);
}

const profiles = [
    { userId: "111", chatId: "-100123456", dunbarTier: 2, traits: ["友善", "好奇心强"], interests: ["旅行", "动漫", "前端开发"] },
    { userId: "222", chatId: "-100123456", dunbarTier: 3, traits: ["知识丰富", "乐于分享"], interests: ["旅行", "美食"] },
    { userId: "333", chatId: "-100123456", dunbarTier: 3, traits: ["爱猫", "喜欢甜品"], interests: ["猫咪", "甜品"] },
    { userId: "444", chatId: "-100123456", dunbarTier: 4, traits: ["技术宅"], interests: ["编程", "游戏"] },
    { userId: "222", chatId: "-100789012", dunbarTier: 2, traits: ["美食家"], interests: ["美食", "日料"] },
    { userId: "333", chatId: "-100789012", dunbarTier: 3, traits: ["甜品控"], interests: ["抹茶", "甜品"] },
];

console.log("\n📊 写入群组画像...");
for (const p of profiles) {
    memory.upsertPersonGroupProfile(p.userId, p.chatId, {
        dunbarTier: p.dunbarTier as 1 | 2 | 3 | 4,
        traits: p.traits,
        interests: p.interests,
    });
    console.log(`  ✔ ${p.userId} @ ${p.chatId} (tier ${p.dunbarTier})`);
}

// ─── 5. 群组模型 ───

console.log("\n🏠 写入群组模型...");
memory.upsertGroupModel("-100123456", {
    chatTitle: "二次元研究所",
    description: "技术 + 旅行 + 动漫",
    dominantLanguage: "zh",
    activeMembers: 4,
    agentRole: "知识分享者",
    engagementLevel: "high",
});
console.log(`  ✔ 二次元研究所`);

memory.upsertGroupModel("-100789012", {
    chatTitle: "吃货联盟",
    description: "美食 + 游戏",
    dominantLanguage: "zh",
    activeMembers: 3,
    agentRole: "陪聊",
    engagementLevel: "medium",
});
console.log(`  ✔ 吃货联盟`);

// ─── 6. 重建 vec0 索引 ───

if (memory.sqliteVecAvailable) {
    console.log("\n🔄 重建 vec0 索引...");
    const stats = memory.rebuildVecIndex();
    console.log(`  ✔ topics: ${stats.topics}, facts: ${stats.facts}`);
}

// ─── 完成 ───

memory.close();
console.log(`\n✅ Bootstrap 数据库创建完成: ${dbPath}`);
console.log(`\n📊 数据统计:`);
console.log(`   话题: ${topics.length}`);
console.log(`   事实: ${facts.length}`);
console.log(`   消息: ${messages.length}`);
console.log(`   人物: ${persons.length}`);
console.log(`   画像: ${profiles.length}`);
console.log(`   群组: 2`);
console.log(`\n🧪 尝试 dry-run:`);
console.log(`   npx tsx -e "import { MemoryStoreV2 } from './src/memory-v2/memory-v2.js'; const m = new MemoryStoreV2('${dbPath}'); console.log(await m.recall('京都旅行')); m.close()"`);
