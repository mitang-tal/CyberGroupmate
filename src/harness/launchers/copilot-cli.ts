import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../../core/logger.js";
import { buildHarnessEnv, getHarnessHome, writeHarnessInstructions } from "../home.js";
import { serializeCopilotMcpConfig } from "../mcp-config.js";
import type { HarnessLaunchOptions, HarnessLauncher } from "../types.js";

const log = createLogger("harness-copilot-cli");

export class CopilotCliLauncher implements HarnessLauncher {
    readonly name = "copilot";
    private copilotPath: string;

    constructor(copilotPath?: string) {
        this.copilotPath = copilotPath ?? "copilot";
    }

    async start(options: HarnessLaunchOptions): Promise<ChildProcess> {
        const mcpConfigPath = join(options.workDir, "workspace", ".background-mcp-config.json");
        const homeDir = getHarnessHome(options.workDir, this.name);
        mkdirSync(join(options.workDir, "workspace"), { recursive: true });
        writeFileSync(mcpConfigPath, serializeCopilotMcpConfig(options.mcpConfig), "utf-8");
        const instructionPath = writeHarnessInstructions(homeDir, this.name, options.systemPrompt);

        const args = [
            "-p", options.prompt,
            "--output-format", "json",
            "--yolo",
            "--additional-mcp-config", `@${mcpConfigPath}`,
        ];

        if (options.model) {
            args.push("--model", options.model);
        }

        if (options.extraArgs) {
            args.push(...options.extraArgs);
        }

        log.info("launching copilot cli", {
            copilot: this.copilotPath,
            model: options.model ?? "(default)",
            home: homeDir,
            instructionPath,
        });

        const child = spawn(this.copilotPath, args, {
            cwd: options.workDir,
            stdio: ["ignore", "pipe", "pipe"],
            env: buildHarnessEnv(process.env, homeDir, { COPILOT_HOME: join(homeDir, ".copilot") }),
        });

        const cleanup = () => { try { unlinkSync(mcpConfigPath); } catch {} };
        child.once("exit", cleanup);
        child.once("error", cleanup);

        return child;
    }
}
