import type { ChildProcess } from "node:child_process";

export interface HarnessLaunchOptions {
    prompt: string;
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

export interface HarnessRunRecord {
    startedAt: number;
    endedAt?: number;
    exitCode?: number | null;
    trigger: "scheduled" | "enqueued";
    pendingCount: number;
}
