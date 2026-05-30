import type { ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { createLogger } from "../core/logger.js";
import { getHarnessHome, getHarnessInstructionPath } from "./home.js";
import { buildSystemPrompt, buildTaskPrompt } from "./prompt.js";
import type {
    HarnessLauncher,
    HarnessMcpConfig,
    HarnessMcpServerConfig,
    HarnessNotify,
    HarnessRunEvent,
    HarnessRunRecord,
} from "./types.js";

const log = createLogger("harness-manager");

// dream-journal JSONL 文件每次运行可达数 MB，只保留最近若干份，由 manager 定时清理。
const MAX_JOURNAL_FILES = 10;
const JOURNAL_CLEANUP_INTERVAL_MS = 30 * 60_000;

export interface HarnessManagerConfig {
    launcher: HarnessLauncher;
    workDir: string;
    mcpUrl: string;
    mcpToken: string;
    persona: { name: string; description: string };
    model?: string;
    maxBudgetUsd?: number;
    extraArgs?: string[];
}

export class HarnessManager {
    private config: HarnessManagerConfig;
    private running = false;
    private shuttingDown = false;
    private child: ChildProcess | null = null;
    private pendingQueue: HarnessNotify[] = [];
    private history: HarnessRunRecord[] = [];
    private currentRun: HarnessRunRecord | null = null;
    private nextRunSeq = 1;
    private nextEventSeq = 1;
    private consecutiveFailures = 0;
    private lastError: string | null = null;
    private cleanupTimer: ReturnType<typeof setInterval> | null = null;
    onSpawnFailure?: (error: string, pendingCount: number) => void;

    constructor(config: HarnessManagerConfig) {
        this.config = config;
        this.cleanupTimer = setInterval(() => this.cleanupJournal(), JOURNAL_CLEANUP_INTERVAL_MS);
        if (this.cleanupTimer.unref) this.cleanupTimer.unref();
    }

    get isRunning(): boolean {
        return this.running;
    }

    get queueLength(): number {
        return this.pendingQueue.length;
    }

    enqueue(notify: HarnessNotify): void {
        if (this.shuttingDown) return;
        this.pendingQueue.push(notify);
        if (!this.running) {
            void this.launch();
        } else {
            log.info("enqueue: instance running, queued", { queueLength: this.pendingQueue.length });
        }
    }

    triggerScheduled(): void {
        if (this.shuttingDown) return;
        this.enqueue({ content: "scheduled-dreaming", source: "scheduler" });
    }

    getStatus(): {
        running: boolean;
        queueLength: number;
        historyCount: number;
        currentRun?: Omit<HarnessRunRecord, "events">;
        lastRun?: Omit<HarnessRunRecord, "events">;
        lastError: string | null;
        consecutiveFailures: number;
        harness: string;
    } {
        return {
            running: this.running,
            queueLength: this.pendingQueue.length,
            historyCount: this.history.length,
            currentRun: this.currentRun ? this.summarizeRun(this.currentRun) : undefined,
            lastRun: this.history.length > 0 ? this.summarizeRun(this.history[this.history.length - 1]) : undefined,
            lastError: this.lastError,
            consecutiveFailures: this.consecutiveFailures,
            harness: this.config.launcher.name,
        };
    }

    getRecentRuns(limit = 20): HarnessRunRecord[] {
        const runs = [...this.history].reverse().slice(0, Math.max(0, limit));
        return runs.map((run) => this.cloneRun(run));
    }

    getCurrentRun(): HarnessRunRecord | null {
        return this.currentRun ? this.cloneRun(this.currentRun) : null;
    }

    getRun(runId: string): HarnessRunRecord | null {
        if (this.currentRun?.id === runId) return this.cloneRun(this.currentRun);
        const run = this.history.find((item) => item.id === runId);
        return run ? this.cloneRun(run) : null;
    }

    async shutdown(): Promise<void> {
        this.shuttingDown = true;
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }
        if (this.child) {
            log.info("shutdown: killing harness process");
            this.child.kill("SIGTERM");
            await new Promise<void>((resolve) => {
                const timer = setTimeout(() => {
                    this.child?.kill("SIGKILL");
                    resolve();
                }, 10_000);
                this.child?.once("exit", () => {
                    clearTimeout(timer);
                    resolve();
                });
            });
            this.child = null;
            this.running = false;
        }
    }

    private async launch(): Promise<void> {
        if (this.running || this.shuttingDown) return;
        this.running = true;

        const pending = this.drainQueue();
        const trigger = pending.some(n => n.source === "scheduler") ? "scheduled" : "enqueued";
        const systemPrompt = buildSystemPrompt(this.config.workDir, this.config.persona);
        const prompt = buildTaskPrompt(this.config.workDir, pending);

        const externalMcpServers = this.loadExternalMcpServers();
        const mcpConfig: HarnessMcpConfig = {
            mcpServers: {
                ...externalMcpServers,
                cybergroupmate: {
                    type: "streamable-http" as const,
                    url: `${this.config.mcpUrl}?token=${this.config.mcpToken}`,
                },
            },
        };
        const mcpServers = Object.keys(mcpConfig.mcpServers);

        const runId = this.createRunId();
        const logPath = join(this.config.workDir, "workspace", "dream-journal", `${runId}.jsonl`);
        const harnessHome = getHarnessHome();
        const instructionPath = getHarnessInstructionPath(harnessHome, this.config.launcher.name);
        mkdirSync(join(this.config.workDir, "workspace", "dream-journal"), { recursive: true });
        this.cleanupJournal();

        const record: HarnessRunRecord = {
            id: runId,
            startedAt: Date.now(),
            trigger,
            pendingCount: pending.length,
            harness: this.config.launcher.name,
            mcpServers,
            logPath,
            harnessHome,
            instructionPath,
            events: [],
            eventCount: 0,
        };
        this.currentRun = record;
        this.recordEvent(record, "system", "launch", `启动 ${record.harness}，触发方式 ${trigger}，待处理 ${pending.length} 条，MCP: ${mcpServers.join(", ")}`);
        this.recordEvent(record, "system", "home", `HOME=${harnessHome}；system prompt 写入 ${instructionPath}`);

        let receivedResult = false;

        try {
            this.child = await this.config.launcher.start({
                prompt,
                systemPrompt,
                mcpConfig,
                workDir: this.config.workDir,
                model: this.config.model,
                maxBudgetUsd: this.config.maxBudgetUsd,
                extraArgs: this.config.extraArgs,
            });

            record.pid = this.child.pid ?? undefined;
            this.recordEvent(record, "system", "spawn", `进程已启动，pid=${record.pid ?? "unknown"}`);

            log.info("launch: harness started", {
                launcher: this.config.launcher.name,
                pid: this.child.pid,
                trigger,
                pendingCount: pending.length,
            });

            this.collectOutput(this.child, record, () => { receivedResult = true; });

            this.child.once("exit", (code) => {
                record.endedAt = Date.now();
                record.exitCode = code;
                record.durationMs = record.durationMs ?? (record.endedAt - record.startedAt);

                const durationSec = (record.durationMs / 1000).toFixed(1);
                log.info("launch: harness exited", { code, durationSec, trigger, cost: record.costUsd });
                this.recordEvent(record, "system", "exit", `进程退出，code=${code}, duration=${durationSec}s${record.costUsd != null ? `, cost=$${record.costUsd}` : ""}`);

                this.child = null;
                this.running = false;
                this.currentRun = null;

                if (code !== 0 && !this.shuttingDown && !receivedResult) {
                    this.handleSpawnFailure(`harness exited with code ${code}`, pending, record);
                    return;
                }

                this.history.push(record);
                if (this.history.length > 50) this.history.shift();

                if (code === 0 || this.shuttingDown) {
                    this.consecutiveFailures = 0;
                    this.lastError = null;
                } else {
                    this.lastError = `harness exited with code ${code} (partial work done)`;
                    this.consecutiveFailures = 0;
                    this.onSpawnFailure?.(this.lastError, this.pendingQueue.length);
                }

                if (!this.shuttingDown && this.pendingQueue.length > 0) {
                    log.info("launch: pending queue not empty, relaunching", { queueLength: this.pendingQueue.length });
                    void this.launch();
                }
            });

            this.child.once("error", (err) => {
                this.handleSpawnFailure(String(err), pending, record);
            });
        } catch (err) {
            this.handleSpawnFailure(String(err), pending, record);
        }
    }

    private handleSpawnFailure(error: string, pending: HarnessNotify[], record: HarnessRunRecord): void {
        log.error("launch: harness spawn failed", { error, consecutiveFailures: this.consecutiveFailures + 1 });
        this.recordEvent(record, "system", "failure", error);
        this.pendingQueue.unshift(...pending);
        if (!record.endedAt) record.endedAt = Date.now();
        if (record.exitCode == null) record.exitCode = -1;
        if (record.durationMs == null) record.durationMs = record.endedAt - record.startedAt;
        this.history.push(record);
        if (this.history.length > 50) this.history.shift();
        this.child = null;
        this.running = false;
        this.currentRun = null;
        this.consecutiveFailures++;
        this.lastError = error;
        this.onSpawnFailure?.(error, this.pendingQueue.length);

        if (!this.shuttingDown && this.pendingQueue.length > 0 && this.consecutiveFailures <= 3) {
            const delaySec = Math.min(30, 5 * Math.pow(2, this.consecutiveFailures - 1));
            log.info("launch: scheduling retry", { delaySec, attempt: this.consecutiveFailures });
            setTimeout(() => {
                if (!this.shuttingDown && !this.running && this.pendingQueue.length > 0) {
                    void this.launch();
                }
            }, delaySec * 1000);
        }
    }

    private loadExternalMcpServers(): Record<string, HarnessMcpServerConfig> {
        const result: Record<string, HarnessMcpServerConfig> = {};
        try {
            const raw = readFileSync(join(this.config.workDir, "workspace", "mcp-connections.json"), "utf-8");
            const parsed = JSON.parse(raw);
            const connections = Array.isArray(parsed) ? parsed as Array<Record<string, unknown>> : [];
            for (const conn of connections) {
                const name = typeof conn.name === "string" ? conn.name.trim() : "";
                if (!name) continue;
                if (name === "cybergroupmate") {
                    log.warn("skipping external MCP with reserved name", { name });
                    continue;
                }

                const transport = conn.transport === "stdio" || conn.transport === "streamable-http"
                    ? conn.transport
                    : typeof conn.url === "string" && conn.url.trim()
                        ? "streamable-http"
                        : "stdio";

                if (transport === "streamable-http") {
                    if (typeof conn.url !== "string" || !conn.url.trim()) {
                        log.warn("skipping external HTTP MCP without url", { name });
                        continue;
                    }
                    const entry: HarnessMcpServerConfig = {
                        type: "streamable-http",
                        url: conn.url,
                    };
                    const headers = normalizeStringMap(conn.headers);
                    if (headers) entry.headers = headers;
                    result[name] = entry;
                    continue;
                }

                if (typeof conn.command !== "string" || !conn.command.trim()) {
                    log.warn("skipping external stdio MCP without command", { name });
                    continue;
                }
                const entry: HarnessMcpServerConfig = {
                    type: "stdio",
                    command: conn.command,
                };
                if (Array.isArray(conn.args)) entry.args = conn.args.map(String);
                const env = normalizeStringMap(conn.env);
                if (env) entry.env = env;
                result[name] = entry;
            }
            if (Object.keys(result).length > 0) {
                log.info("loaded external MCP servers for harness", { servers: Object.keys(result) });
            }
        } catch {
            // no external connections or file unreadable — fine
        }
        return result;
    }

    private drainQueue(): HarnessNotify[] {
        const items = [...this.pendingQueue];
        this.pendingQueue = [];
        return items;
    }

    private createRunId(): string {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        return `harness-${stamp}-${this.nextRunSeq++}`;
    }

    /** 只保留最近 MAX_JOURNAL_FILES 份 dream-journal JSONL，删掉更早的，避免磁盘膨胀。 */
    private cleanupJournal(): void {
        const dir = join(this.config.workDir, "workspace", "dream-journal");
        let names: string[];
        try {
            names = readdirSync(dir).filter((name) => name.startsWith("harness-") && name.endsWith(".jsonl"));
        } catch {
            return; // 目录还没建或不可读，无需清理
        }
        if (names.length <= MAX_JOURNAL_FILES) return;

        const entries = names.map((name) => {
            let mtime = 0;
            try {
                mtime = statSync(join(dir, name)).mtimeMs;
            } catch {
                // 取不到时间就当作最旧，优先淘汰
            }
            return { name, mtime };
        });
        entries.sort((a, b) => b.mtime - a.mtime); // 新的在前

        const currentName = this.currentRun?.logPath ? basename(this.currentRun.logPath) : null;
        let removed = 0;
        for (const entry of entries.slice(MAX_JOURNAL_FILES)) {
            if (entry.name === currentName) continue; // 别删正在写入的那份
            try {
                unlinkSync(join(dir, entry.name));
                removed++;
            } catch (err) {
                log.debug("failed to remove old dream-journal log", { name: entry.name, error: String(err) });
            }
        }
        if (removed > 0) log.info("dream-journal cleanup removed old logs", { removed, kept: MAX_JOURNAL_FILES });
    }

    private recordEvent(
        record: HarnessRunRecord,
        stream: HarnessRunEvent["stream"],
        kind: string,
        text?: string,
        event?: Record<string, unknown>,
    ): void {
        const entry: HarnessRunEvent = {
            id: this.nextEventSeq++,
            timestamp: Date.now(),
            stream,
            kind,
            ...(text ? { text } : {}),
            ...(event ? { event: trimJsonForDashboard(event) } : {}),
        };
        record.eventCount++;
        record.events.push(entry);
        if (record.events.length > 1000) record.events.shift();
        if (record.logPath) {
            try {
                appendFileSync(record.logPath, JSON.stringify(entry) + "\n", "utf-8");
            } catch (err) {
                log.debug("failed to append harness run log", { runId: record.id, error: String(err) });
            }
        }
    }

    private summarizeRun(record: HarnessRunRecord): Omit<HarnessRunRecord, "events"> {
        const { events: _events, ...summary } = record;
        return { ...summary };
    }

    private cloneRun(record: HarnessRunRecord): HarnessRunRecord {
        return {
            ...record,
            events: record.events.map((event) => ({
                ...event,
                event: event.event ? { ...event.event } : undefined,
            })),
        };
    }

    private collectOutput(child: ChildProcess, record: HarnessRunRecord, onResult?: () => void): void {
        let stdoutBuffer = "";
        let stderrTail = "";
        let lastEvent: Record<string, unknown> | null = null;
        const processLine = (line: string) => {
            if (!line.trim()) return;
            try {
                const event = JSON.parse(line) as Record<string, unknown>;
                lastEvent = event;
                this.recordEvent(record, "stdout", String(event.type ?? "json"), summarizeHarnessEvent(event), event);
                // Claude Code: { type: "result", cost_usd, duration_ms, result }
                // Copilot CLI: { type: "result", ... } (similar JSONL in --output-format json)
                if (event.type === "result") {
                    log.info("harness result", { cost: event.cost_usd, duration: event.duration_ms });
                    if (event.cost_usd != null) record.costUsd = Number(event.cost_usd);
                    if (event.duration_ms != null) record.durationMs = Number(event.duration_ms);
                    if (event.result) record.resultSummary = String(event.result).slice(0, 500);
                    onResult?.();
                }
            } catch {
                log.debug("harness stdout", { line: line.slice(0, 200) });
                this.recordEvent(record, "stdout", "text", line);
            }
        };
        child.stdout?.on("data", (chunk: Buffer) => {
            stdoutBuffer += chunk.toString();
            const lines = stdoutBuffer.split("\n");
            stdoutBuffer = lines.pop() ?? "";
            for (const line of lines) processLine(line);
        });
        child.once("exit", () => {
            if (stdoutBuffer.trim()) processLine(stdoutBuffer);
            stdoutBuffer = "";
            if (stderrTail.trim()) record.stderrTail = stderrTail.trim().slice(-500);
            if (!record.resultSummary && lastEvent) {
                log.debug("harness: no result event parsed, recording last JSONL event", {
                    type: lastEvent.type, keys: Object.keys(lastEvent).join(","),
                });
                record.resultSummary = `[no result event] last: ${JSON.stringify(lastEvent).slice(0, 300)}`;
            }
        });

        child.stderr?.on("data", (chunk: Buffer) => {
            const text = chunk.toString().trim();
            if (text) {
                log.warn("harness stderr", { text: text.slice(0, 500) });
                stderrTail = (stderrTail + "\n" + text).slice(-500);
                this.recordEvent(record, "stderr", "stderr", text);
            }
        });
    }
}

