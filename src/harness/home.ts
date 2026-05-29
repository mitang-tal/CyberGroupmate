import { mkdirSync, writeFileSync } from "node:fs";
import { join, parse } from "node:path";

export type HarnessInstructionTarget = "claude-code" | "copilot" | string;

export function getHarnessHome(workDir: string, launcherName: string): string {
    return join(workDir, "workspace", "harness-home", launcherName);
}

export function getHarnessInstructionPath(homeDir: string, launcherName: HarnessInstructionTarget): string {
    if (launcherName === "copilot") {
        return join(homeDir, ".copilot", "copilot-instructions.md");
    }
    return join(homeDir, ".claude", "CLAUDE.md");
}

export function writeHarnessInstructions(homeDir: string, launcherName: HarnessInstructionTarget, systemPrompt: string): string {
    const instructionPath = getHarnessInstructionPath(homeDir, launcherName);
    mkdirSync(parse(instructionPath).dir, { recursive: true });
    writeFileSync(instructionPath, systemPrompt.trim() + "\n", "utf-8");
    return instructionPath;
}

export function buildHarnessEnv(
    baseEnv: NodeJS.ProcessEnv,
    homeDir: string,
    overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
    const parsed = parse(homeDir);
    const env: NodeJS.ProcessEnv = {
        ...baseEnv,
        ...overrides,
        HOME: homeDir,
        USERPROFILE: homeDir,
    };

    if (parsed.root.length >= 2 && parsed.root[1] === ":") {
        env.HOMEDRIVE = parsed.root.slice(0, 2);
        env.HOMEPATH = homeDir.slice(2) || "\\";
    }

    return env;
}
