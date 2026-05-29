import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type HarnessInstructionTarget = "claude-code" | "copilot" | string;

export function getHarnessHome(env: NodeJS.ProcessEnv = process.env): string {
    return env.HOME || env.USERPROFILE || homedir();
}

export function getHarnessInstructionPath(homeDir: string, launcherName: HarnessInstructionTarget): string {
    if (launcherName === "copilot") {
        return join(homeDir, ".copilot", "copilot-instructions.md");
    }
    return join(homeDir, ".claude", "CLAUDE.md");
}

export function writeHarnessInstructions(homeDir: string, launcherName: HarnessInstructionTarget, systemPrompt: string): string {
    const instructionPath = getHarnessInstructionPath(homeDir, launcherName);
    mkdirSync(dirname(instructionPath), { recursive: true });
    writeFileSync(instructionPath, systemPrompt.trim() + "\n", "utf-8");
    return instructionPath;
}

export function buildHarnessEnv(
    baseEnv: NodeJS.ProcessEnv,
    overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
    return {
        ...baseEnv,
        ...overrides,
    };
}