function normalizeStringMap(value: unknown): Record<string, string> | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key.trim())
        .map(([key, val]) => [key, String(val)] as const);
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function trimJsonForDashboard(value: Record<string, unknown>): Record<string, unknown> {
    const json = JSON.stringify(value);
    if (json.length <= 8000) return value;
    return {
        type: value.type,
        truncated: true,
        preview: json.slice(0, 8000),
    };
}

function summarizeHarnessEvent(event: Record<string, unknown>): string {
    const type = String(event.type ?? "json");
    if (type === "result") {
        const result = event.result != null ? String(event.result).trim() : "";
        const cost = event.cost_usd != null ? ` cost=$${event.cost_usd}` : "";
        const duration = event.duration_ms != null ? ` duration=${event.duration_ms}ms` : "";
        return result ? `result:${cost}${duration} ${truncate(result, 500)}` : `result:${cost}${duration}`.trim();
    }

    const message = event.message;
    if (message && typeof message === "object") {
        const msg = message as Record<string, unknown>;
        const role = typeof msg.role === "string" ? msg.role : type;
        const content = msg.content;
        const parts: string[] = [];
        if (typeof content === "string") {
            parts.push(content);
        } else if (Array.isArray(content)) {
            for (const part of content) {
                if (!part || typeof part !== "object") continue;
                const p = part as Record<string, unknown>;
                if (p.type === "text" && typeof p.text === "string") {
                    parts.push(p.text);
                } else if (p.type === "tool_use") {
                    const name = typeof p.name === "string" ? p.name : "tool";
                    const input = p.input && typeof p.input === "object"
                        ? Object.keys(p.input as Record<string, unknown>).join(",")
                        : "";
                    parts.push(`tool_use ${name}${input ? `(${input})` : ""}`);
                } else if (p.type === "tool_result") {
                    const contentText = typeof p.content === "string"
                        ? p.content
                        : JSON.stringify(p.content ?? "");
                    parts.push(`tool_result ${truncate(contentText, 300)}`);
                }
            }
        }
        if (parts.length > 0) return `${role}: ${truncate(parts.join("\n"), 700)}`;
    }

    const subtype = event.subtype ? `/${String(event.subtype)}` : "";
    return truncate(`${type}${subtype} ${JSON.stringify(event)}`, 700);
}

function truncate(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max)}...` : text;
}
