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

import { NotificationCenter } from "./event/notification-center.js";
import { Sandbox } from "./sandbox/sandbox.js";
import { MemoryStoreV2 } from "./memory-v2/index.js";
import { SceneManager } from "./scenes/scene-manager.js";
import { registerBuiltinScenes } from "./scenes/index.js";
import { runCodeActSession, SessionResult } from "./sandbox/session-runner.js";
import { runCompaction } from "./event/compaction.js";
import { loadConfig, resolveTierProfile, type AppConfig, type LLMConfig } from "./core/config.js";
import { callLLM, ChatMessage } from "./core/llm.js";
import { shouldCompact, compact, mergeContextBudget } from "./memory-v2/context-manager.js";
import {
    TopicRegistry,
    RecordingPipeline,
    FastRouter,
    EngagedTopicHandler,
    ModelRouter,
    ReplyPipeline,
    FeedbackLoop,
    type ReplyTask,
    type AgentMessageSentEvent,
} from "./pipeline/index.js";
import {
    readFileSync,
    writeFileSync,
    existsSync,
    mkdirSync,
    appendFileSync,
} from "node:fs";
import { join } from "node:path";
import { createLogger } from "./core/logger.js";

const log = createLogger("main");

// ─── 常量 ───

/** 数据目录 */
const DATA_DIR = "workspace";

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

/** drain 批量窗口（毫秒） */
const DRAIN_BATCH_WINDOW = 60000;

/** Agent state 最大字符数 */
const MAX_AGENT_STATE_CHARS = 4000;

/** 事件预览最大字符数 */
const MAX_EVENT_PREVIEW_CHARS = 300;

/** Reply task 事件类型 */
const REPLY_TASK_EVENT_TYPE = "system.reply_task";

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
    const promptPath = join(DATA_DIR, "agent-docs", "system-prompt.md");
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

function isReplyTaskEvent(event: Record<string, unknown>): event is Record<string, unknown> & { task: ReplyTask } {
    return event.type === REPLY_TASK_EVENT_TYPE && !!event.task;
}

