/**
 * main.ts — Orchestrator / Agent Main Loop
 *
 * 系统入口点。管理 agent 的完整生命周期：
 * Bootstrap(初始化) → Main Event Loop(事件处理) → Compaction(压缩归档)
 *
 * 在整体架构中的位置：
 * - 创建并连接所有核心组件（NC, Sandbox, Memory, SceneManager）
 * - 运行 bootstrap 流程让 agent 自主初始化
 * - 主循环中 drain 事件 → 组装 context → 运行 CodeAct session
 */

import { NotificationCenter } from "./notification-center.js";
import { Sandbox } from "./sandbox.js";
import { MemoryStore } from "./memory.js";
import { SceneManager } from "./scene-manager.js";
import { registerBuiltinScenes } from "./scenes/index.js";
import { runCodeActSession, SessionResult } from "./session-runner.js";
import { runCompaction } from "./compaction.js";
import { loadConfig, AppConfig } from "./config.js";
import { callLLM, ChatMessage } from "./llm.js";
import type { LLMConfig } from "./config.js";
import {
    readFileSync,
    writeFileSync,
    existsSync,
    mkdirSync,
    appendFileSync,
} from "node:fs";
import { join } from "node:path";
import { createLogger } from "./logger.js";

const log = createLogger("main");

// ─── 常量 ───

/** 数据目录 */
const DATA_DIR = "data";

/** 事件日志路径 */
const EVENTS_PATH = join(DATA_DIR, "events.jsonl");

/** Agent 状态文件路径 */
const AGENT_STATE_PATH = join(DATA_DIR, "agent-state.md");

/** Bootstrap 代码保存路径 */
const BOOTSTRAP_CODE_PATH = join(DATA_DIR, "bootstrap-code.json");

/** Session transcript 目录 */
const SESSIONS_DIR = join(DATA_DIR, "sessions");

/** drain 等待超时（毫秒） */
const DRAIN_TIMEOUT = 30000;

/** drain 最大批量 */
const DRAIN_MAX_BATCH = 20;

/** Agent state 最大字符数 */
const MAX_AGENT_STATE_CHARS = 4000;

/** 事件预览最大字符数 */
const MAX_EVENT_PREVIEW_CHARS = 300;

// ─── 辅助函数 ───

/**
 * 确保数据目录结构存在
 */
function ensureDataDirs(): void {
    const dirs = [
        DATA_DIR,
        join(DATA_DIR, "tg-session"),
        SESSIONS_DIR,
    ];
    for (const dir of dirs) {
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
    }
}

/**
 * 读取 system prompt 模板并注入 persona 配置
 */
function loadSystemPrompt(appConfig: AppConfig): string {
    const promptPath = "system-prompt.md";
    if (!existsSync(promptPath)) {
        return "You are a helpful AI assistant running in a CodeAct environment.";
    }

    let prompt = readFileSync(promptPath, "utf-8");

    // 从配置中注入 persona
    const persona = appConfig.persona.description || "";
    prompt = prompt.replace("{{PERSONA}}", persona);

    return prompt;
}

/**
 * 读取 agent state（如果存在）
 */
function loadAgentState(): string {
    if (!existsSync(AGENT_STATE_PATH)) {
        return "（agent 刚启动，暂无状态记录）";
    }
    const state = readFileSync(AGENT_STATE_PATH, "utf-8");
    if (state.length > MAX_AGENT_STATE_CHARS) {
        return (
            state.slice(0, MAX_AGENT_STATE_CHARS) +
            "\n...[truncated]"
        );
    }
    return state;
}

/**
 * 格式化事件列表为文本
 */
function formatEvents(events: Array<Record<string, unknown>>): string {
    if (events.length === 0) return "（无新事件）";

    return events
        .map((e, i) => {
            const preview = JSON.stringify(e).slice(0, MAX_EVENT_PREVIEW_CHARS);
            return `[事件 ${i + 1}] ${e.type ?? "unknown"}: ${preview}`;
        })
        .join("\n\n");
}

/**
 * 保存成功执行的 bootstrap 代码
 */
function saveBootstrapCode(codes: string[]): void {
    writeFileSync(BOOTSTRAP_CODE_PATH, JSON.stringify(codes, null, 2), "utf-8");
}

/**
 * 加载保存的 bootstrap 代码
 */
function loadBootstrapCode(): string[] | null {
    if (!existsSync(BOOTSTRAP_CODE_PATH)) return null;
    try {
        return JSON.parse(readFileSync(BOOTSTRAP_CODE_PATH, "utf-8"));
    } catch {
        return null;
    }
}

// ─── Bootstrap ───

/**
 * Bootstrap prompt — 告诉 agent 需要初始化什么
 */
