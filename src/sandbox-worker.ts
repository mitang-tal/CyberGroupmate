/**
 * sandbox-worker.ts — Sandbox Worker 进程
 *
 * 运行在子进程中，通过 stdin/stdout JSON 行协议与 Host 通信。
 * 维护持久化的 ctx 命名空间，执行 agent 写的 TypeScript/JavaScript 代码。
 *
 * 在整体架构中的位置：
 * - 由 sandbox.ts (Host 侧) 通过 child_process.spawn 启动
 * - 预注入 runtime, memory, scene 到 globalThis
 * - Agent 代码通过 new Function() + async wrapper 执行
 * - console.log 被劫持，输出作为执行结果返回给 Host
 * - 错误 stack trace 作为输出返回（自动错误反馈）
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

/** Worker → Host: 代码执行结果 */
interface ResultMessage {
    type: "result";
    id: string;
    output: string;
    error: boolean;
}

/** Worker → Host: 后台任务推送事件 */
interface NotifyMessage {
    type: "notify";
    event: Record<string, unknown>;
}

type IncomingMessage = ExecuteMessage;
type OutgoingMessage = ResultMessage | NotifyMessage;

// ─── 全局上下文 ───

/** 跨代码块的持久化命名空间 */
const ctx: Record<string, unknown> = {};

// ─── Docs 系统 ───

/** 预加载的文档内容（worker 启动时读取 docs/ 目录） */
interface DocEntry { slug: string; title: string; content: string }

function loadAllDocs(): DocEntry[] {
    const DOCS_DIR = "docs";
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
        // 尝试精确匹配和模糊匹配
        const exact = allDocs.find(d => d.slug === slug);
        if (exact) return exact.content;
        const fuzzy = allDocs.find(d => d.slug.includes(slug) || slug.includes(d.slug));
        if (fuzzy) return fuzzy.content;
        if (allDocs.length === 0) return `文档 "${slug}" 不存在，且没有可用的文档。`;
        return `文档 "${slug}" 不存在。可用文档：\n${allDocs.map(d => `  - ${d.slug}: ${d.title}`).join("\n")}`;
    },
};

// ─── IPC 通信 ───

/**
 * 向 Host 发送消息
 */
function sendToHost(msg: OutgoingMessage): void {
    process.stdout.write(JSON.stringify(msg) + "\n");
}

/**
 * runtime.notify() — 从 worker 内部推送事件到 Host 的 NotificationCenter
 */
function notifyHost(event: Record<string, unknown>): void {
    sendToHost({ type: "notify", event });
}

// ─── 代码执行 ───

/**
 * 在持久化命名空间中执行一段 agent 代码
 *
 * 使用 new Function() 构造函数来执行代码，支持 top-level await。
 * console.log 被劫持，所有输出收集后作为执行结果返回。
 * 错误通过 try/catch 捕获，stack trace 作为输出返回。
 */
async function executeCode(id: string, code: string): Promise<void> {
    const outputLines: string[] = [];

    // 劫持 console 方法
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
        // 构造 async wrapper，注入 ctx, runtime, memory, scene, docs
        const asyncFn = new Function(
            "ctx",
            "runtime",
            "memory",
            "scene",
            "docs",
            `return (async () => { ${code} })()`
        );

        // runtime 对象 — 注入到 agent 代码中
        // spawn/kill/ps/cron 是占位符，将由 Host 侧的 BackgroundManager 接管
        const runtime = {
            notify: notifyHost,
            // spawn, kill, ps, cron 将在 Host 完成 BackgroundManager 后注入
        };

        // memory 和 scene 是占位符，后续 Task 中实现
        const memory = {};
        const scene = {
            current: "home",
            enter: (name: string) => {
                outputLines.push(`[Scene switched to: ${name}]`);
                scene.current = name;
            },
            list: () => {
                outputLines.push("[Available scenes: home, telegram, memory]");
            },
            showFullTypes: () => {
                outputLines.push("[Full type definitions for current scene]");
            },
        };

        await asyncFn(ctx, runtime, memory, scene, docs);

        sendToHost({
            type: "result",
            id,
            output: outputLines.join("\n"),
            error: false,
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
        });
    } finally {
        // 恢复 console
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
        }
    } catch (err: unknown) {
        // JSON 解析错误 — 发送错误结果（使用 "unknown" id）
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
