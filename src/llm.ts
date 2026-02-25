/**
 * llm.ts — LLM API 调用封装
 *
 * 统一的 LLM 调用接口，支持 Anthropic Claude API 和 OpenAI 兼容 API。
 * 处理 rate limiting、重试和错误恢复。
 *
 * 在整体架构中的位置：
 * - Orchestrator (main.ts) 通过 callLLM 调用 LLM
 * - CodeAct session runner 使用此模块进行多轮对话
 * - Compaction 使用此模块生成对话摘要
 */

import { readFileSync, existsSync } from "node:fs";

// ─── 类型定义 ───

/** OpenAI 格式消息 */
export interface ChatMessage {
    role: "system" | "user" | "assistant";
    content: string;
}

/** LLM 配置 */
export interface LLMConfig {
    /** API 提供商: "anthropic" | "openai" */
    provider: "anthropic" | "openai";
    /** API base URL */
    baseUrl: string;
    /** API key（从环境变量或配置文件读取） */
    apiKey: string;
    /** 模型名称 */
    model: string;
    /** 温度参数，默认 0.7 */
    temperature: number;
    /** 最大输出 token 数，默认 4096 */
    maxTokens: number;
}

/** LLM 调用选项（可覆盖默认配置） */
export interface LLMCallOptions {
    /** 覆盖默认温度 */
    temperature?: number;
    /** 覆盖默认 max tokens */
    maxTokens?: number;
    /** 覆盖默认 model */
    model?: string;
}

/** LLM 调用结果 */
export interface LLMResponse {
    /** 生成的文本 */
    content: string;
    /** 使用的 token 数量（如果 API 返回） */
    usage?: {
        promptTokens?: number;
        completionTokens?: number;
        totalTokens?: number;
    };
}

// ─── 配置加载 ───

/**
 * 从 config.yaml 或环境变量加载 LLM 配置
 *
 * 优先级：环境变量 > config.yaml > 默认值
 *
 * 环境变量：
 * - LLM_PROVIDER: "anthropic" | "openai"
 * - LLM_BASE_URL: API base URL
 * - LLM_API_KEY: API key
 * - LLM_MODEL: model name
 * - LLM_TEMPERATURE: temperature
 * - LLM_MAX_TOKENS: max tokens
 */
export function loadLLMConfig(configPath?: string): LLMConfig {
    let fileConfig: Record<string, unknown> = {};

    // 尝试从 config.yaml 读取 LLM 配置
    const path = configPath ?? "config.yaml";
    if (existsSync(path)) {
        try {
            const content = readFileSync(path, "utf-8");
            fileConfig = parseSimpleYaml(content);
        } catch {
            // 配置文件解析失败，使用环境变量和默认值
        }
    }

    const llmSection =
        (fileConfig.llm as Record<string, unknown>) ?? {};

    return {
        provider:
            (process.env.LLM_PROVIDER as "anthropic" | "openai") ??
            (llmSection.provider as string) ??
            "openai",
        baseUrl:
            process.env.LLM_BASE_URL ??
            (llmSection.baseUrl as string) ??
            (llmSection.base_url as string) ??
            "https://api.openai.com/v1",
        apiKey:
            process.env.LLM_API_KEY ??
            (llmSection.apiKey as string) ??
            (llmSection.api_key as string) ??
            "",
        model:
            process.env.LLM_MODEL ??
            (llmSection.model as string) ??
            "gpt-4o",
        temperature: Number(
            process.env.LLM_TEMPERATURE ??
            llmSection.temperature ??
            0.7
        ),
        maxTokens: Number(
            process.env.LLM_MAX_TOKENS ??
            llmSection.maxTokens ??
            llmSection.max_tokens ??
            4096
        ),
    };
}

/**
 * 简单的 YAML 解析器
 *
 * 只支持一层嵌套的 key: value 格式，不引入 yaml 依赖。
 * 支持的格式：
 * ```yaml
 * llm:
 *   provider: openai
 *   model: gpt-4o
 * persona:
 *   name: 赛博群友
 * ```
 */
function parseSimpleYaml(content: string): Record<string, unknown> {
    const result: Record<string, Record<string, unknown>> = {};
    let currentSection: string | null = null;

    for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;

        // 顶层 key（无缩进，以 : 结尾）
        if (!line.startsWith(" ") && !line.startsWith("\t") && trimmed.endsWith(":")) {
            currentSection = trimmed.slice(0, -1).trim();
            result[currentSection] = {};
            continue;
        }

        // 嵌套 key: value（有缩进）
        if (currentSection && (line.startsWith("  ") || line.startsWith("\t"))) {
            const colonIdx = trimmed.indexOf(":");
            if (colonIdx > 0) {
                const key = trimmed.slice(0, colonIdx).trim();
                let value: string | number | boolean = trimmed.slice(colonIdx + 1).trim();

                // 去掉引号
                if (
                    (value.startsWith('"') && value.endsWith('"')) ||
                    (value.startsWith("'") && value.endsWith("'"))
                ) {
                    value = value.slice(1, -1);
                }

                // 尝试解析数字和布尔
                if (value === "true") value = true as unknown as string;
                else if (value === "false") value = false as unknown as string;
                else if (/^\d+(\.\d+)?$/.test(value as string)) value = Number(value);

                result[currentSection][key] = value;
            }
        }
    }

    return result;
}