function buildBootstrapPrompt(homeTypeDefs: string, appConfig: AppConfig): string {
    const tgMode = appConfig.telegram.mode;
    const hasPhone = !!appConfig.telegram.phone;
    const hasBotToken = !!appConfig.telegram.botToken;

    return `# Bootstrap 初始化

你刚被启动。请完成 Telegram 连接。

## 执行环境

- 代码通过 \`new Function()\` 执行，**不能用 \`import\` 或 \`require\`**
- 导入模块必须用 \`await import("模块名")\`
- \`ctx\` 是跨代码块的持久化对象，用来保存 tg client 等
- \`runtime.notify(event)\` 推送事件到通知中心
- \`docs.read("mtcute")\` 查看 mtcute 使用指南（**必读**）
- \`docs.list()\` 查看所有可用文档

## 你的任务

1. **先读文档**：执行 \`console.log(docs.read("mtcute"))\` 了解 mtcute 用法
2. **连接 Telegram**：当前模式是 **${tgMode}**
${tgMode === "bot"
            ? `   - Bot Token: ${hasBotToken ? "✓ 已配置 (process.env.TG_BOT_TOKEN)" : "✗ 未配置"}`
            : `   - 手机号: ${hasPhone ? "✓ 已配置 (process.env.TG_PHONE)" : "✗ 未配置"}`
        }
   - API ID/Hash: ✓ 已配置 (process.env.TG_API_ID, process.env.TG_API_HASH)
   - Session 路径: \`data/tg-session/account\`（持久化，重启不需要重新登录）
3. **确认身份**：输出你的名字和 ID
4. **完成**：输出 "BOOTSTRAP_COMPLETE"

---

**Home 场景类型定义：**

\`\`\`typescript
${homeTypeDefs}
\`\`\`

开始吧。第一步先执行 \`console.log(docs.read("mtcute"))\` 看文档。`;
}

/**
 * 运行 bootstrap 流程
 *
 * 先尝试重放保存的 bootstrap 代码。如果失败，则运行完整 LLM bootstrap。
 */
async function runBootstrap(
    sandbox: Sandbox,
    nc: NotificationCenter,
    sceneManager: SceneManager,
    llmConfig: LLMConfig,
    systemPrompt: string,
    appConfig: AppConfig
): Promise<void> {
    // 尝试重放保存的 bootstrap 代码
    const savedCodes = loadBootstrapCode();
    if (savedCodes && savedCodes.length > 0) {
        console.log("[Bootstrap] 尝试重放保存的 bootstrap 代码...");
        try {
            for (const code of savedCodes) {
                const result = await sandbox.execute(code, 30000);
                if (result.error) {
                    throw new Error(
                        `Bootstrap replay failed: ${result.output}`
                    );
                }
            }
            log.info("重放成功");
            return;
        } catch (err: unknown) {
            const errorMsg =
                err instanceof Error ? err.message : String(err);
            log.warn("重放失败，回退到 LLM bootstrap", { error: errorMsg });
        }
    }

    // 完整 LLM bootstrap
    log.info("运行 LLM bootstrap...");

    const homeScene = sceneManager.getScene("home");
    const homeTypeDefs = homeScene?.typeDefs ?? "";

    const bootstrapMessages: ChatMessage[] = [
        { role: "system", content: systemPrompt },
        { role: "user", content: buildBootstrapPrompt(homeTypeDefs, appConfig) },
    ];

    const result = await runCodeActSession(
        bootstrapMessages,
        sandbox,
        nc,
        llmConfig,
        SESSIONS_DIR
    );

    // 提取所有成功执行的代码块
    const successfulCodes: string[] = [];
    for (const turn of result.turns) {
        for (let i = 0; i < turn.codeBlocks.length; i++) {
            const execResult = turn.executionResults[i];
            if (execResult && !execResult.error) {
                successfulCodes.push(turn.codeBlocks[i]);
            }
        }
    }

    // 保存成功的 bootstrap 代码
    if (successfulCodes.length > 0) {
        saveBootstrapCode(successfulCodes);
        log.info(`保存了 ${successfulCodes.length} 段 bootstrap 代码`);
    }

    if (result.endReason === "error") {
        log.error("Bootstrap 失败", { error: result.error, turns: result.turns.length });
    } else {
        log.info("Bootstrap 完成", { turns: result.turns.length, reason: result.endReason });
    }
}

// ─── Main Event Loop ───

/**
 * 主事件循环
 */
