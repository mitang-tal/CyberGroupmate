#!/usr/bin/env npx tsx
/**
 * cli.ts — CyberGroupmate CLI 调试工具
 *
 * 提供子命令用于手动测试各组件：
 *   npx tsx src/cli.ts sandbox    — 交互式 sandbox REPL
 *   npx tsx src/cli.ts notify     — 手动推送一条通知
 *   npx tsx src/cli.ts drain      — 查看当前通知队列
 *   npx tsx src/cli.ts memory     — 交互式 memory 查询
 *   npx tsx src/cli.ts config     — 检查配置加载结果
 *   npx tsx src/cli.ts status     — 查看 agent 状态
 */

import { createInterface } from "node:readline";
import { Sandbox } from "./sandbox.js";
import { NotificationCenter } from "./notification-center.js";
import { MemoryStore } from "./memory.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const log = createLogger("cli");
const DATA_DIR = "data";

// ─── 子命令 ───

/**
 * sandbox — 交互式 Sandbox REPL
 *
 * 启动 sandbox worker，然后进入 REPL 循环。
 * 输入 TypeScript 代码直接执行，支持多行（以空行结束）。
 */
async function cmdSandbox(): Promise<void> {
    log.info("启动 Sandbox REPL...");

    const sandbox = new Sandbox();
    await sandbox.start();
    log.info("Sandbox 就绪。输入 TypeScript 代码执行，输入 .exit 退出。");
    log.info("提示：多行输入以空行结束执行。");

    sandbox.on("notify", (event: Record<string, unknown>) => {
        console.log(`\n📬 [notify] ${JSON.stringify(event, null, 2)}`);
    });

    const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: "sandbox> ",
    });

    let buffer: string[] = [];

    rl.prompt();

    rl.on("line", async (line: string) => {
        if (line.trim() === ".exit") {
            await sandbox.stop();
            rl.close();
            process.exit(0);
        }

        if (line.trim() === ".help") {
            console.log(`
可用命令：
  .exit       退出 REPL
  .help       显示帮助
  .clear      清空输入缓冲区

直接输入 TypeScript 代码，按 Enter 执行单行。
多行代码：输入后按 Enter（空行）执行。

可用对象：ctx, runtime, memory, scene
      `);
            rl.prompt();
            return;
        }

        if (line.trim() === ".clear") {
            buffer = [];
            console.log("缓冲区已清空");
            rl.prompt();
            return;
        }

        // 多行模式
        if (line.trim() === "" && buffer.length > 0) {
            const code = buffer.join("\n");
            buffer = [];
            await executeAndPrint(sandbox, code);
            rl.prompt();
            return;
        }

        if (line.trim() === "") {
            rl.prompt();
            return;
        }

        // 单行判断：如果看起来是完整语句就直接执行
        if (buffer.length === 0 && isCompleteLine(line)) {
            await executeAndPrint(sandbox, line);
            rl.prompt();
            return;
        }

        buffer.push(line);
        rl.setPrompt("... ");
        rl.prompt();
    });

    rl.on("close", async () => {
        await sandbox.stop();
        process.exit(0);
    });
}

function isCompleteLine(line: string): boolean {
    const trimmed = line.trim();
    return (
        trimmed.endsWith(";") ||
        trimmed.endsWith(")") ||
        trimmed.startsWith("const ") ||
        trimmed.startsWith("let ") ||
        trimmed.startsWith("var ") ||
        trimmed.startsWith("await ") ||
        trimmed.startsWith("console.") ||
        trimmed.startsWith("//")
    );
}

async function executeAndPrint(sandbox: Sandbox, code: string): Promise<void> {
    const start = Date.now();
    try {
        const result = await sandbox.execute(code);
        const elapsed = Date.now() - start;

        if (result.output) {
            console.log(result.output);
        }
        if (result.error) {
            console.error(`\x1b[31m✘ Error (${elapsed}ms)\x1b[0m`);
        } else if (result.output) {
            console.log(`\x1b[90m(${elapsed}ms)\x1b[0m`);
        } else {
            console.log(`\x1b[32m✔\x1b[0m \x1b[90m(${elapsed}ms)\x1b[0m`);
        }
    } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error(`\x1b[31m✘ ${errorMsg}\x1b[0m`);
    }
}

/**
 * notify — 手动推送一条通知
 */
async function cmdNotify(args: string[]): Promise<void> {
    const eventsPath = join(DATA_DIR, "events.jsonl");
    const nc = new NotificationCenter(eventsPath);

    const type = args[0] ?? "test.manual";
    const text = args.slice(1).join(" ") || "手动测试通知";

    const event = nc.push({
        type,
        text,
        source: "cli",
    });

    log.info("事件已推送", {
        id: event._id,
        type: event.type,
        pendingCount: nc.pendingCount,
    });
}

/**
 * drain — 查看当前通知队列
 */
