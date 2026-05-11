import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve as pathResolve } from "node:path";
import { NotificationCenter } from "../src/event/notification-center.js";
import { OneBotAdapter } from "../src/adapter/onebot-adapter.js";
import type { OneBotConfig } from "../src/core/config.js";

function makeNC(): NotificationCenter {
    return new NotificationCenter(join(tmpdir(), `onebot-adapter-${randomUUID()}.jsonl`), false);
}

function makeConfig(overrides: Partial<OneBotConfig> = {}): OneBotConfig {
    return {
        wsUrl: "ws://127.0.0.1:6700/onebot",
        selfId: "123456789",
        ...overrides,
    };
}

describe("OneBotAdapter", () => {
    it("should resolve numeric download refs through get_msg image URLs", async () => {
        const nc = makeNC();
        const adapter = new OneBotAdapter(makeConfig(), nc);
        const calls: Array<{ action: string; params: Record<string, unknown> }> = [];
        const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
        const originalFetch = globalThis.fetch;

        // @ts-expect-error - fake connected websocket for handleCall guard
        adapter.ws = { readyState: 1 };
        // @ts-expect-error - override private method for payload inspection
        adapter.callAction = async (action: string, params: Record<string, unknown>) => {
            calls.push({ action, params });
            if (action === "get_msg") {
                return {
                    message_id: 794582600,
                    message: [
                        {
                            type: "image",
                            data: {
                                file: "cached-image.jpg",
                                file_unique: "unique-image",
                                url: "https://cdn.example.test/image.png",
                            },
                        },
                    ],
                };
            }
            throw new Error(`unexpected action: ${action}`);
        };
        globalThis.fetch = async (url) => {
            assert.equal(String(url), "https://cdn.example.test/image.png");
            return new Response(bytes, { status: 200 });
        };

        try {
            const result = await adapter.handleCall("onebot.downloadMedia", ["794582600"]) as { buffer: string; size: number };
            assert.deepEqual(calls, [{ action: "get_msg", params: { message_id: 794582600 } }]);
            assert.equal(result.buffer, bytes.toString("base64"));
            assert.equal(result.size, bytes.length);
        } finally {
            globalThis.fetch = originalFetch;
            nc.dispose();
        }
    });

    it("should use get_image base64 instead of remote local paths", async () => {
        const nc = makeNC();
        const adapter = new OneBotAdapter(makeConfig(), nc);
        const bytes = Buffer.from("image-bytes");

        // @ts-expect-error - override private method for focused download test
        adapter.callAction = async (action: string, params: Record<string, unknown>) => {
            assert.equal(action, "get_image");
            assert.deepEqual(params, { file: "cached-image.jpg" });
            return {
                file: "/remote/napcat/cache/cached-image.jpg",
                base64: bytes.toString("base64"),
            };
        };

        try {
            // @ts-expect-error - invoke private-ish adapter API directly for focused transport test
            const result = await adapter.downloadMedia(null, "cached-image.jpg");
            assert.deepEqual(result, bytes);
        } finally {
            nc.dispose();
        }
    });

    it("should drop replyTo for group voice payloads", async () => {
        const nc = makeNC();
        const adapter = new OneBotAdapter(makeConfig(), nc);
        const calls: Array<{ action: string; params: Record<string, unknown> }> = [];

        // @ts-expect-error - override private method for payload inspection
        adapter.callAction = async (action: string, params: Record<string, unknown>) => {
            calls.push({ action, params });
            return { message_id: 1 };
        };

        // @ts-expect-error - invoke private method for focused transport test
        await adapter.sendMedia(
            "onebot:group:979200391",
            { type: "audio", file: "media/mimo_tts_1777522996493.ogg" },
            { replyTo: 1805758077 },
        );

        assert.equal(calls.length, 1);
        assert.equal(calls[0].action, "send_group_msg");
        assert.equal(calls[0].params.group_id, 979200391);
        assert.deepEqual(calls[0].params.message, [
            { type: "record", data: { file: `file://${pathResolve(process.cwd(), "workspace", "media/mimo_tts_1777522996493.ogg")}` } },
        ]);

        nc.dispose();
    });

    it("should drop replyTo for private voice payloads", async () => {
        const nc = makeNC();
        const adapter = new OneBotAdapter(makeConfig(), nc);
        const calls: Array<{ action: string; params: Record<string, unknown> }> = [];

        // @ts-expect-error - override private method for payload inspection
        adapter.callAction = async (action: string, params: Record<string, unknown>) => {
            calls.push({ action, params });
            return { message_id: 2 };
        };

        // @ts-expect-error - invoke private method for focused transport test
        await adapter.sendMedia(
            "onebot:private:12345678",
            { type: "audio", file: "media/private_voice.ogg" },
            { replyTo: 99887766 },
        );

        assert.equal(calls.length, 1);
        assert.equal(calls[0].action, "send_private_msg");
        assert.deepEqual(calls[0].params.message, [
            { type: "record", data: { file: `file://${pathResolve(process.cwd(), "workspace", "media/private_voice.ogg")}` } },
        ]);

        nc.dispose();
    });
});
