/**
 * sandbox-worker.ts — Sandbox Worker 进程
 *
 * 运行在子进程中，通过 stdin/stdout JSON 行协议与 Host 通信。
 * 维护持久化的 ctx 命名空间，执行 agent 写的 TypeScript/JavaScript 代码。
 *
 * IPC 协议：
 * - Host → Worker: execute, input_response, host_call_result
 * - Worker → Host: result, notify, input_request, print, host_call
 */

import { createInterface } from "node:readline";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, basename, extname } from "node:path";

// ─── IPC 消息类型 ───

/** Host → Worker: 执行代码 */
interface ExecuteMessage {
    type: "execute";
    id: string;
    code: string;
}

/** Host → Worker: 用户输入响应 */
interface InputResponseMessage {
    type: "input_response";
    id: string;
    value: string;
}

/** Host → Worker: host call 返回值 */
interface HostCallResultMessage {
    type: "host_call_result";
    id: string;
    ok: boolean;
    value?: unknown;
    error?: string;
}

/** Worker → Host: 代码执行结果 */
interface ResultMessage {
    type: "result";
    id: string;
    output: string;
    error: boolean;
    sceneState?: string;
}

/** Worker → Host: 后台任务推送事件 */
interface NotifyMessage {
    type: "notify";
    event: Record<string, unknown>;
}

/** Worker → Host: 请求用户输入 */
interface InputRequestMessage {
    type: "input_request";
    id: string;
    prompt: string;
}

/** Worker → Host: 直接打印到 CLI */
interface PrintMessage {
    type: "print";
    message: string;
}

/** Worker → Host: 请求 Host 端执行方法 */
interface HostCallMessage {
    type: "host_call";
    id: string;
    method: string;
    args: unknown[];
}

type IncomingMessage = ExecuteMessage | InputResponseMessage | HostCallResultMessage;
type OutgoingMessage = ResultMessage | NotifyMessage | InputRequestMessage | PrintMessage | HostCallMessage;

// ─── 全局上下文 ───

const ctx: Record<string, unknown> = {};
let globalSceneState = "home";

// ─── Docs 系统 ───

interface DocEntry { slug: string; title: string; content: string }

function loadAllDocs(): DocEntry[] {
    const DOCS_DIR = "workspace/agent-docs";
    if (!existsSync(DOCS_DIR)) return [];
    return readdirSync(DOCS_DIR)
        .filter(f => f.endsWith(".md") && !f.startsWith("CHANGELOG"))
        .map(f => {
            const content = readFileSync(join(DOCS_DIR, f), "utf-8");
            const slug = basename(f, extname(f));
            const titleMatch = content.match(/^#\s+(.+)$/m);
            return { slug, title: titleMatch?.[1] ?? slug, content };
        });
}

const allDocs = loadAllDocs();

const docs = {
    list: () => allDocs.map(d => ({ slug: d.slug, title: d.title })),
    read: (slug: string): string => {
        const exact = allDocs.find(d => d.slug === slug);
        if (exact) return exact.content;
        const fuzzy = allDocs.find(d => d.slug.includes(slug) || slug.includes(d.slug));
        if (fuzzy) return fuzzy.content;
        if (allDocs.length === 0) return `文档 "${slug}" 不存在，且没有可用的文档。`;
        return `文档 "${slug}" 不存在。可用文档：\n${allDocs.map(d => `  - ${d.slug}: ${d.title}`).join("\n")}`;
    },
};

function hydrateTelegramMessage(message: unknown): unknown {
    if (!message || typeof message !== "object") return message;
    const raw = message as Record<string, unknown>;
    return {
        ...raw,
        date: raw.date ? new Date(String(raw.date)) : new Date(),
        replyToMessage: raw.replyToMessage && typeof raw.replyToMessage === "object"
            ? { ...(raw.replyToMessage as Record<string, unknown>) }
            : raw.replyToMessage,
    };
}

function createTelegramClientProxy() {
    return {
        getMe: async () => callHost("telegram.getMe", []),
        sendText: async (chatId: number | string, text: string, opts?: { replyTo?: number }) =>
            hydrateTelegramMessage(await callHost("telegram.sendText", [chatId, text, opts])),
        sendMedia: async (chatId: number | string, media: unknown, opts?: { replyTo?: number; caption?: string }) =>
            hydrateTelegramMessage(await callHost("telegram.sendMedia", [chatId, media, opts])),
        getChat: async (chatId: number | string) =>
            callHost("telegram.getChat", [chatId]),
        getUser: async (userId: number | string) =>
            callHost("telegram.getUser", [userId]),
        getChatMembers: async (chatId: number | string, opts?: { limit?: number }) =>
            callHost("telegram.getChatMembers", [chatId, opts]),
        getHistory: async (chatId: number | string, opts?: { limit?: number }) => {
            const messages = await callHost("telegram.getHistory", [chatId, opts]);
            return Array.isArray(messages) ? messages.map(hydrateTelegramMessage) : [];
        },
        iterHistory: async function* (chatId: number | string, opts?: { limit?: number }) {
            const messages = await callHost("telegram.getHistory", [chatId, opts]);
            if (!Array.isArray(messages)) return;
            for (const message of messages) {
                yield hydrateTelegramMessage(message);
            }
        },
        iterDialogs: async function* (opts?: { limit?: number }) {
            const dialogs = await callHost("telegram.getDialogs", [opts]);
            if (!Array.isArray(dialogs)) return;
            for (const dialog of dialogs) {
                const raw = dialog as Record<string, unknown>;
                yield {
                    ...raw,
                    lastMessage: raw.lastMessage ? hydrateTelegramMessage(raw.lastMessage) : undefined,
                };
            }
        },
        readHistory: async (chatId: number | string) =>
            callHost("telegram.readHistory", [chatId]),
        sendTyping: async (chatId: number | string) =>
            callHost("telegram.sendTyping", [chatId]),
    };
}

// ─── IPC 通信 ───

function sendToHost(msg: OutgoingMessage): void {
    process.stdout.write(JSON.stringify(msg) + "\n");
}

function notifyHost(event: Record<string, unknown>): void {
    sendToHost({ type: "notify", event });
}

/**
 * 直接打印消息到 Host CLI（不被 console.log 捕获）
 */
function printToHost(message: string): void {
    sendToHost({ type: "print", message });
}

// ─── 输入请求管理 ───

/** 等待中的 input 请求 */
const pendingInputs = new Map<string, (value: string) => void>();
let inputCounter = 0;
let hostCallCounter = 0;
const pendingHostCalls = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
}>();

