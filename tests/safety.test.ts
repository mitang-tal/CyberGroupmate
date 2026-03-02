/**
 * safety.test.ts — Safety 模块单元测试
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    MessageRateLimiter,
    RateLimitError,
    PermissionError,
    checkForbiddenMethod,
    getForbiddenMethods,
} from "../src/core/safety.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { rmSync, existsSync, readFileSync } from "node:fs";

describe("MessageRateLimiter", () => {
    function makeLimiter(config?: {
        maxMessagesPerSession?: number;
        maxMessagesPerMinute?: number;
    }): MessageRateLimiter {
        const logPath = join(
            tmpdir(),
            `safety-test-${randomUUID()}`,
            "sent.jsonl"
        );
        return new MessageRateLimiter(config, logPath);
    }

    it("should allow messages within session limit", () => {
        const limiter = makeLimiter({ maxMessagesPerSession: 3 });
        assert.doesNotThrow(() => limiter.checkAndRecord("chat1", "msg1"));
        assert.doesNotThrow(() => limiter.checkAndRecord("chat1", "msg2"));
        assert.doesNotThrow(() => limiter.checkAndRecord("chat1", "msg3"));
    });

    it("should throw RateLimitError when session limit exceeded", () => {
        const limiter = makeLimiter({ maxMessagesPerSession: 2 });
        limiter.checkAndRecord("chat1", "msg1");
        limiter.checkAndRecord("chat1", "msg2");

        assert.throws(() => limiter.checkAndRecord("chat1", "msg3"), RateLimitError);
    });

    it("should reset session counter", () => {
        const limiter = makeLimiter({ maxMessagesPerSession: 2 });
        limiter.checkAndRecord("chat1", "msg1");
        limiter.checkAndRecord("chat1", "msg2");

        limiter.resetSession();
        assert.equal(limiter.currentSessionCount, 0);
        assert.doesNotThrow(() => limiter.checkAndRecord("chat1", "msg3"));
    });

    it("should track currentSessionCount", () => {
        const limiter = makeLimiter();
        assert.equal(limiter.currentSessionCount, 0);
        limiter.checkAndRecord("chat1", "msg1");
        assert.equal(limiter.currentSessionCount, 1);
        limiter.checkAndRecord("chat1", "msg2");
        assert.equal(limiter.currentSessionCount, 2);
    });

    it("should log sent messages to JSONL", () => {
        const logPath = join(
            tmpdir(),
            `safety-test-${randomUUID()}`,
            "sent.jsonl"
        );
        const limiter = new MessageRateLimiter({}, logPath);

        limiter.checkAndRecord("chat123", "msg456");
        limiter.checkAndRecord("chat789", "msg012");

        assert.ok(existsSync(logPath));
        const lines = readFileSync(logPath, "utf-8").trim().split("\n");
        assert.equal(lines.length, 2);

        const entry1 = JSON.parse(lines[0]);
        assert.equal(entry1.chatId, "chat123");
        assert.equal(entry1.messageId, "msg456");
        assert.ok(entry1.timestamp);

        // Cleanup
        const dir = join(logPath, "..");
        if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    });
});

describe("Forbidden methods", () => {
    it("should throw PermissionError for deleteMessages", () => {
        assert.throws(() => checkForbiddenMethod("deleteMessages"), PermissionError);
    });

    it("should throw PermissionError for banUser", () => {
        assert.throws(() => checkForbiddenMethod("banUser"), PermissionError);
    });

    it("should throw PermissionError for banChatMember", () => {
        assert.throws(
            () => checkForbiddenMethod("banChatMember"),
            PermissionError
        );
    });

    it("should not throw for allowed methods", () => {
        assert.doesNotThrow(() => checkForbiddenMethod("sendText"));
        assert.doesNotThrow(() => checkForbiddenMethod("getMessages"));
        assert.doesNotThrow(() => checkForbiddenMethod("searchMessages"));
    });

    it("should list all forbidden methods", () => {
        const methods = getForbiddenMethods();
        assert.ok(methods.length > 0);
        assert.ok(methods.includes("deleteMessages"));
        assert.ok(methods.includes("banUser"));
        assert.ok(methods.includes("leaveChat"));
    });
});