async function cmdDrain(): Promise<void> {
    const eventsPath = join(DATA_DIR, "events.jsonl");
    const nc = new NotificationCenter(eventsPath);

    log.info("当前队列", { pending: nc.pendingCount });

    const events = await nc.drain(0, 100);
    if (events.length === 0) {
        log.info("队列为空");
        return;
    }

    for (const event of events) {
        console.log(JSON.stringify(event, null, 2));
    }
    log.info(`共 ${events.length} 条事件`);
}

/**
 * memory — 交互式 Memory 查询
 */
async function cmdMemory(args: string[]): Promise<void> {
    const dbPath = join(DATA_DIR, "memory.db");
    if (!existsSync(dbPath)) {
        log.error("数据库不存在", { path: dbPath });
        log.info('提示：先运行 "npx tsx src/main.ts" 初始化数据库');
        process.exit(1);
    }

    const memory = new MemoryStore(dbPath);
    const subCmd = args[0] ?? "help";

    switch (subCmd) {
        case "search": {
            const query = args.slice(1).join(" ");
            if (!query) {
                log.error('用法: memory search <关键词>');
                break;
            }
            const results = memory.search(query, 20);
            if (results.length === 0) {
                log.info("无搜索结果");
            } else {
                for (const r of results) {
                    console.log(`\n\x1b[36m[${r.id}]\x1b[0m ${r.timestamp}`);
                    console.log(r.content);
                    if (Object.keys(r.metadata).length > 0) {
                        console.log(`\x1b[90m${JSON.stringify(r.metadata)}\x1b[0m`);
                    }
                }
                log.info(`共 ${results.length} 条结果`);
            }
            break;
        }

        case "person": {
            const userId = args[1];
            if (!userId) {
                log.error('用法: memory person <userId>');
                break;
            }
            const person = memory.getPerson(userId);
            if (!person) {
                log.info("未找到该用户", { userId });
            } else {
                console.log(JSON.stringify(person, null, 2));
            }
            break;
        }

        case "conversations": {
            const chatId = args[1];
            const convos = memory.getRecentConversations(chatId, 20);
            if (convos.length === 0) {
                log.info("无对话记录");
            } else {
                for (const c of convos) {
                    console.log(
                        `\n\x1b[36m[${c.id}]\x1b[0m ${c.chatTitle} — ${c.timestamp}`
                    );
                    console.log(c.summary);
                    if (c.keyPoints.length > 0) {
                        console.log(`\x1b[90m要点: ${c.keyPoints.join(", ")}\x1b[0m`);
                    }
                }
            }
            break;
        }

        case "todos": {
            const todos = memory.getPendingTasks(args[1] === "--all");
            if (todos.length === 0) {
                log.info("无待办事项");
            } else {
                for (const t of todos) {
                    const status = t.done ? "✅" : "⬜";
                    const due = t.dueDate ? ` (截止: ${t.dueDate})` : "";
                    console.log(`${status} ${t.description}${due}  \x1b[90m${t.id}\x1b[0m`);
                }
            }
            break;
        }

        case "sql": {
            const sql = args.slice(1).join(" ");
            if (!sql) {
                log.error('用法: memory sql <SQL语句>');
                break;
            }
            try {
                const result = memory.rawQuery(sql);
                console.log(JSON.stringify(result, null, 2));
            } catch (err: unknown) {
                const errorMsg = err instanceof Error ? err.message : String(err);
                log.error("SQL 执行失败", { error: errorMsg });
            }
            break;
        }

        default:
            console.log(`
\x1b[1mMemory 子命令：\x1b[0m

  search <关键词>       搜索记忆
  person <userId>       查看群友画像
  conversations [chatId] 查看对话摘要
  todos [--all]         查看待办事项
  sql <SQL>             执行原始 SQL 查询
      `);
    }

    memory.close();
}

/**
 * config — 检查配置加载结果
 */
async function cmdConfig(): Promise<void> {
    log.info("加载配置...");

    const config = loadConfig(undefined, true);

    console.log("\n\x1b[1mLLM 配置：\x1b[0m");
    console.log(`  Provider:    ${config.llm.provider}`);
    console.log(`  Base URL:    ${config.llm.baseUrl}`);
    console.log(`  Model:       ${config.llm.model}`);
    console.log(`  Temperature: ${config.llm.temperature}`);
    console.log(`  Max Tokens:  ${config.llm.maxTokens}`);
    console.log(`  API Key:     ${config.llm.apiKey ? "***" + config.llm.apiKey.slice(-4) : "(未设置)"}`);

    console.log("\n\x1b[1mPersona：\x1b[0m");
    console.log(`  Name:        ${config.persona.name}`);
    console.log(`  Description: ${config.persona.description ? config.persona.description.slice(0, 60) + "..." : "(未设置)"}`);

    console.log("\n\x1b[1mTelegram 配置：\x1b[0m");
    console.log(`  Mode:        ${config.telegram.mode}`);
    console.log(`  API ID:      ${config.telegram.apiId || "(未设置)"}`);
    console.log(`  API Hash:    ${config.telegram.apiHash ? "***" + config.telegram.apiHash.slice(-4) : "(未设置)"}`);
    console.log(`  Bot Token:   ${config.telegram.botToken ? "***" + config.telegram.botToken.slice(-4) : "(未设置)"}`);
    console.log(`  Phone:       ${config.telegram.phone || "(未设置)"}`);

    // 检查文件
    console.log("\n\x1b[1m文件检查：\x1b[0m");
    const files = [
        "config.yaml",
        "system-prompt.md",
        join(DATA_DIR, "memory.db"),
        join(DATA_DIR, "events.jsonl"),
        join(DATA_DIR, "agent-state.md"),
        join(DATA_DIR, "bootstrap-code.json"),
    ];
    for (const f of files) {
        const exists = existsSync(f);
        const icon = exists ? "\x1b[32m✔\x1b[0m" : "\x1b[90m✘\x1b[0m";
        console.log(`  ${icon} ${f}`);
    }
}

