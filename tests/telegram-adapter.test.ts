/**
 * telegram-adapter.test.ts — TelegramAdapter 登录与 ingress 测试
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { NotificationCenter } from "../src/event/notification-center.js";
import { TelegramAdapter } from "../src/adapter/telegram-adapter.js";
import type { TelegramConfig } from "../src/core/config.js";

function makeNC(): NotificationCenter {
    return new NotificationCenter(join(tmpdir(), `tg-adapter-${randomUUID()}.jsonl`), false);
}

function makeConfig(overrides: Partial<TelegramConfig> = {}): TelegramConfig {
    return {
        mode: "bot",
        botToken: "bot-token",
        apiId: "12345",
        apiHash: "hash",
        phone: "",
        ...overrides,
    };
}

describe("TelegramAdapter", () => {
    it("should start in bot mode without prompting OTP", async () => {
        const nc = makeNC();
        const prompts: string[] = [];
        const startCalls: Array<Record<string, unknown>> = [];

        let newMessageHandler: ((msg: unknown) => void | Promise<void>) | null = null;
        const fakeClient = {
            async start(params: Record<string, unknown>) {
                startCalls.push(params);
                return { id: 42, displayName: "BotUser", isBot: true };
            },
            onNewMessage: {
                add(handler: (msg: unknown) => void | Promise<void>) {
                    newMessageHandler = handler;
                },
                remove() {
                    newMessageHandler = null;
                },
            },
            async destroy() {},
        };

        const adapter = new TelegramAdapter(
            makeConfig(),
            nc,
            async (prompt) => {
                prompts.push(prompt);
                return "unused";
            },
            () => {},
            async () => fakeClient,
        );

        await adapter.start();

        assert.equal(startCalls.length, 1);
        assert.deepEqual(startCalls[0], { botToken: "bot-token" });
        assert.equal(prompts.length, 0);
        assert.ok(newMessageHandler);

        await adapter.stop();
        nc.dispose();
    });

    it("should support userbot OTP and password prompts", async () => {
        const nc = makeNC();
        const prompts: string[] = [];
        const printed: string[] = [];
        const startCalls: Array<Record<string, unknown>> = [];

        const fakeClient = {
            async start(params: Record<string, unknown>) {
                startCalls.push(params);

                const phone = await (params.phone as () => string)();
                const code = await (params.code as () => Promise<string>)();
                const password = await (params.password as () => Promise<string>)();
                (params.codeSentCallback as (sentCode: { type: string }) => void)({ type: "sms" });

                assert.equal(phone, "+8613800000000");
                assert.equal(code, "123456");
                assert.equal(password, "pass-2fa");

                return { id: 99, displayName: "Userbot", isBot: false };
            },
            onNewMessage: {
                add() {},
                remove() {},
            },
            async destroy() {},
        };

        const adapter = new TelegramAdapter(
            makeConfig({
                mode: "userbot",
                botToken: "",
                phone: "+8613800000000",
            }),
            nc,
            async (prompt) => {
                prompts.push(prompt);
                return prompt.includes("两步验证") ? "pass-2fa" : "123456";
            },
            (message) => {
                printed.push(message);
            },
            async () => fakeClient,
        );

        await adapter.start();

        assert.equal(startCalls.length, 1);
        assert.equal(typeof startCalls[0].phone, "function");
        assert.equal(typeof startCalls[0].code, "function");
        assert.equal(typeof startCalls[0].password, "function");
        assert.equal(typeof startCalls[0].codeSentCallback, "function");
        assert.deepEqual(prompts, ["请输入 Telegram 验证码: ", "请输入 Telegram 两步验证密码: "]);
        assert.ok(printed.some(line => line.includes("验证码已发送")));
        assert.ok(printed.some(line => line.includes("TelegramAdapter 已启动")));

        await adapter.stop();
        nc.dispose();
    });

    it("should normalize incoming messages into nc.message events", async () => {
        const nc = makeNC();
        let newMessageHandler: ((msg: unknown) => void | Promise<void>) | null = null;

        const fakeClient = {
            async start() {
                return { id: 99, displayName: "Userbot", isBot: false };
            },
            onNewMessage: {
                add(handler: (msg: unknown) => void | Promise<void>) {
                    newMessageHandler = handler;
                },
                remove() {
                    newMessageHandler = null;
                },
            },
            async destroy() {},
        };

        const adapter = new TelegramAdapter(
            makeConfig(),
            nc,
            async () => "",
            () => {},
            async () => fakeClient,
        );

        await adapter.start();
        assert.ok(newMessageHandler);

        await newMessageHandler!({
            id: 555,
            text: "hello from telegram",
            date: new Date("2026-03-08T12:00:00.000Z"),
            isMention: true,
            chat: { id: -100123, title: "Test Group", type: "supergroup" },
            sender: { id: 777, displayName: "Alice", isBot: false },
        });

        const events = await nc.drain(0, 10);
        assert.equal(events.length, 1);
        assert.equal(events[0].type, "nc.message");
        assert.equal(events[0].scene, "telegram");
        assert.equal(events[0].chatId, "-100123");
        assert.equal(events[0].messageId, "555");
        assert.equal(events[0].displayName, "Alice");
        assert.equal(events[0].mentionsAgent, true);
        assert.equal(events[0].chatType, "supergroup");
        assert.deepEqual(events[0].source, {
            scene: "telegram",
            platform: "telegram",
            chatId: "-100123",
            userId: "777",
            chatType: "supergroup",
            messageId: "555",
            replyToMessageId: undefined,
        });

        await adapter.stop();
        nc.dispose();
    });

    it("should coerce numeric string peer ids before host calls", async () => {
        const nc = makeNC();
        const sendTextCalls: unknown[] = [];
        const getHistoryCalls: unknown[] = [];

        const fakeClient = {
            async start() {
                return { id: 99, displayName: "Userbot", isBot: false };
            },
            onNewMessage: {
                add() {},
                remove() {},
            },
            async sendText(chatId: unknown, text: unknown, opts?: unknown) {
                sendTextCalls.push([chatId, text, opts]);
                return {
                    id: 1,
                    text,
                    date: new Date("2026-03-08T12:00:00.000Z"),
                    chat: { id: chatId, title: "Test", type: "supergroup" },
                    sender: { id: 99, displayName: "Bot", isBot: true },
                };
            },
            async getHistory(chatId: unknown) {
                getHistoryCalls.push(chatId);
                return [];
            },
            async destroy() {},
        };

        const adapter = new TelegramAdapter(
            makeConfig(),
            nc,
            async () => "",
            () => {},
            async () => fakeClient,
        );

        await adapter.start();
        await adapter.handleCall("telegram.sendText", ["-100123", "hi", { replyTo: 7 }]);
        await adapter.handleCall("telegram.getHistory", ["682932098", { limit: 5 }]);

        assert.deepEqual(sendTextCalls[0], [-100123, "hi", { replyTo: 7 }]);
        assert.equal(getHistoryCalls[0], 682932098);

        await adapter.stop();
        nc.dispose();
    });

    it("should narrow telegram scene type defs in bot mode", async () => {
        const adapter = new TelegramAdapter(
            makeConfig({ mode: "bot" }),
            makeNC(),
            async () => "",
            () => {},
            async () => ({
                async start() {
                    return { id: 1, displayName: "BotUser", isBot: true };
                },
                onNewMessage: { add() {}, remove() {} },
                async destroy() {},
            }),
        );

        const base = `
interface TelegramClient {
  sendText(chatId: number | string, text: string): Promise<Message>;
  // [USERBOT_ONLY_BEGIN]
  getHistory(chatId: number | string, opts?: { limit?: number }): Promise<Message[]>;
  iterDialogs(opts?: { limit?: number }): AsyncIterable<Dialog>;
  // [USERBOT_ONLY_END]
}
`.trim();

        const botDefs = adapter.getSceneTypeDefs("telegram", base)!;
        assert.ok(botDefs.includes("当前 Telegram adapter 模式: bot"));
        assert.ok(!botDefs.includes("getHistory"));
        assert.ok(!botDefs.includes("iterDialogs"));
        assert.ok(botDefs.includes("sendText"));
    });
});
