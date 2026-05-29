import type { ChildProcess } from "node:child_process";
import { createLogger } from "../core/logger.js";
import { buildFixedLayerPrompt } from "./prompt.js";
import type { HarnessLauncher, HarnessNotify, HarnessRunRecord } from "./types.js";

const log = createLogger("harness-manager");

export interface HarnessManagerConfig {
    launcher: HarnessLauncher;
    workDir: string;
    mcpUrl: string;
    mcpToken: string;
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
    private consecutiveFailures = 0;
    private lastError: string | null = null;
    onSpawnFailure?: (error: string, pendingCount: number) => void;

    constructor(config: HarnessManagerConfig) {
        this.config = config;
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

    getStatus(): { running: boolean; queueLength: number; historyCount: number; lastRun?: HarnessRunRecord; lastError: string | null; consecutiveFailures: number; harness: string } {
        return {
            running: this.running,
            queueLength: this.pendingQueue.length,
            historyCount: this.history.length,
            lastRun: this.history[this.history.length - 1],
            lastError: this.lastError,
            consecutiveFailures: this.consecutiveFailures,
            harness: this.config.launcher.name,
        };
    }

    async shutdown(): Promise<void> {
        this.shuttingDown = true;
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
        const prompt = buildFixedLayerPrompt(this.config.workDir, pending);

        const mcpConfig = {
            mcpServers: {
                cybergroupmate: {
                    type: "streamable-http" as const,
                    url: `${this.config.mcpUrl}?token=${this.config.mcpToken}`,
                },
            },
        };

        const record: HarnessRunRecord = {
            startedAt: Date.now(),
            trigger,
            pendingCount: pending.length,
            harness: this.config.launcher.name,
        };

        let receivedResult = false;

        try {
            this.child = await this.config.launcher.start({
                prompt,
                mcpConfigJson: JSON.stringify(mcpConfig, null, 2),
                workDir: this.config.workDir,
                model: this.config.model,
                maxBudgetUsd: this.config.maxBudgetUsd,
                extraArgs: this.config.extraArgs,
            });

            record.pid = this.child.pid ?? undefined;

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

                this.child = null;
                this.running = false;

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
        this.pendingQueue.unshift(...pending);
        if (!record.endedAt) record.endedAt = Date.now();
        if (record.exitCode == null) record.exitCode = -1;
        this.history.push(record);
        if (this.history.length > 50) this.history.shift();
        this.child = null;
        this.running = false;
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

    private drainQueue(): HarnessNotify[] {
        const items = [...this.pendingQueue];
        this.pendingQueue = [];
        return items;
    }

    private collectOutput(child: ChildProcess, record: HarnessRunRecord, onResult?: () => void): void {
        let stdoutBuffer = "";
        let stderrTail = "";
        const processLine = (line: string) => {
            if (!line.trim()) return;
            try {
                const event = JSON.parse(line);
                // Claude Code: event.type === "result"
                // Copilot CLI: event.type === "result" (same format in JSONL mode)
                if (event.type === "result") {
                    log.info("harness result", { cost: event.cost_usd, duration: event.duration_ms });
                    if (event.cost_usd != null) record.costUsd = event.cost_usd;
                    if (event.duration_ms != null) record.durationMs = event.duration_ms;
                    if (event.result) record.resultSummary = String(event.result).slice(0, 500);
                    onResult?.();
                }
            } catch {
                log.debug("harness stdout", { line: line.slice(0, 200) });
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
        });

        child.stderr?.on("data", (chunk: Buffer) => {
            const text = chunk.toString().trim();
            if (text) {
                log.warn("harness stderr", { text: text.slice(0, 500) });
                stderrTail = (stderrTail + "\n" + text).slice(-500);
            }
        });
    }
}