/**
 * 向 Host 请求用户输入（阻塞当前代码执行直到用户响应）
 *
 * @param prompt - 显示给用户的提示文本
 * @returns 用户输入的文本
 */
function requestInput(prompt: string): Promise<string> {
    return new Promise((resolve) => {
        const id = `input_${++inputCounter}`;
        pendingInputs.set(id, resolve);
        sendToHost({ type: "input_request", id, prompt });
    });
}

function callHost(method: string, args: unknown[] = []): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const id = `host_${++hostCallCounter}`;
        pendingHostCalls.set(id, { resolve, reject });
        sendToHost({ type: "host_call", id, method, args });
    });
}

// ─── 后台任务管理 ───

const backgroundTasks = new Map<string, AbortController>();

function spawnTask(name: string, fn: (signal: AbortSignal) => Promise<void>): void {
    if (backgroundTasks.has(name)) {
        backgroundTasks.get(name)!.abort();
    }
    const controller = new AbortController();
    backgroundTasks.set(name, controller);

    // 不 await，让其在后台运行
    fn(controller.signal).catch(err => {
        const msg = err instanceof Error ? err.stack : String(err);
        printToHost(`[Task Error] ${name}: ${msg}`);
    }).finally(() => {
        if (backgroundTasks.get(name) === controller) {
            backgroundTasks.delete(name);
        }
    });
}

function killTask(name: string): void {
    if (backgroundTasks.has(name)) {
        backgroundTasks.get(name)!.abort();
        backgroundTasks.delete(name);
        printToHost(`[Task Killed] ${name}`);
    }
}

function listTasks(): string[] {
    return Array.from(backgroundTasks.keys());
}

// ─── 代码执行 ───

