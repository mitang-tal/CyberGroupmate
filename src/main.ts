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
import { loadLLMConfig, LLMConfig, ChatMessage } from "./llm.js";
import {
    readFileSync,
    writeFileSync,
    existsSync,
    mkdirSync,
    appendFileSync,
} from "node:fs";
import { join } from "node:path";

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
function loadSystemPrompt(configPath?: string): string {
    const promptPath = "system-prompt.md";
    if (!existsSync(promptPath)) {
        return "You are a helpful AI assistant running in a CodeAct environment.";
    }

    let prompt = readFileSync(promptPath, "utf-8");

    // 尝试从配置文件读取 persona
    const cfgPath = configPath ?? "config.yaml";
    if (existsSync(cfgPath)) {
        try {
            const config = readFileSync(cfgPath, "utf-8");
            // 简单提取 persona.description
            const descMatch = config.match(
                /persona:\s*\n\s+description:\s*\|?\s*\n((?:\s{4,}.+\n?)*)/
            );
            if (descMatch) {
                const persona = descMatch[1]
                    .split("\n")
                    .map((l) => l.trim())
                    .filter(Boolean)
                    .join("\n");
                prompt = prompt.replace("{{PERSONA}}", persona);
            }
        } catch {
            // 配置文件解析失败
        }
    }

    // 如果没有替换成功，移除占位符
    prompt = prompt.replace("{{PERSONA}}", "");

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
function buildBootstrapPrompt(homeTypeDefs: string): string {
    return `# Bootstrap 初始化

你刚被启动。你需要完成以下初始化步骤：

1. **连接 Telegram**：使用环境变量中的配置创建 TelegramClient 并连接
   - Bot 模式：使用 \`process.env.TG_BOT_TOKEN\`
   - API ID/Hash：\`process.env.TG_API_ID\`, \`process.env.TG_API_HASH\`
   - 将 client 保存到 \`ctx.tg\`

2. **设置消息监听**：使用 \`runtime.spawn()\` 创建后台任务监听新消息
   - 监听对你的 @mention 和私聊消息
   - 通过 \`runtime.notify()\` 将收到的消息推送到通知中心
   - 事件格式：\`{ type: "telegram.message", chatId, chatTitle, fromUser, text, messageId, mentioned, isPrivate }\`

3. **确认自身信息**：调用 \`getMe()\` 确认你的身份

完成所有步骤后，输出 "BOOTSTRAP_COMPLETE" 表示初始化完成。

---

**当前可用的类型定义（Home 场景）：**

\`\`\`typescript
${homeTypeDefs}
\`\`\`

开始吧。先进入 telegram 场景查看可用的 API。`;
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
    systemPrompt: string
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
            console.log("[Bootstrap] 重放成功！");
            return;
        } catch (err: unknown) {
            const errorMsg =
                err instanceof Error ? err.message : String(err);
            console.log(`[Bootstrap] 重放失败 (${errorMsg})，回退到 LLM bootstrap`);
        }
    }

    // 完整 LLM bootstrap
    console.log("[Bootstrap] 运行 LLM bootstrap...");

    const homeScene = sceneManager.getScene("home");
    const homeTypeDefs = homeScene?.typeDefs ?? "";

    const bootstrapMessages: ChatMessage[] = [
        { role: "system", content: systemPrompt },
        { role: "user", content: buildBootstrapPrompt(homeTypeDefs) },
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
        console.log(
            `[Bootstrap] 保存了 ${successfulCodes.length} 段 bootstrap 代码`
        );
    }

    console.log(
        `[Bootstrap] 完成 (${result.turns.length} turns, reason: ${result.endReason})`
    );
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
    systemPrompt: string
): Promise<void> {
    console.log("[Main Loop] 进入主事件循环");

    while (true) {
        // ─── 等待事件 ───
        const events = await nc.drain(DRAIN_TIMEOUT, DRAIN_MAX_BATCH);

        if (events.length === 0) {
            // 超时无事件 — 可选 idle 行为（MVP 中跳过）
            continue;
        }

        console.log(`[Main Loop] 收到 ${events.length} 个新事件`);

        // ─── 检查 sandbox 健康 ───
        if (!sandbox.isAlive()) {
            console.log("[Main Loop] Sandbox 已退出，尝试重启...");
            try {
                await sandbox.start();
                await runBootstrap(
                    sandbox,
                    nc,
                    sceneManager,
                    llmConfig,
                    systemPrompt
                );
                console.log("[Main Loop] Sandbox 重启完成");
            } catch (err: unknown) {
                const errorMsg =
                    err instanceof Error ? err.message : String(err);
                console.error(`[Main Loop] Sandbox 重启失败: ${errorMsg}`);
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

            console.log(
                `[Main Loop] Session ${result.sessionId} 完成 ` +
                `(${result.turns.length} turns, reason: ${result.endReason})`
            );

            // ─── Session Compaction ───
            try {
                // 尝试从事件中提取 chatId 和 chatTitle
                const firstEvent = events[0] as Record<string, unknown>;
                const chatId = firstEvent?.chatId as string | undefined;
                const chatTitle = firstEvent?.chatTitle as string | undefined;
                await runCompaction(result, memory, llmConfig, chatId, chatTitle);
            } catch (compErr: unknown) {
                const compErrMsg = compErr instanceof Error ? compErr.message : String(compErr);
                console.error(`[Main Loop] Compaction 失败: ${compErrMsg}`);
            }
        } catch (err: unknown) {
            const errorMsg =
                err instanceof Error ? err.message : String(err);
            console.error(`[Main Loop] Session 异常: ${errorMsg}`);

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
    console.log("🤖 CyberGroupmate starting...");

    // ─── 初始化 ───
    ensureDataDirs();

    const llmConfig = loadLLMConfig();
    console.log(
        `[Config] LLM: ${llmConfig.provider} / ${llmConfig.model} @ ${llmConfig.baseUrl}`
    );

    const systemPrompt = loadSystemPrompt();
    const nc = new NotificationCenter(EVENTS_PATH);
    const sandbox = new Sandbox();
    const memory = new MemoryStore(join(DATA_DIR, "memory.db"));
    const sceneManager = new SceneManager();
    registerBuiltinScenes(sceneManager);

    console.log("[Init] 组件初始化完成");

    // ─── 连接 sandbox notify 事件到 NC ───
    sandbox.on("notify", (event: Record<string, unknown>) => {
        nc.push(event as { type: string;[key: string]: unknown });
    });

    sandbox.on("stderr", (data: string) => {
        // Worker 的 stderr 输出记录到事件日志
        if (data.trim()) {
            console.error(`[Sandbox stderr] ${data.trim()}`);
        }
    });

    // ─── 启动 sandbox ───
    console.log("[Init] 启动 Sandbox...");
    await sandbox.start();
    console.log("[Init] Sandbox 就绪");

    // ─── Bootstrap ───
    await runBootstrap(
        sandbox,
        nc,
        sceneManager,
        llmConfig,
        systemPrompt
    );

    // ─── 主循环 ───
    await mainEventLoop(
        sandbox,
        nc,
        sceneManager,
        memory,
        llmConfig,
        systemPrompt
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

// 运行
main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
