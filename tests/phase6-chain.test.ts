/**
 * phase6-chain.test.ts — Phase 6 主链路集成测试
 *
 * 覆盖：
 * NC/ReplyTask -> ReplyPipeline -> runCodeActSession -> sandbox code surface
 * -> host memory/actions bridge -> code-first social skill -> NC 回写
 */

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { NotificationCenter } from "../src/event/notification-center.js";
import { Sandbox } from "../src/sandbox/sandbox.js";
import { runCodeActSession } from "../src/sandbox/session-runner.js";
import { MemoryStoreV2 } from "../src/memory-v2/index.js";
import { TopicRegistry } from "../src/pipeline/topic-registry.js";
import { ModelRouter } from "../src/pipeline/model-router.js";
import { ReplyPipeline } from "../src/pipeline/reply-pipeline.js";
import type { LLMConfig } from "../src/core/config.js";
import type { TriageDecision } from "../src/pipeline/types.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
    const dir = join(tmpdir(), `phase6-chain-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    tempDirs.push(dir);
    return dir;
}

function serializeTopic(topic: ReturnType<TopicRegistry["get"]>): Record<string, unknown> | null {
    if (!topic) return null;
    return {
        ...topic,
        participantIds: [...topic.participantIds],
        messageIds: [...topic.messageIds],
        pendingMessages: topic.pendingMessages.map(msg => ({ ...msg })),
    };
}

async function withFakeOpenAI(
    handler: (req: IncomingMessage, body: string, res: ServerResponse) => void | Promise<void>,
): Promise<{ url: string; close: () => Promise<void> }> {
    const server = createServer((req, res) => {
        let body = "";
        req.on("data", chunk => {
            body += chunk.toString();
        });
        req.on("end", () => {
            void handler(req, body, res);
        });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") {
        throw new Error("failed to start fake llm server");
    }

    return {
        url: `http://127.0.0.1:${address.port}`,
        close: async () => {
            await new Promise<void>((resolve, reject) => {
                server.close(err => (err ? reject(err) : resolve()));
            });
        },
    };
}

after(() => {
    for (const dir of tempDirs) {
        rmSync(dir, { recursive: true, force: true });
    }
});

describe("Phase 6 chain", () => {
    it("should bridge topic task into CodeAct session and emit agent send event", async () => {
        const dir = makeTempDir();
        const nc = new NotificationCenter(join(dir, "events.jsonl"), false);
        const memory = new MemoryStoreV2(join(dir, "memory.db"));
        const sandbox = new Sandbox();
        const registry = new TopicRegistry();
        let topicId = "";
        let llmCalls = 0;

        const llmServer = await withFakeOpenAI((_req, _body, res) => {
            res.setHeader("content-type", "application/json");
            llmCalls += 1;
            res.end(JSON.stringify({
                choices: [{
                    message: {
                        content: llmCalls === 1
                            ? [
                                "先读取话题上下文，再发出简短回复。",
                                "```typescript",
                                `const topic = await actions.getTopicContext(${JSON.stringify(topicId)});`,
                                `const recall = await actions.recallForTopic(${JSON.stringify(topicId)});`,
                                "await skills.social.replyInTelegram(\"-1001\", `收到：${topic?.label ?? '未知话题'}`);",
                                "console.log(JSON.stringify({",
                                "  topicLabel: topic?.label ?? null,",
                                "  recalledTopics: recall?.topics?.length ?? 0",
                                "}));",
                                "```",
                            ].join("\n")
                            : "处理完成。",
                    },
                }],
                usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
            }));
        });

        const llmConfig: LLMConfig = {
            provider: "openai",
            baseUrl: `${llmServer.url}/v1`,
            apiKey: "test-key",
            model: "fake-model",
            temperature: 0,
            maxTokens: 1024,
        };

        const modelRouter = new ModelRouter(llmConfig);
        const replyPipeline = new ReplyPipeline(memory, registry, modelRouter, llmConfig);

        const topic = registry.create("-1001", "京都旅行", ["京都", "旅行"], [{
            id: "m1",
            chatId: "-1001",
            senderId: "u1",
            senderName: "Alice",
            text: "京都交通怎么安排？",
            timestamp: Date.now(),
            scene: "telegram",
        }], "topic_test_parent");
        topicId = topic.id;

        const decision: TriageDecision = {
            should_intervene: true,
            reason: "有人明确提问",
            intervention_type: "QUESTION_ANSWER",
            confidence: 0.92,
            pipelineMode: "GUIDED",
        };
        registry.setDecision(topicId, decision);

        memory.upsertTopic(topicId, {
            chatId: "-1001",
            label: topic.label,
            summary: "群友在问京都交通安排",
            keyPoints: ["Alice 需要交通建议"],
            keywords: topic.keywords,
            participants: [...topic.participantIds],
            messageRange: { messageIds: [...topic.messageIds], count: topic.messageCount },
            startedAt: new Date(topic.createdAt).toISOString(),
            wasEngaged: false,
            interventionCount: 0,
        });
        memory.storeMessageBatch([{
            messageId: "m1",
            chatId: "-1001",
            userId: "u1",
            displayName: "Alice",
            text: "京都交通怎么安排？",
            timestamp: new Date().toISOString(),
        }]);

        await sandbox.start();

        sandbox.setHostCallHandler(async (method, args) => {
            switch (method) {
                case "memory.recall":
                    return memory.recall(String(args[0]), args[1] as Record<string, unknown>);
                case "actions.getTopicContext":
                    return serializeTopic(registry.get(String(args[0])));
                case "actions.recallForTopic": {
                    const target = registry.get(String(args[0]));
                    if (!target) return null;
                    return memory.recall([target.label, ...target.keywords].join(" "), {
                        chatId: target.chatId,
                    });
                }
                case "telegram.sendText":
                    return {
                        id: "agent_msg_1",
                        chat: { id: String(args[0]), type: "group" },
                        sender: { id: "agent", firstName: "Cyber", isBot: true },
                        text: String(args[1]),
                        date: new Date().toISOString(),
                        isMention: false,
                    };
                default:
                    throw new Error(`unexpected host method: ${method}`);
            }
        });

        sandbox.on("notify", (event: Record<string, unknown>) => {
            nc.push(event as { type: string; [key: string]: unknown });
        });

        const task = await replyPipeline.buildTopicTask(topicId);
        assert.ok(task, "topic task should be built");

        const result = await runCodeActSession(
            [
                { role: "system", content: "你通过写 TypeScript 代码行动。" },
                { role: "user", content: task!.prompt },
            ],
            "telegram",
            sandbox,
            nc,
            llmConfig,
            join(dir, "sessions"),
        );

        assert.equal(result.endReason, "no_code");

        const sentEvents = await nc.drain(0, 20);
        const sentEvent = sentEvents.find(event => event.type === "system.agent_message_sent");
        assert.ok(sentEvent, "should emit agent send event");
        assert.equal(sentEvent!.chatId, "-1001");
        assert.equal(sentEvent!.text, "收到：京都旅行");

        await sandbox.stop();
        await llmServer.close();
        memory.close();
        nc.dispose();
    });
});