async function mainEventLoop(
    sandbox: Sandbox,
    nc: NotificationCenter,
    sceneManager: SceneManager,
    memory: MemoryStore,
    llmConfig: LLMConfig,
    systemPrompt: string,
    appConfig: AppConfig
): Promise<void> {
    log.info("进入主事件循环");

    while (true) {
        // ─── 等待事件 ───
        const events = await nc.drain(DRAIN_TIMEOUT, DRAIN_MAX_BATCH);

        if (events.length === 0) {
            // 超时无事件 — 可选 idle 行为（MVP 中跳过）
            continue;
        }

        log.info(`收到 ${events.length} 个新事件`);

        // ─── 检查 sandbox 健康 ───
        if (!sandbox.isAlive()) {
            log.warn("Sandbox 已退出，尝试重启...");
            try {
                await sandbox.start();
                await runBootstrap(
                    sandbox,
                    nc,
                    sceneManager,
                    llmConfig,
                    systemPrompt,
                    appConfig
                );
                log.info("Sandbox 重启完成");
            } catch (err: unknown) {
                const errorMsg =
                    err instanceof Error ? err.message : String(err);
                log.error("Sandbox 重启失败", { error: errorMsg });
                // 将事件推回队列
                for (const event of events) {
                    nc.push(event);
                }
                await new Promise((r) => setTimeout(r, 5000));
                continue;
            }
        }

        // ─── 组装 context ───
        const agentState = loadAgentState();
        const eventText = formatEvents(events);
        const homeScene = sceneManager.getScene("home");
        const homeTypeDefs = homeScene?.typeDefs ?? "";

        const contextMessage = `# 当前状态

## Agent State
${agentState}

## 当前场景
${sceneManager.current} — 类型定义如下：

\`\`\`typescript
${homeTypeDefs}
\`\`\`

## 新到达的事件 (${events.length} 条)

${eventText}

---

请处理以上事件。你可以切换场景来使用不同的 API。处理完毕后不要输出代码块即可。`;

        const sessionMessages: ChatMessage[] = [
            { role: "system", content: systemPrompt },
            { role: "user", content: contextMessage },
        ];

        // ─── 运行 CodeAct session ───
        try {
            const result = await runCodeActSession(
                sessionMessages,
                sandbox,
                nc,
                llmConfig,
                SESSIONS_DIR
            );

            if (result.endReason === "error") {
                log.error(`Session ${result.sessionId} 失败`, {
                    error: result.error,
                    turns: result.turns.length,
                });
            } else {
                log.info(`Session ${result.sessionId} 完成`, {
                    turns: result.turns.length,
                    reason: result.endReason,
                });
            }

            // ─── Session Compaction ───
            try {
                // 尝试从事件中提取 chatId 和 chatTitle
                const firstEvent = events[0] as Record<string, unknown>;
                const chatId = firstEvent?.chatId as string | undefined;
                const chatTitle = firstEvent?.chatTitle as string | undefined;
                await runCompaction(result, memory, llmConfig, chatId, chatTitle);
            } catch (compErr: unknown) {
                const compErrMsg = compErr instanceof Error ? compErr.message : String(compErr);
                log.error("Compaction 失败", { error: compErrMsg });
            }
        } catch (err: unknown) {
            const errorMsg =
                err instanceof Error ? err.message : String(err);
            log.error("Session 异常", { error: errorMsg });

            // 记录错误事件
            nc.push({
                type: "system.session_error",
                error: errorMsg,
            });
        }
    }
}

// ─── 入口 ───

/**
 * 主入口函数
 */
async function main(): Promise<void> {
    log.info("🤖 CyberGroupmate starting...");

    // ─── 初始化 ───
    ensureDataDirs();

    const appConfig = loadConfig();
    const llmConfig = appConfig.llm;
    log.info("LLM 配置加载完成", {
        provider: llmConfig.provider,
        model: llmConfig.model,
        baseUrl: llmConfig.baseUrl,
    });
    log.info("Telegram 配置", {
        mode: appConfig.telegram.mode,
        apiId: appConfig.telegram.apiId ? "✓" : "✗",
        apiHash: appConfig.telegram.apiHash ? "✓" : "✗",
        botToken: appConfig.telegram.botToken ? "✓" : "✗",
    });

    const systemPrompt = loadSystemPrompt(appConfig);
    const nc = new NotificationCenter(EVENTS_PATH);
    const sandbox = new Sandbox();
    const memory = new MemoryStore(join(DATA_DIR, "memory.db"));
    const sceneManager = new SceneManager();
    registerBuiltinScenes(sceneManager);

    log.info("组件初始化完成");

    // ─── 连接 sandbox notify 事件到 NC ───
    sandbox.on("notify", (event: Record<string, unknown>) => {
        nc.push(event as { type: string;[key: string]: unknown });
    });

    sandbox.on("stderr", (data: string) => {
        if (data.trim()) {
            log.warn("Sandbox stderr", { output: data.trim() });
        }
    });

    // ─── 启动 sandbox ───
    log.info("启动 Sandbox...");
    await sandbox.start();
    log.info("Sandbox 就绪");

    // ─── Bootstrap ───
    await runBootstrap(
        sandbox,
        nc,
        sceneManager,
        llmConfig,
        systemPrompt,
        appConfig
    );

    // ─── 主循环 ───
    await mainEventLoop(
        sandbox,
        nc,
        sceneManager,
        memory,
        llmConfig,
        systemPrompt,
        appConfig
    );
}

// ─── Graceful shutdown ───
process.on("SIGINT", () => {
    console.log("\n🛑 Shutting down...");
    process.exit(0);
});

process.on("SIGTERM", () => {
    console.log("\n🛑 Shutting down...");
    process.exit(0);
});

main().catch((err) => {
    log.error("Fatal error", { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
});
