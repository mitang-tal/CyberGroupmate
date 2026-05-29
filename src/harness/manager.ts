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
}

export class HarnessManager {
    private config: HarnessManagerConfig;
    private running = false;
    private child: ChildProcess | null = null;
    private pendingQueue: HarnessNotify[] = [];
    private history: HarnessRunRecord[] = [];

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
        if (!this.running) {
            this.pendingQueue.push(notify);
            void this.launch("enqueued");
        } else {
            this.pendingQueue.push(notify);
            log.info("enqueue: instance running, queued", { queueLength: this.pendingQueue.length });
        }
    }

    triggerScheduled(): void {
        if (this.running) {
            log.info("triggerScheduled: instance already running, skipping");
            return;
        }
        void this.launch("scheduled");
    }

    getStatus(): { running: boolean; queueLength: number; historyCount: number; lastRun?: HarnessRunRecord } {
        return {
            running: this.running,
            queueLength: this.pendingQueue.length,
            historyCount: this.history.length,
            lastRun: this.history[this.history.length - 1],
        };
    }

    async shutdown(): Promise<void> {
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

    private async launch(trigger: "scheduled" | "enqueued"): Promise<void> {
        if (this.running) return;
        this.running = true;

        const pending = this.drainQueue();
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
        };

        try {
            this.child = await this.config.launcher.start({
                prompt,
                mcpConfigJson: JSON.stringify(mcpConfig, null, 2),
                workDir: this.config.workDir,
                model: this.config.model,
                maxBudgetUsd: this.config.maxBudgetUsd,
            });

            log.info("launch: harness started", {
                launcher: this.config.launcher.name,
                pid: this.child.pid,
                trigger,
                pendingCount: pending.length,
            });

            this.collectOutput(this.child);

            this.child.once("exit", (code) => {
                record.endedAt = Date.now();
                record.exitCode = code;
                this.history.push(record);
                if (this.history.length > 50) this.history.shift();

                const durationSec = ((record.endedAt - record.startedAt) / 1000).toFixed(1);
                log.info("launch: harness exited", { code, durationSec, trigger });

                this.child = null;
                this.running = false;

                if (this.pendingQueue.length > 0) {
                    log.info("launch: pending queue not empty, relaunching", { queueLength: this.pendingQueue.length });
                    void this.launch("enqueued");
                }
            });

            this.child.once("error", (err) => {
                log.error("launch: harness process error", { error: String(err) });
                record.endedAt = Date.now();
                record.exitCode = -1;
                this.history.push(record);
                this.child = null;
                this.running = false;
            });
        } catch (err) {
            log.error("launch: failed to start harness", { error: String(err) });
            record.endedAt = Date.now();
            record.exitCode = -1;
            this.history.push(record);
            this.running = false;
        }
    }

    private drainQueue(): HarnessNotify[] {
        const items = [...this.pendingQueue];
        this.pendingQueue = [];
        return items;
    }

    private collectOutput(child: ChildProcess): void {
        child.stdout?.on("data", (chunk: Buffer) => {
            for (const line of chunk.toString().split("\n")) {
                if (!line.trim()) continue;
                try {
                    const event = JSON.parse(line);
                    if (event.type === "result") {
                        log.info("harness result", { cost: event.cost_usd, duration: event.duration_ms });
                    }
                } catch {
                    log.debug("harness stdout", { line: line.slice(0, 200) });
                }
            }
        });

        child.stderr?.on("data", (chunk: Buffer) => {
            const text = chunk.toString().trim();
            if (text) log.warn("harness stderr", { text: text.slice(0, 500) });
        });
    }
}
