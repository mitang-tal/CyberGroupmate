/**
 * tests/llm-vision-fallback.test.ts — 多模态 fallback 降级
 *
 * 场景：Path A（configs[0] 支持 vision）给消息塞了 imageParts，
 * 但 configs[0] 调用失败后 fallback 到的 profile 不支持 vision。
 * 带着图片打过去必然继续失败，fallback 形同虚设。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import {
    callLLMWithFallback,
    stripImagePartsForNonVisionModel,
    type ChatMessage,
} from "../src/core/llm.js";
import type { LLMConfig } from "../src/core/config.js";

const IMAGE_DATA_URI = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";

interface RecordedRequest {
    model: string;
    body: Record<string, any>;
}

/**
 * 起一个假的 OpenAI 兼容 endpoint。
 * model 名里带 "boom" 的返回 400（不可重试 → 立即 fallback，测试不会卡在退避上）。
 */
async function startFakeApi(recorded: RecordedRequest[]): Promise<{ server: Server; port: number }> {
    const server = createServer((req, res) => {
        let raw = "";
        req.on("data", (chunk) => { raw += chunk; });
        req.on("end", () => {
            let body: Record<string, any> = {};
            try { body = JSON.parse(raw); } catch { /* ignore */ }
            const model = String(body.model ?? "");
            recorded.push({ model, body });

            if (model.includes("boom")) {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: { message: "vision model exploded" } }));
                return;
            }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
                choices: [{ message: { content: "ok" } }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }));
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { server, port: (server.address() as { port: number }).port };
}

function makeProfile(port: number, model: string, vision?: boolean): LLMConfig {
    return {
        provider: "openai",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: "test",
        model,
        temperature: 0,
        maxTokens: 64,
        ...(vision ? { vision: true } : {}),
    };
}

function messagesWithImage(): ChatMessage[] {
    return [
        { role: "system", content: "你是助手" },
        { role: "user", content: "看看这张图", imageParts: [{ url: IMAGE_DATA_URI }] },
    ];
}

/** 请求体里是否含多模态 image_url part */
function hasImageParts(body: Record<string, any>): boolean {
    return (body.messages ?? []).some((m: any) =>
        Array.isArray(m.content) && m.content.some((p: any) => p?.type === "image_url")
    );
}

function userText(body: Record<string, any>): string {
    const user = (body.messages ?? []).find((m: any) => m.role === "user");
    if (!user) return "";
    return typeof user.content === "string"
        ? user.content
        : (user.content ?? []).filter((p: any) => p?.type === "text").map((p: any) => p.text).join("\n");
}

describe("stripImagePartsForNonVisionModel", () => {
    it("移除 imageParts 并留下带数量的文字占位", () => {
        const stripped = stripImagePartsForNonVisionModel([
            { role: "user", content: "两张图", imageParts: [{ url: "a" }, { url: "b" }] },
        ]);
        assert.equal(stripped[0].imageParts, undefined);
        assert.match(stripped[0].content, /两张图/);
        assert.match(stripped[0].content, /图片 ×2/);
        assert.match(stripped[0].content, /不支持图片输入/);
    });

    it("没有图片的消息原样返回（保持引用）", () => {
        const input: ChatMessage[] = [{ role: "user", content: "纯文本" }];
        const stripped = stripImagePartsForNonVisionModel(input);
        assert.equal(stripped[0], input[0]);
    });

    it("content 为空时占位文字仍然存在", () => {
        const stripped = stripImagePartsForNonVisionModel([
            { role: "user", content: "", imageParts: [{ url: "a" }] },
        ]);
        assert.match(stripped[0].content, /图片 ×1/);
    });
});

describe("callLLMWithFallback 多模态降级", () => {
    it("fallback 到不支持 vision 的 profile 时自动去掉图片并成功", async () => {
        const recorded: RecordedRequest[] = [];
        const { server, port } = await startFakeApi(recorded);
        try {
            const visionProfile = makeProfile(port, "vision-boom", true);
            const textProfile = makeProfile(port, "text-only");

            const response = await callLLMWithFallback(
                messagesWithImage(),
                [visionProfile, textProfile],
                { caller: "test", maxRetries: 0 },
            );

            assert.equal(response.content, "ok", "应由第二个 profile 成功返回");
            assert.equal(recorded.length, 2, "应恰好尝试两个 profile");

            assert.equal(recorded[0].model, "vision-boom");
            assert.equal(hasImageParts(recorded[0].body), true, "vision profile 应照常收到图片");

            assert.equal(recorded[1].model, "text-only");
            assert.equal(hasImageParts(recorded[1].body), false, "非 vision profile 不应收到图片");
            assert.match(userText(recorded[1].body), /图片 ×1/, "应带文字占位说明");
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });

    it("原始 messages 不被修改（降级只作用于本次请求）", async () => {
        const recorded: RecordedRequest[] = [];
        const { server, port } = await startFakeApi(recorded);
        try {
            const messages = messagesWithImage();
            await callLLMWithFallback(
                messages,
                [makeProfile(port, "vision-boom", true), makeProfile(port, "text-only")],
                { caller: "test", maxRetries: 0 },
            );
            assert.equal(messages[1].imageParts?.length, 1, "调用方持有的 messages 不应被就地改动");
            assert.equal(messages[1].content, "看看这张图");
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });

    it("fallback 目标也支持 vision 时保留图片", async () => {
        const recorded: RecordedRequest[] = [];
        const { server, port } = await startFakeApi(recorded);
        try {
            await callLLMWithFallback(
                messagesWithImage(),
                [makeProfile(port, "vision-boom", true), makeProfile(port, "vision-backup", true)],
                { caller: "test", maxRetries: 0 },
            );
            assert.equal(recorded.length, 2);
            assert.equal(hasImageParts(recorded[1].body), true, "备用 vision profile 应仍收到图片");
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });

    it("整条 chain 都没声明 vision 时不降级（避免误伤没写 vision:true 的视觉 profile）", async () => {
        const recorded: RecordedRequest[] = [];
        const { server, port } = await startFakeApi(recorded);
        try {
            // 模拟 vision 路由的 profile 忘了写 vision: true
            await callLLMWithFallback(
                messagesWithImage(),
                [makeProfile(port, "describer-boom"), makeProfile(port, "describer-backup")],
                { caller: "test", maxRetries: 0 },
            );
            assert.equal(recorded.length, 2);
            assert.equal(hasImageParts(recorded[1].body), true, "标记未维护时应保持原行为，仍然发图");
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });

    it("单个非 vision profile 也不降级（无 chain 信息可依据）", async () => {
        const recorded: RecordedRequest[] = [];
        const { server, port } = await startFakeApi(recorded);
        try {
            await callLLMWithFallback(
                messagesWithImage(),
                [makeProfile(port, "solo")],
                { caller: "test", maxRetries: 0 },
            );
            assert.equal(recorded.length, 1);
            assert.equal(hasImageParts(recorded[0].body), true);
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });

    it("无图片时 fallback 行为不变", async () => {
        const recorded: RecordedRequest[] = [];
        const { server, port } = await startFakeApi(recorded);
        try {
            const response = await callLLMWithFallback(
                [{ role: "user", content: "纯文本" }],
                [makeProfile(port, "vision-boom", true), makeProfile(port, "text-only")],
                { caller: "test", maxRetries: 0 },
            );
            assert.equal(response.content, "ok");
            assert.equal(userText(recorded[1].body), "纯文本", "不应插入任何图片占位");
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });
});
