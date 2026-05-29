import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpServerDeps } from "../types.js";

export function registerSchedulerTools(mcp: McpServer, deps: McpServerDeps): void {
    mcp.tool(
        "reminder_list",
        "List all reminders, optionally filtered by binding ID.",
        {
            bindingId: z.string().optional().describe("Filter by binding ID"),
            includeTriggered: z.boolean().optional().describe("Include already-triggered reminders"),
        },
        async ({ bindingId, includeTriggered }) => {
            const result = await deps.metaApi.remind.list({ bindingId, includeTriggered });
            return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
        },
    );

    mcp.tool(
        "cron_list",
        "List all cron jobs, optionally filtered by binding ID.",
        {
            bindingId: z.string().optional().describe("Filter by binding ID"),
        },
        async ({ bindingId }) => {
            const result = await deps.metaApi.cron.list({ bindingId });
            return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
        },
    );
}
