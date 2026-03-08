/**
 * nc-event.test.ts — NC 标准化事件测试
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeMessageEvent } from "../src/event/nc-event.js";
import type { NotificationEvent } from "../src/event/notification-center.js";

describe("normalizeMessageEvent", () => {
    it("should normalize legacy telegram.message events", () => {
        const event = {
            _id: "01",
            _ts: "2026-03-08T10:00:00.000Z",
            type: "telegram.message",
            chatId: -100123,
            userId: 42,
            userName: "Alice",
            text: "hello",
            messageId: 99,
            replyToMessageId: 12,
        } satisfies NotificationEvent;

        const normalized = normalizeMessageEvent(event);
        assert.ok(normalized);
        assert.equal(normalized!.scene, "telegram");
        assert.equal(normalized!.chatId, "-100123");
        assert.equal(normalized!.userId, "42");
        assert.equal(normalized!.messageId, "99");
        assert.equal(normalized!.replyToMessageId, "12");
    });

    it("should normalize nc.message events", () => {
        const event = {
            _id: "02",
            _ts: "2026-03-08T10:00:00.000Z",
            type: "nc.message",
            scene: "discord",
            payload: {
                chatId: "guild-1",
                userId: "user-2",
                displayName: "Bob",
                text: "ping",
                timestamp: "2026-03-08T10:00:00.000Z",
                messageId: "m-5",
            },
        } satisfies NotificationEvent;

        const normalized = normalizeMessageEvent(event);
        assert.ok(normalized);
        assert.equal(normalized!.scene, "discord");
        assert.equal(normalized!.chatId, "guild-1");
        assert.equal(normalized!.userId, "user-2");
        assert.equal(normalized!.displayName, "Bob");
        assert.equal(normalized!.messageId, "m-5");
    });
});
