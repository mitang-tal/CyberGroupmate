/**
 * config.ts — 统一配置管理器
 *
 * 从 config.yaml 加载配置，支持环境变量覆盖。
 *
 * LLM 配置使用 Profile 体系：
 *   llm_profiles: 定义多个命名 LLM 配置
 *   model_tiers: cheap/mid/sota 引用 profile 名称
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
    /** Gemini thinking level: "none" | "low" | "medium" | "high" */
    thinkingLevel?: string;
}

/** 模型层级 — tier name → profile name */
export interface ModelTiersConfig {
    cheap: string;
    mid: string;
    sota: string;
    [key: string]: string;
}

export interface PersonaConfig {
    name: string;
    description: string;
}

export interface NotificationConfig {
    urgentWords: string[];
}

export interface TelegramConfig {
    mode: "bot" | "userbot";
    botToken: string;
    apiId: string;
    apiHash: string;
    phone: string;
}

export interface AppConfig {
    llmProfiles: Record<string, LLMConfig>;
    modelTiers: ModelTiersConfig;
    persona: PersonaConfig;
    telegram: TelegramConfig;
    notification: NotificationConfig;
}

// ─── 默认值 ───

const DEFAULT_LLM: LLMConfig = {
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    model: "gpt-4o",
    temperature: 0.7,
    maxTokens: 4096,
};

// ─── 配置加载 ───

let _cached: AppConfig | null = null;

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

    // ─── LLM Profiles ───
    const llmProfiles: Record<string, LLMConfig> = {};
    const fileProfiles = (fileConfig.llm_profiles ?? {}) as Record<string, Record<string, unknown>>;

    for (const [name, raw] of Object.entries(fileProfiles)) {
        llmProfiles[name] = parseLLMProfile(raw);
    }

    // 环境变量覆盖 → 注入到第一个 profile 或创建 "default"
    const envOverride = buildEnvOverride();
    if (envOverride) {
        const firstName = Object.keys(llmProfiles)[0];
        if (firstName) {
            Object.assign(llmProfiles[firstName], envOverride);
        } else {
            llmProfiles["default"] = { ...DEFAULT_LLM, ...envOverride };
        }
    }

    if (Object.keys(llmProfiles).length === 0) {
        llmProfiles["default"] = { ...DEFAULT_LLM };
    }

    // ─── Model Tiers ───
    const fileTiers = (fileConfig.model_tiers ?? {}) as Record<string, unknown>;
    const firstProfile = Object.keys(llmProfiles)[0];

    const modelTiers: ModelTiersConfig = {
        cheap: str(fileTiers.cheap) ?? firstProfile,
        mid: str(fileTiers.mid) ?? firstProfile,
        sota: str(fileTiers.sota) ?? firstProfile,
    };
    for (const [k, v] of Object.entries(fileTiers)) {
        if (!["cheap", "mid", "sota"].includes(k) && typeof v === "string") {
            modelTiers[k] = v;
        }
    }

    // ─── 其他配置 ───
    const filePersona = (fileConfig.persona ?? {}) as Record<string, unknown>;
    const fileTG = (fileConfig.telegram ?? {}) as Record<string, unknown>;
    const fileNotification = (fileConfig.notification ?? {}) as Record<string, unknown>;

    const config: AppConfig = {
        llmProfiles,
        modelTiers,
        persona: {
            name: str(filePersona.name) ?? "赛博群友",
            description: str(filePersona.description) ?? "",
        },
        telegram: {
            mode: (env("TG_MODE") as "bot" | "userbot") ?? (str(fileTG.mode) as "bot" | "userbot") ?? "bot",
            botToken: env("TG_BOT_TOKEN") ?? str(fileTG.bot_token) ?? "",
            apiId: env("TG_API_ID") ?? str(fileTG.api_id) ?? "",
            apiHash: env("TG_API_HASH") ?? str(fileTG.api_hash) ?? "",
            phone: env("TG_PHONE") ?? str(fileTG.phone) ?? "",
        },
        notification: {
            urgentWords: Array.isArray(fileNotification.urgent_words)
                ? (fileNotification.urgent_words as string[])
                : ["?", "？", "呢", "吗"],
        },
    };

    injectEnv("TG_API_ID", config.telegram.apiId);
    injectEnv("TG_API_HASH", config.telegram.apiHash);
    injectEnv("TG_BOT_TOKEN", config.telegram.botToken);
    injectEnv("TG_PHONE", config.telegram.phone);

    _cached = config;
    return config;
}

/** 根据 profile 名称获取 LLMConfig */
export function resolveLLMProfile(profileName: string, config?: AppConfig): LLMConfig {
    const cfg = config ?? loadConfig();
    const profile = cfg.llmProfiles[profileName];
    if (!profile) {
        const fallback = Object.keys(cfg.llmProfiles)[0];
        console.warn(`[Config] LLM profile "${profileName}" not found, using "${fallback}"`);
        return cfg.llmProfiles[fallback] ?? DEFAULT_LLM;
    }
    return profile;
}

/** 根据 tier 名称获取 LLMConfig */
export function resolveTierProfile(tier: string, config?: AppConfig): LLMConfig {
    const cfg = config ?? loadConfig();
    const profileName = cfg.modelTiers[tier];
    if (!profileName) {
        const fallback = Object.keys(cfg.llmProfiles)[0];
        console.warn(`[Config] tier "${tier}" not configured, using profile "${fallback}"`);
        return cfg.llmProfiles[fallback] ?? DEFAULT_LLM;
    }
    return resolveLLMProfile(profileName, cfg);
}

export function clearConfigCache(): void {
    _cached = null;
}

// ─── 内部辅助 ───

function parseLLMProfile(raw: Record<string, unknown>): LLMConfig {
    return {
        provider: (str(raw.provider) as "anthropic" | "openai") ?? DEFAULT_LLM.provider,
        baseUrl: str(raw.base_url) ?? DEFAULT_LLM.baseUrl,
        apiKey: str(raw.api_key) ?? DEFAULT_LLM.apiKey,
        model: str(raw.model) ?? DEFAULT_LLM.model,
        temperature: num(raw.temperature, DEFAULT_LLM.temperature),
        maxTokens: num(raw.max_tokens, DEFAULT_LLM.maxTokens),
        thinkingLevel: str(raw.thinking_level),
    };
}

function buildEnvOverride(): Partial<LLMConfig> | null {
    const parts: Partial<LLMConfig> = {};
    let has = false;
    const set = (k: keyof LLMConfig, v: string | number) => { (parts as any)[k] = v; has = true; };

    const p = env("LLM_PROVIDER"); if (p) set("provider", p);
    const u = env("LLM_BASE_URL"); if (u) set("baseUrl", u);
    const k = env("LLM_API_KEY");  if (k) set("apiKey", k);
    const m = env("LLM_MODEL");    if (m) set("model", m);
    const t = env("LLM_TEMPERATURE"); if (t) set("temperature", Number(t));
    const mt = env("LLM_MAX_TOKENS"); if (mt) set("maxTokens", Number(mt));

    return has ? parts : null;
}

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
