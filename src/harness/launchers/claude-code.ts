import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../../core/logger.js";
import type { HarnessLaunchOptions, HarnessLauncher } from "../types.js";

const log = createLogger("harness-claude-code");

export class ClaudeCodeLauncher implements HarnessLauncher {
    readonly name = "claude-code";
    private claudePath: string;

    constructor(claudePath?: string) {
        this.claudePath = claudePath ?? "claude";
    }

    async start(options: HarnessLaunchOptions): Promise<ChildProcess> {
        const mcpConfigPath = join(options.workDir, "workspace", ".background-mcp-config.json");
        mkdirSync(join(options.workDir, "workspace"), { recursive: true });
        writeFileSync(mcpConfigPath, options.mcpConfigJson, "utf-8");

        const args = [
            "-p", options.prompt,
            "--verbose",
            "--output-format", "stream-json",
            "--dangerously-skip-permissions",
            "--mcp-config", mcpConfigPath,
            "--strict-mcp-config",
        ];

        if (options.model) {
            args.push("--model", options.model);
        }

        if (options.maxBudgetUsd) {
            args.push("--max-budget-usd", String(options.maxBudgetUsd));
        }

        log.info("launching claude code", {
            claude: this.claudePath,
            model: options.model ?? "(default)",
            maxBudget: options.maxBudgetUsd ?? "(none)",
        });

        const child = spawn(this.claudePath, args, {
            cwd: options.workDir,
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "background-agent" },
        });

        return child;
    }
}