async function executeCode(id: string, code: string): Promise<void> {
    const outputLines: string[] = [];

    const originalConsole = {
        log: console.log,
        warn: console.warn,
        error: console.error,
        info: console.info,
    };

    const captureLog = (...args: unknown[]) => {
        const line = args
            .map((a) =>
                typeof a === "string" ? a : JSON.stringify(a, null, 2) ?? String(a)
            )
            .join(" ");
        outputLines.push(line);
    };

    console.log = captureLog;
    console.warn = captureLog;
    console.error = captureLog;
    console.info = captureLog;

    try {
        if (!ctx.tg) {
            ctx.tg = createTelegramClientProxy();
        }

        // 构造 async wrapper，注入 ctx, runtime, memory, scene, docs, actions, skills
        const asyncFn = new Function(
            "ctx",
            "runtime",
            "memory",
            "scene",
            "docs",
            "actions",
            "skills",
            `return (async () => { ${code} })()`
        );

        // runtime 对象
        const runtime = {
            notify: notifyHost,
            /**
             * 请求用户输入（阻塞直到用户响应）
             * @example const code = await runtime.input("请输入验证码: ");
             */
            input: requestInput,
            /**
             * 直接打印到 CLI（不被 console.log 捕获）
             * @example runtime.print("⚠ 需要你的帮助！");
             */
            print: printToHost,
            /**
             * 启动一个后台监听任务，自动处理清理逻辑
             * @example runtime.spawn("tg-listener", async (signal) => { ... })
             */
            spawn: spawnTask,
            /**
             * 停止某个后台任务
             * @example runtime.kill("tg-listener")
             */
            kill: killTask,
            /**
             * 获取当前正在运行的所有后台任务名称列表
             */
            ps: listTasks,
        };

        const memory = {
            /**
             * 统一记忆检索
             * @example const result = await memory.recall("京都 旅行");
             */
            recall: async (query: string, options?: Record<string, unknown>) =>
                callHost("memory.recall", [query, options]),

            /**
             * 消息档案检索
             * @example const result = await memory.browseHistory({ intent: "之前谁推荐过岚山" });
             */
            browseHistory: async (request: Record<string, unknown>) =>
                callHost("memory.browseHistory", [request]),

            /**
             * 对指定群组进行反思总结
             * @example const result = await memory.reflect("-100123");
             */
            reflect: async (chatId: string) =>
                callHost("memory.reflect", [chatId]),
        };

        const actions = {
            getTopicContext: async (topicId: string) =>
                callHost("actions.getTopicContext", [topicId]),
            listActiveTopics: async (chatId?: string) =>
                callHost("actions.listActiveTopics", [chatId]),
            recallForTopic: async (topicId: string, options?: Record<string, unknown>) =>
                callHost("actions.recallForTopic", [topicId, options]),
        };

        const skills = {
            memory: {
                recallAndSummarize: async (query: string, options?: Record<string, unknown>) =>
                    memory.recall(query, options),
                browseForAnswer: async (request: Record<string, unknown>) =>
                    memory.browseHistory(request),
            },
            social: {
                replyInTelegram: async (
                    chatId: number | string,
                    text: string,
                    opts?: { replyTo?: number }
                ) => {
                    const tg = ctx.tg as {
                        sendText?: (chatId: number | string, text: string, opts?: { replyTo?: number }) => Promise<unknown>;
                    } | undefined;
                    if (!tg?.sendText) {
                        throw new Error("ctx.tg.sendText is not available");
                    }
                    const sent = await tg.sendText(chatId, text, opts);
                    notifyHost({
                        type: "system.agent_message_sent",
                        scene: "telegram",
                        chatId: String(chatId),
                        messageId: typeof sent === "object" && sent && "id" in sent ? (sent as { id?: unknown }).id : undefined,
                        text,
                        replyToMessageId: opts?.replyTo,
                        timestamp: new Date().toISOString(),
                    });
                    return sent;
                },
            },
        };
        const scene = {
            get current() { return globalSceneState; },
            enter: (name: string) => {
                outputLines.push(`[Scene switched to: ${name}]`);
                globalSceneState = name;
            },
            list: () => {
                outputLines.push("[Available scenes: home, telegram, memory]");
            },
            showFullTypes: () => {
                // 这个输出仅仅是为了在 runner 中匹配后提供完整类型的占位符，
                // 真正的注入由 host 的 session runner 处理
                outputLines.push("[Full type definitions for current scene]");
            },
        };

        await asyncFn(ctx, runtime, memory, scene, docs, actions, skills);

        sendToHost({
            type: "result",
            id,
            output: outputLines.join("\n"),
            error: false,
            sceneState: globalSceneState,
        });
    } catch (err: unknown) {
        const errorMsg =
            err instanceof Error
                ? `${err.name}: ${err.message}\n${err.stack ?? ""}`
                : String(err);

        outputLines.push(errorMsg);

        sendToHost({
            type: "result",
            id,
            output: outputLines.join("\n"),
            error: true,
            sceneState: globalSceneState,
        });
    } finally {
        console.log = originalConsole.log;
        console.warn = originalConsole.warn;
        console.error = originalConsole.error;
        console.info = originalConsole.info;
    }
}

// ─── 主循环 ───

const rl = createInterface({
    input: process.stdin,
    terminal: false,
});

rl.on("line", async (line: string) => {
    try {
        const msg: IncomingMessage = JSON.parse(line);

        if (msg.type === "execute") {
            await executeCode(msg.id, msg.code);
        } else if (msg.type === "input_response") {
            // 用户输入响应 — 唤醒等待中的 runtime.input()
            const resolver = pendingInputs.get(msg.id);
            if (resolver) {
                pendingInputs.delete(msg.id);
                resolver(msg.value);
            }
        } else if (msg.type === "host_call_result") {
            const pending = pendingHostCalls.get(msg.id);
            if (pending) {
                pendingHostCalls.delete(msg.id);
                if (msg.ok) {
                    pending.resolve(msg.value);
                } else {
                    pending.reject(new Error(msg.error ?? "Unknown host call error"));
                }
            }
        }
    } catch (err: unknown) {
        const errorMsg =
            err instanceof Error ? err.message : String(err);
        sendToHost({
            type: "result",
            id: "unknown",
            output: `IPC parse error: ${errorMsg}`,
            error: true,
        });
    }
});

// 发送 ready 信号
sendToHost({
    type: "result",
    id: "__ready__",
    output: "worker ready",
    error: false,
});