function serializeTopic(topic: ReturnType<TopicRegistry["get"]>): Record<string, unknown> | null {
    if (!topic) return null;
    return {
        ...topic,
        participantIds: [...topic.participantIds].map(String),
        messageIds: topic.messageIds.map(String),
        pendingMessages: topic.pendingMessages.map(msg => ({
            ...msg,
            id: String(msg.id),
            chatId: String(msg.chatId),
            senderId: String(msg.senderId),
            replyToMessageId: msg.replyToMessageId ? String(msg.replyToMessageId) : undefined,
        })),
    };
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
    const promptPath = join(DATA_DIR, "agent-docs", "bootstrap-prompt.md");
    let promptTemplate = "";

    if (existsSync(promptPath)) {
        promptTemplate = readFileSync(promptPath, "utf-8");
    } else {
        // Fallback or error if not found, but we expect it to exist
        promptTemplate = `# Bootstrap 初始化\n\n请连接 Telegram。\n\n{{HOME_TYPE_DEFS}}`;
    }

    const tgMode = appConfig.telegram.mode;
    const hasPhone = !!appConfig.telegram.phone;
    const hasBotToken = !!appConfig.telegram.botToken;

    const tgAuthStatus = tgMode === "bot"
        ? `Bot Token: ${hasBotToken ? "✓ 已配置 (process.env.TG_BOT_TOKEN)" : "✗ 未配置"}`
        : `手机号: ${hasPhone ? "✓ 已配置 (process.env.TG_PHONE)" : "✗ 未配置"}`;

    return promptTemplate
        .replace("{{TG_MODE}}", tgMode)
        .replace("{{TG_AUTH_STATUS}}", tgAuthStatus)
        .replace("{{HOME_TYPE_DEFS}}", homeTypeDefs);
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

    while (true) {
        const bootstrapMessages: ChatMessage[] = [
            { role: "system", content: systemPrompt },
            { role: "user", content: buildBootstrapPrompt(homeTypeDefs, appConfig) },
        ];

        const result = await runCodeActSession(
            bootstrapMessages,
            "home",
            sandbox,
            nc,
            llmConfig,
            SESSIONS_DIR,
            5 * 60 * 1000  // 5 分钟超时（等验证码可能需要更长时间）
        );

        // 提取所有成功执行的代码块
        const successfulCodes: string[] = [];
        let hasCompleteSignal = false;

        for (const turn of result.turns) {
            for (let i = 0; i < turn.codeBlocks.length; i++) {
                const execResult = turn.executionResults[i];
                if (execResult && !execResult.error) {
                    successfulCodes.push(turn.codeBlocks[i]);
                    if (execResult.output && execResult.output.includes("BOOTSTRAP_COMPLETE")) {
                        hasCompleteSignal = true;
                    }
                }
            }
        }

        if (hasCompleteSignal) {
            // 保存成功的 bootstrap 代码
            if (successfulCodes.length > 0) {
                saveBootstrapCode(successfulCodes);
                log.info(`保存了 ${successfulCodes.length} 段 bootstrap 代码`);
            }
            log.info("Bootstrap 完成", { turns: result.turns.length, reason: result.endReason });
            break;
        } else {
            log.warn("未收到 BOOTSTRAP_COMPLETE 信号，视为 Bootstrap 失败，不保存并重试", { reason: result.endReason });
            // 等待一小段时间后重试，避免死循环请求崩溃
            await new Promise(r => setTimeout(r, 3000));
        }
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
    memory: MemoryStoreV2,
    llmConfig: LLMConfig,
    cheapConfig: LLMConfig,
    systemPrompt: string,
    appConfig: AppConfig,
    fastRouter?: FastRouter,
    topicRegistry?: TopicRegistry,
    replyPipeline?: ReplyPipeline,
    feedbackLoop?: FeedbackLoop,
): Promise<void> {
    log.info("进入主事件循环");

    // ─── Phase 6: 定时清理计时器 ───
    if (topicRegistry) {
        setInterval(() => topicRegistry.cleanup(), 60_000);
    }

    // ─── Phase M2.4: Reflection 冷场触发 + 最大间隔触发 + 作息触发 ───
    const reflectionCfg = appConfig.reflection ?? {};
    const silenceThreshold = reflectionCfg.silenceThreshold ?? 7200; // 默认 2h
    const maxInterval = reflectionCfg.maxInterval ?? 86400; // 默认 24h
    const awakeHours = reflectionCfg.awakeHours; // e.g. [8, 24]
    const agentTimezone = reflectionCfg.timezone; // e.g. "Asia/Shanghai"
    const checkInterval = (reflectionCfg.checkInterval ?? 300) * 1000; // 默认 5min → ms
    const lastActivityPerChat = new Map<string, number>();
    const lastReflectedAtMap = new Map<string, number>();
    const reflectionInProgress = new Set<string>();

    /** 判断当前时间是否在 awake_hours 之外（即"睡眠时间"） */
    function isOutsideAwakeHours(): boolean {
        if (!awakeHours) return false;
        const [start, end] = awakeHours;
        let currentHour: number;
        if (agentTimezone) {
            try {
                const formatter = new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: agentTimezone });
                currentHour = parseInt(formatter.format(new Date()), 10);
            } catch {
                currentHour = new Date().getHours();
            }
        } else {
            currentHour = new Date().getHours();
        }
        // e.g. awakeHours = [8, 24] → 在 0-7 时段外
        if (start <= end) {
            return currentHour < start || currentHour >= end;
        }
        // 跨午夜 e.g. [22, 6] → 在 6-21 时段外
        return currentHour >= end && currentHour < start;
    }

    setInterval(async () => {
        const now = Date.now();
        for (const [chatId, lastActive] of lastActivityPerChat) {
            if (reflectionInProgress.has(chatId)) continue;

            const silentSec = (now - lastActive) / 1000;
            const lastReflected = lastReflectedAtMap.get(chatId) ?? 0;
            const sinceReflectionSec = lastReflected > 0 ? (now - lastReflected) / 1000 : Infinity;

            const silenceTriggered = silentSec >= silenceThreshold;
            const maxIntervalTriggered = sinceReflectionSec >= maxInterval;
            const scheduleTriggered = isOutsideAwakeHours() && sinceReflectionSec > 3600; // 睡眠时段 + 距上次反思 > 1h

            if (silenceTriggered || maxIntervalTriggered || scheduleTriggered) {
                reflectionInProgress.add(chatId);
                const reason = silenceTriggered ? "冷场触发" : maxIntervalTriggered ? "最大间隔触发" : "作息触发";
                log.info(`${reason} Reflection`, {
                    chatId,
                    ...(silenceTriggered ? { silentSec: Math.floor(silentSec) } : { sinceReflection: Math.floor(sinceReflectionSec) }),
                });
                try {
                    const result = await memory.reflect(chatId, llmConfig, reflectionCfg);
                    lastReflectedAtMap.set(chatId, Date.now());
                    log.info("Reflection 完成", {
                        chatId,
                        period: `${result.reflectedPeriod.from} → ${result.reflectedPeriod.to}`,
                        personUpdates: result.personUpdates.length,
                        newFacts: result.newCoreFacts.length,
                        merged: result.mergedEpisodes,
                    });
                } catch (err) {
                    log.error("Reflection 失败", { chatId, error: String(err) });
                } finally {
                    reflectionInProgress.delete(chatId);
                    if (silenceTriggered) {
                        lastActivityPerChat.delete(chatId); // 冷场触发后重置计时
                    }
                }
            }
        }
    }, checkInterval);

    // ─── 维护唯一的长生命周期 session ───
    const messages: ChatMessage[] = [];

    while (true) {
        // ─── 等待事件 ───
        const events = await nc.drain(
            DRAIN_TIMEOUT,
            DRAIN_MAX_BATCH,
            DRAIN_BATCH_WINDOW,
            appConfig.notification?.urgentWords ?? ["?", "？", "呢", "吗"]
        );

        if (events.length === 0) {
            // 超时无事件 — 可选 idle 行为（MVP 中跳过）
            continue;
        }

        log.info(`收到 ${events.length} 个新事件`);

        // 更新各 chat 的最后活跃时间（用于 Reflection 冷场触发）
        for (const ev of events) {
            const chatId = (ev as any).chatId ?? (ev as any).chat_id;
            if (chatId) lastActivityPerChat.set(String(chatId), Date.now());

            if ((ev as any).type === "system.agent_message_sent" && feedbackLoop) {
                const sentEvent = ev as Record<string, unknown>;
                feedbackLoop.recordAgentMessage({
                    scene: String(sentEvent.scene ?? "telegram"),
                    chatId: String(sentEvent.chatId ?? ""),
                    messageId: sentEvent.messageId ? String(sentEvent.messageId) : undefined,
                    text: String(sentEvent.text ?? ""),
                    timestamp: String(sentEvent.timestamp ?? new Date().toISOString()),
                    replyToMessageId: sentEvent.replyToMessageId ? String(sentEvent.replyToMessageId) : undefined,
                } satisfies AgentMessageSentEvent);

                if (fastRouter && sentEvent.messageId !== undefined) {
                    fastRouter.recordAgentMessage(String(sentEvent.messageId));
                }
            }
        }

        const replyTasks: ReplyTask[] = [];
        const regularEvents = events.filter((event) => !isReplyTaskEvent(event as Record<string, unknown>));

        for (const event of events) {
            if (isReplyTaskEvent(event as Record<string, unknown>)) {
                replyTasks.push((event as Record<string, unknown> & { task: ReplyTask }).task);
            }
        }

        if (fastRouter && replyPipeline) {
            const fastPathMessages = fastRouter.routeEvents(regularEvents);
            replyTasks.push(...replyPipeline.buildDirectTasks(fastPathMessages));

            if (fastPathMessages.length === 0 && replyTasks.length === 0) {
                log.debug("所有消息由 Recording Pipeline 处理，当前无需 CodeAct session");
                continue;
            }

            if (fastPathMessages.length > 0) {
                log.info(`FastRouter: ${fastPathMessages.length} 条 FAST_PATH，${regularEvents.length - fastPathMessages.length} 条进入 Pipeline`);
            }
        } else if (regularEvents.length > 0) {
            replyTasks.push({
                id: `legacy_${Date.now()}`,
                source: "FAST_PATH",
                scene: "home",
                chatId: String((regularEvents[0] as any)?.chatId ?? ""),
                pipelineMode: "FULL_CODEACT",
                modelRoute: { model: llmConfig.model, pipelineMode: "FULL_CODEACT", overrides: {} },
                title: "legacy-event-batch",
                prompt: `[新事件到达] (${regularEvents.length} 条)\n${formatEvents(regularEvents)}\n请处理以上事件。你可以切换场景来使用不同的 API。处理完毕后不要输出代码块即可。`,
                messages: [],
            });
        }

        if (replyTasks.length === 0) {
            continue;
        }

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
                for (const event of events) {
                    nc.push(event);
                }
                await new Promise((r) => setTimeout(r, 5000));
                continue;
            }
        }

        for (const task of replyTasks) {
            let activeScene = sceneManager.current;
            let isFirstTurnOfTask = true;

            while (true) {
                if (messages.length > 0 && messages[0].role === "system") {
                    messages.shift();
                }

                const agentState = loadAgentState();
                const sceneDef = sceneManager.getScene(activeScene);
                const typeDefs = sceneDef?.typeDefs ?? "";
                const currentSystemPrompt = `${systemPrompt}\n\n[System Inject] 当前场景: ${activeScene}\n类型定义:\n\`\`\`typescript\n${typeDefs}\n\`\`\`\nAgent State:\n${agentState}`;

                messages.unshift({ role: "system", content: currentSystemPrompt, scope: "global" });

                if (isFirstTurnOfTask) {
                    messages.push({
                        role: "user",
                        content: task.prompt,
                        scope: "global",
                    });
                    isFirstTurnOfTask = false;
                }

                try {
                    const taskConfig = replyPipeline ? replyPipeline.getTaskLLMConfig(task) : llmConfig;
                    const result = await runCodeActSession(
                        messages,
                        activeScene,
                        sandbox,
                        nc,
                        taskConfig,
                        SESSIONS_DIR
                    );

                    if (result.endReason === "scene_changed" && result.nextScene) {
                        try {
                            sceneManager.enter(result.nextScene);
                            activeScene = result.nextScene;
                            continue;
                        } catch {
                            messages.push({
                                role: "user",
                                content: `[⚠ 严重错误] 尝试进入场景 ${result.nextScene} 失败。场景不存在！`,
                                scope: "global",
                            });
                            continue;
                        }
                    }

                    if (result.endReason === "error") {
                        log.error(`Session 失败 in scene ${activeScene}`, {
                            error: result.error,
                            turns: result.turns.length,
                            taskId: task.id,
                            taskSource: task.source,
                        });
                    } else {
                        log.info(`Session 完成 in scene ${activeScene}`, {
                            turns: result.turns.length,
                            reason: result.endReason,
                            taskId: task.id,
                            taskSource: task.source,
                        });
                    }

                    try {
                        await runCompaction(result, memory, llmConfig, task.chatId);
                    } catch (compErr: unknown) {
                        const compErrMsg = compErr instanceof Error ? compErr.message : String(compErr);
                        log.error("Compaction 失败", { error: compErrMsg, taskId: task.id });
                    }

                    const contextBudget = mergeContextBudget(appConfig.contextBudget);
                    if (shouldCompact(messages, contextBudget)) {
                        try {
                            const compacted = await compact(messages, cheapConfig, contextBudget);
                            messages.length = 0;
                            messages.push(...compacted);
                        } catch (compactErr) {
                            log.error("Context Compaction 失败，回退到简单截断", { error: String(compactErr) });
                            const sys = messages[0];
                            const tail = messages.slice(-10);
                            const omitted = messages.length - 11;
                            messages.length = 0;
                            messages.push(sys);
                            messages.push({
                                role: "user",
                                content: `[系统] 由于上下文长度限制，在此之前的 ${omitted} 条场景对话记录已被压缩归档并从上下文中移除。`,
                                scope: "global",
                            });
                            messages.push(...tail);
                        }
                    }

                    break;
                } catch (err: unknown) {
                    const errorMsg = err instanceof Error ? err.message : String(err);
                    log.error("Session 异常", { error: errorMsg, taskId: task.id, taskSource: task.source });

                    nc.push({
                        type: "system.session_error",
                        error: errorMsg,
                    });
                    break;
                }
            }
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
    const llmConfig = resolveTierProfile("mid", appConfig);  // main session 使用 mid profile
    log.info("LLM Profiles 加载完成", {
        profiles: Object.keys(appConfig.llmProfiles).join(", "),
        tiers: Object.entries(appConfig.modelTiers).map(([k, v]) => `${k}→${v}`).join(", "),
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
    const memory = new MemoryStoreV2(join(DATA_DIR, "memory.db"));
    const sceneManager = new SceneManager();
    registerBuiltinScenes(sceneManager);

    // ─── Phase 6: 初始化管线组件 ───
    const cheapConfig = resolveTierProfile("cheap", appConfig);
    const topicRegistry = new TopicRegistry();
    const engagedHandler = new EngagedTopicHandler(topicRegistry, llmConfig);
    const recordingPipeline = new RecordingPipeline(topicRegistry, cheapConfig, appConfig.persona?.description ?? "赛博群友", memory);
    const fastRouter = new FastRouter(topicRegistry, engagedHandler, recordingPipeline, "");
    const modelRouter = new ModelRouter(llmConfig);
    const replyPipeline = new ReplyPipeline(memory, topicRegistry, modelRouter, llmConfig);
    const feedbackLoop = new FeedbackLoop(topicRegistry, memory, nc);

    // Phase 6 事件监听
    recordingPipeline.on("topic:triage-passed", (topic: any, decision: any) => {
        log.info("话题通过 Triage", { topicId: topic.id, label: topic.label, type: decision.intervention_type });
        void (async () => {
            const task = await replyPipeline.buildTopicTask(topic.id);
            if (!task) return;
            nc.push({
                type: REPLY_TASK_EVENT_TYPE,
                task,
                chatId: task.chatId,
                scene: task.scene,
                topicId: task.topicId,
                _urgent: true,
            });
        })();
    });
    engagedHandler.on("engaged:response-ready", (topicId: string, msgs: any[], hint: string) => {
        log.info("对话模式就绪", { topicId, messageCount: msgs.length, hint: hint.slice(0, 50) });
        void (async () => {
            const task = await replyPipeline.buildEngagedTask(topicId, msgs, hint);
            if (!task) return;
            nc.push({
                type: REPLY_TASK_EVENT_TYPE,
                task,
                chatId: task.chatId,
                scene: task.scene,
                topicId: task.topicId,
                _urgent: true,
            });
        })();
    });
    engagedHandler.on("engaged:exit", (topicId: string, signal: any, style: string) => {
        log.info("对话模式退出", { topicId, signal: signal.type, style });
    });
    topicRegistry.on("topic:archived", (topic: any) => {
        memory.finalizeTopic(topic.id);
        log.debug("话题归档，标记 ended_at", { topicId: topic.id, label: topic.label });
    });

    log.info("组件初始化完成（含 Phase 6 管线）");

    // ─── 连接 sandbox 事件 ───
    sandbox.on("notify", (event: Record<string, unknown>) => {
        nc.push(event as { type: string;[key: string]: unknown });
    });

    sandbox.setHostCallHandler(async (method, args) => {
        switch (method) {
            case "memory.recall":
                return memory.recall(args[0] as string, args[1] as any);
            case "memory.browseHistory":
                return memory.browseHistory(args[0] as any);
            case "memory.reflect":
                return memory.reflect(String(args[0]), llmConfig, appConfig.reflection);
            case "actions.getTopicContext":
                return serializeTopic(topicRegistry.get(String(args[0])));
            case "actions.listActiveTopics": {
                const chatId = args[0];
                if (typeof chatId === "string" && chatId.length > 0) {
                    return topicRegistry.getActive(chatId).map(serializeTopic);
                }
                return topicRegistry.getAll().map(serializeTopic);
            }
            case "actions.recallForTopic": {
                const topic = topicRegistry.get(String(args[0]));
                if (!topic) return null;
                const query = [topic.label, ...topic.keywords].filter(Boolean).join(" ");
                return memory.recall(query, {
                    chatId: String(topic.chatId),
                    ...(args[1] as Record<string, unknown> ?? {}),
                } as any);
            }
            default:
                throw new Error(`Unsupported host call: ${method}`);
        }
    });

    sandbox.on("stderr", (data: string) => {
        if (data.trim()) {
            log.warn("Sandbox stderr", { output: data.trim() });
        }
    });

    // Agent 直接打印到 CLI
    sandbox.on("print", (message: string) => {
        console.log(`🤖 ${message}`);
    });

    // 创建 stdin readline 用于处理 Agent 的 runtime.input() 请求
    const { createInterface: createRL } = await import("node:readline");
    const hostRL = createRL({ input: process.stdin, output: process.stdout });

    // Agent 请求用户输入
    sandbox.on("input_request", ({ id, prompt }: { id: string; prompt: string }) => {
        log.info("Agent 请求输入", { prompt });
        hostRL.question(`🤖 ${prompt}`, (answer: string) => {
            sandbox.sendInputResponse(id, answer.trim());
        });
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
        cheapConfig,
        systemPrompt,
        appConfig,
        fastRouter,
        topicRegistry,
        replyPipeline,
        feedbackLoop,
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