/**
 * status — 查看 agent 状态
 */
async function cmdStatus(): Promise<void> {
    // Agent state
    const statePath = join(DATA_DIR, "agent-state.md");
    if (existsSync(statePath)) {
        console.log("\x1b[1m=== Agent State ===\x1b[0m\n");
        console.log(readFileSync(statePath, "utf-8"));
    } else {
        log.info("agent-state.md 不存在（agent 尚未运行过）");
    }

    // Recent events
    const eventsPath = join(DATA_DIR, "events.jsonl");
    if (existsSync(eventsPath)) {
        const content = readFileSync(eventsPath, "utf-8").trim();
        const lines = content ? content.split("\n") : [];
        const recent = lines.slice(-5);
        console.log(`\n\x1b[1m=== 最近事件 (${lines.length} 总, 显示最后 ${recent.length} 条) ===\x1b[0m\n`);
        for (const line of recent) {
            try {
                const event = JSON.parse(line);
                console.log(`  ${event._ts ?? ""} ${event.type ?? "unknown"}`);
            } catch {
                console.log(`  (无法解析) ${line.slice(0, 80)}`);
            }
        }
    } else {
        log.info("events.jsonl 不存在");
    }

    // Memory stats
    const dbPath = join(DATA_DIR, "memory.db");
    if (existsSync(dbPath)) {
        const memory = new MemoryStore(dbPath);
        try {
            const memCount = memory.rawQuery("SELECT COUNT(*) as cnt FROM memories") as Array<{ cnt: number }>;
            const personCount = memory.rawQuery("SELECT COUNT(*) as cnt FROM person_profiles") as Array<{ cnt: number }>;
            const convoCount = memory.rawQuery("SELECT COUNT(*) as cnt FROM conversation_log") as Array<{ cnt: number }>;
            const todoCount = memory.rawQuery("SELECT COUNT(*) as cnt FROM todos WHERE done = 0") as Array<{ cnt: number }>;

            console.log(`\n\x1b[1m=== Memory 统计 ===\x1b[0m\n`);
            console.log(`  记忆:     ${memCount[0]?.cnt ?? 0} 条`);
            console.log(`  群友画像: ${personCount[0]?.cnt ?? 0} 个`);
            console.log(`  对话摘要: ${convoCount[0]?.cnt ?? 0} 条`);
            console.log(`  待办事项: ${todoCount[0]?.cnt ?? 0} 条 (未完成)`);
        } catch {
            log.warn("无法读取 memory 统计");
        }
        memory.close();
    }
}

// ─── Main ───

const HELP = `
\x1b[1mCyberGroupmate CLI — 调试工具\x1b[0m

用法: npx tsx src/cli.ts <command> [args...]

命令:
  sandbox                交互式 Sandbox REPL
  notify [type] [text]   推送一条通知到队列
  drain                  查看并清空通知队列
  memory <subcmd>        记忆系统查询（search/person/conversations/todos/sql）
  config                 检查配置加载结果
  status                 查看 agent 运行状态和统计

环境变量:
  LOG_LEVEL=debug|info|warn|error   日志级别（默认: info）
  LOG_FORMAT=text|json              日志格式（默认: text）
  LLM_API_KEY=...                   LLM API Key
  TG_BOT_TOKEN=...                  Telegram Bot Token
  TG_API_ID=...                     Telegram API ID
  TG_API_HASH=...                   Telegram API Hash
`;

async function main(): Promise<void> {
    const [_node, _script, command, ...args] = process.argv;

    switch (command) {
        case "sandbox":
            await cmdSandbox();
            break;
        case "notify":
            await cmdNotify(args);
            break;
        case "drain":
            await cmdDrain();
            break;
        case "memory":
        case "mem":
            await cmdMemory(args);
            break;
        case "config":
            await cmdConfig();
            break;
        case "status":
            await cmdStatus();
            break;
        default:
            console.log(HELP);
            break;
    }
}

main().catch((err) => {
    log.error("CLI 异常", { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
});
