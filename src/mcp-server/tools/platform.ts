import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpServerDeps } from "../types.js";

const SANDBOX_CALL_TIMEOUT = 120_000;

export function registerPlatformTools(mcp: McpServer, deps: McpServerDeps): void {
    mcp.tool(
        "sandbox_call",
        "Execute JavaScript code in a sandbox with access to platform modules (telegram, discord, qq, etc.), skills, fs, runtime, memory, and other sandbox APIs. Use this for platform self-operations (changing avatar/bio, posting stories), running skills, file operations, and any multi-step platform workflow. Read src/sandbox/modules/brief-overview.md for available APIs, and .d.ts files for detailed signatures.",
        {
            code: z.string().describe("JavaScript code to execute. All sandbox globals are available: telegram, fs, runtime, skills, memory, todo, mcp, vision, shell, etc."),
        },
        async ({ code }) => {
            const sandbox = await deps.sandboxPool.acquire("__background__");
            try {
                const result = await sandbox.execute(code, SANDBOX_CALL_TIMEOUT);
                return {
                    content: [{ type: "text" as const, text: result.error ? `Error:\n${result.output}` : (result.output || "(no output)") }],
                    isError: result.error,
                };
            } catch (err) {
                return {
                    content: [{ type: "text" as const, text: `Sandbox execution failed: ${err}` }],
                    isError: true,
                };
            } finally {
                deps.sandboxPool.release("__background__");
            }
        },
    );
}
