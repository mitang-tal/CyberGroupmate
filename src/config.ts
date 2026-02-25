/**
 * config.ts — 统一配置管理器
 *
 * 从 config.yaml 加载配置，支持环境变量覆盖。
 * 使用 `yaml` 库进行正式的 YAML 解析。
 *
 * 配置优先级：环境变量 > config.yaml > 默认值
 */

import { readFileSync, existsSync } from "node:fs";
import { parse as parseYAML } from "yaml";

// ─── 类型定义 ───

export interface LLMConfig {
    provider: "anthropic" | "openai";
    baseUrl: string;
    apiKey: string;
    model: string;
    temperature: number;
    maxTokens: number;
}

export interface PersonaConfig {
    name: string;
    description: string;
}

export interface TelegramConfig {
    mode: "bot" | "userbot";
    botToken: string;
    apiId: string;
    apiHash: string;
    phone: string;
}

export interface AppConfig {
    llm: LLMConfig;
    persona: PersonaConfig;
    telegram: TelegramConfig;
}

// ─── 默认值 ───

const DEFAULTS: AppConfig = {
    llm: {
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "",
        model: "gpt-4o",
        temperature: 0.7,
        maxTokens: 4096,
    },
    persona: {
        name: "赛博群友",
        description: "",
    },
    telegram: {
        mode: "bot",
        botToken: "",
        apiId: "",
        apiHash: "",
        phone: "",
    },
};

// ─── 配置加载 ───

let _cached: AppConfig | null = null;

/**
 * 加载应用配置
 *
 * @param configPath - 配置文件路径，默认 "config.yaml"
 * @param forceReload - 强制重新加载（忽略缓存）
 * @returns 完整的应用配置
 */
export function loadConfig(configPath?: string, forceReload?: boolean): AppConfig {
    if (_cached && !forceReload) return _cached;

    let fileConfig: Record<string, unknown> = {};
    const path = configPath ?? "config.yaml";

    if (existsSync(path)) {
        try {
            const raw = readFileSync(path, "utf-8");
            fileConfig = parseYAML(raw) ?? {};
        } catch (err) {
            console.error(`[Config] config.yaml 解析错误: ${err instanceof Error ? err.message : err}`);
        }
    }

    const fileLLM = (fileConfig.llm ?? {}) as Record<string, unknown>;
    const filePersona = (fileConfig.persona ?? {}) as Record<string, unknown>;
    const fileTG = (fileConfig.telegram ?? {}) as Record<string, unknown>;

    const config: AppConfig = {
        llm: {
            provider:
                (env("LLM_PROVIDER") as "anthropic" | "openai") ??
                str(fileLLM.provider) ??
                DEFAULTS.llm.provider,
            baseUrl:
                env("LLM_BASE_URL") ??
                str(fileLLM.base_url) ?? str(fileLLM.baseUrl) ??
                DEFAULTS.llm.baseUrl,
            apiKey:
                env("LLM_API_KEY") ??
                str(fileLLM.api_key) ?? str(fileLLM.apiKey) ??
                DEFAULTS.llm.apiKey,
            model:
                env("LLM_MODEL") ??
                str(fileLLM.model) ??
                DEFAULTS.llm.model,
            temperature: num(
                env("LLM_TEMPERATURE") ?? fileLLM.temperature,
                DEFAULTS.llm.temperature,
            ),
            maxTokens: num(
                env("LLM_MAX_TOKENS") ?? fileLLM.max_tokens ?? fileLLM.maxTokens,
                DEFAULTS.llm.maxTokens,
            ),
        },
        persona: {
            name: str(filePersona.name) ?? DEFAULTS.persona.name,
            description: str(filePersona.description) ?? DEFAULTS.persona.description,
        },
        telegram: {
            mode:
                (env("TG_MODE") as "bot" | "userbot") ??
                (str(fileTG.mode) as "bot" | "userbot") ??
                DEFAULTS.telegram.mode,
            botToken:
                env("TG_BOT_TOKEN") ??
                str(fileTG.bot_token) ?? str(fileTG.botToken) ??
                DEFAULTS.telegram.botToken,
            apiId:
                env("TG_API_ID") ??
                str(fileTG.api_id) ?? str(fileTG.apiId) ??
                DEFAULTS.telegram.apiId,
            apiHash:
                env("TG_API_HASH") ??
                str(fileTG.api_hash) ?? str(fileTG.apiHash) ??
                DEFAULTS.telegram.apiHash,
            phone:
                env("TG_PHONE") ??
                str(fileTG.phone) ??
                DEFAULTS.telegram.phone,
        },
    };

    // 将 Telegram 配置注入 process.env，供 sandbox 中的代码使用
    injectEnv("TG_API_ID", config.telegram.apiId);
    injectEnv("TG_API_HASH", config.telegram.apiHash);
    injectEnv("TG_BOT_TOKEN", config.telegram.botToken);
    injectEnv("TG_PHONE", config.telegram.phone);

    _cached = config;
    return config;
}

/**
 * 获取 LLM 配置（向后兼容）
 */
export function loadLLMConfig(configPath?: string): LLMConfig {
    return loadConfig(configPath).llm;
}

/**
 * 清除配置缓存（用于测试）
 */
export function clearConfigCache(): void {
    _cached = null;
}

// ─── 辅助函数 ───

function env(key: string): string | undefined {
    const val = process.env[key];
    return val && val.trim() !== "" ? val : undefined;
}

function str(val: unknown): string | undefined {
    if (val === undefined || val === null || val === "") return undefined;
    return String(val);
}

function num(val: unknown, fallback: number): number {
    if (val === undefined || val === null) return fallback;
    const n = Number(val);
    return isNaN(n) ? fallback : n;
}

function injectEnv(key: string, value: string): void {
    if (value && !process.env[key]) {
        process.env[key] = value;
    }
}
