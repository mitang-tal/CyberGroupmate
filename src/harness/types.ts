import type { ChildProcess } from "node:child_process";

export interface HarnessLaunchOptions {
    prompt: string;
    systemPrompt: string;
    mcpConfigJson: string;
    workDir: string;
    model?: string;
    maxBudgetUsd?: number;
    extraArgs?: string[];
}

export interface HarnessLauncher {
    name: string;
    start(options: HarnessLaunchOptions): Promise<ChildProcess>;
}

export interface HarnessNotify {
    content: string;
    source?: string;
}

export type HarnessRunEventStream = "system" | "stdout" | "stderr";

export interface HarnessRunEvent {
    id: number;
    timestamp: number;
    stream: HarnessRunEventStream;
    kind: string;
    text?: string;
    event?: Record<string, unknown>;
}

export interface HarnessRunRecord {
    id: string;
    startedAt: number;
    endedAt?: number;
    exitCode?: number | null;
    trigger: "scheduled" | "enqueued";
    pendingCount: number;
    harness: string;
    mcpServers?: string[];
    logPath?: string;
    harnessHome?: string;
    instructionPath?: string;
    pid?: number;
    durationMs?: number;
    costUsd?: number;
    stderrTail?: string;
    resultSummary?: string;
    events: HarnessRunEvent[];
    eventCount: number;
}