// ─── LLM 调用 ───

const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 2000, 4000]; // 指数退避

/**
 * 调用 LLM API
 *
 * 支持 Anthropic Claude API 和 OpenAI 兼容 API。
 * 自动处理 rate limiting 和重试。
 *
 * @param messages - OpenAI 格式消息数组
 * @param config - LLM 配置
 * @param options - 可选的调用参数覆盖
 * @returns LLM 响应（含生成文本和 token 用量）
 *
 * @example
 * ```ts
 * const config = loadLLMConfig();
 * const response = await callLLM([
 *   { role: "system", content: "You are a helpful assistant." },
 *   { role: "user", content: "Hello!" }
 * ], config);
 * console.log(response.content);
 * ```
 */
export async function callLLM(
    messages: ChatMessage[],
    config: LLMConfig,
    options?: LLMCallOptions
): Promise<LLMResponse> {
    const model = options?.model ?? config.model;
    const temperature = options?.temperature ?? config.temperature;
    const maxTokens = options?.maxTokens ?? config.maxTokens;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            if (config.provider === "anthropic") {
                return await callAnthropic(messages, config, model, temperature, maxTokens);
            } else {
                return await callOpenAI(messages, config, model, temperature, maxTokens);
            }
        } catch (err: unknown) {
            const isRateLimit =
                err instanceof Error &&
                (err.message.includes("429") ||
                    err.message.includes("rate limit") ||
                    err.message.includes("overloaded"));

            const isServerError =
                err instanceof Error &&
                (err.message.includes("500") ||
                    err.message.includes("502") ||
                    err.message.includes("503"));

            if ((isRateLimit || isServerError) && attempt < MAX_RETRIES) {
                const delay = RETRY_DELAYS[attempt] ?? 4000;
                await new Promise((r) => setTimeout(r, delay));
                continue;
            }

            throw err;
        }
    }

    // 不应到达这里
    throw new Error("LLM call failed after all retries");
}

/**
 * 调用 OpenAI 兼容 API
 */
async function callOpenAI(
    messages: ChatMessage[],
    config: LLMConfig,
    model: string,
    temperature: number,
    maxTokens: number
): Promise<LLMResponse> {
    const url = `${config.baseUrl.replace(/\/$/, "")}/chat/completions`;

    const headers: Record<string, string> = {
        "Content-Type": "application/json",
    };
    if (config.apiKey) {
        headers["Authorization"] = `Bearer ${config.apiKey}`;
    }

    const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
            model,
            messages,
            temperature,
            max_tokens: maxTokens,
        }),
    });

    if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
            `OpenAI API error ${response.status}: ${response.statusText} — ${body}`
        );
    }

    const data = (await response.json()) as {
        choices: Array<{ message: { content: string } }>;
        usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            total_tokens?: number;
        };
    };

    return {
        content: data.choices?.[0]?.message?.content ?? "",
        usage: data.usage
            ? {
                promptTokens: data.usage.prompt_tokens,
                completionTokens: data.usage.completion_tokens,
                totalTokens: data.usage.total_tokens,
            }
            : undefined,
    };
}

/**
 * 调用 Anthropic Claude API
 */
async function callAnthropic(
    messages: ChatMessage[],
    config: LLMConfig,
    model: string,
    temperature: number,
    maxTokens: number
): Promise<LLMResponse> {
    const url = `${config.baseUrl.replace(/\/$/, "")}/messages`;

    // 提取 system message
    const systemMsg = messages.find((m) => m.role === "system");
    const nonSystemMsgs = messages.filter((m) => m.role !== "system");

    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01",
    };

    const body: Record<string, unknown> = {
        model,
        messages: nonSystemMsgs.map((m) => ({
            role: m.role,
            content: m.content,
        })),
        temperature,
        max_tokens: maxTokens,
    };

    if (systemMsg) {
        body.system = systemMsg.content;
    }

    const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        const responseBody = await response.text().catch(() => "");
        throw new Error(
            `Anthropic API error ${response.status}: ${response.statusText} — ${responseBody}`
        );
    }

    const data = (await response.json()) as {
        content: Array<{ type: string; text: string }>;
        usage?: {
            input_tokens?: number;
            output_tokens?: number;
        };
    };

    const text = data.content
        ?.filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("");

    return {
        content: text ?? "",
        usage: data.usage
            ? {
                promptTokens: data.usage.input_tokens,
                completionTokens: data.usage.output_tokens,
                totalTokens:
                    (data.usage.input_tokens ?? 0) + (data.usage.output_tokens ?? 0),
            }
            : undefined,
    };
}
