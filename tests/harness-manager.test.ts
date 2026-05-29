import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { HarnessManager } from "../src/harness/manager.js";

describe("HarnessManager MCP config loading", () => {
    it("loads HTTP and stdio MCP configs and keeps cybergroupmate reserved", () => {
        const root = join(process.cwd(), "workspace", ".test-harness-manager");
        rmSync(root, { recursive: true, force: true });
        mkdirSync(join(root, "workspace"), { recursive: true });
        writeFileSync(join(root, "workspace", "mcp-connections.json"), JSON.stringify([
            {
                name: "remote-http",
                description: "HTTP MCP",
                transport: "streamable-http",
                url: "http://127.0.0.1:9999/mcp",
                headers: { Authorization: "Bearer token" },
            },
            {
                name: "stdio-tool",
                description: "stdio MCP",
                transport: "stdio",
                command: "node",
                args: ["server.js"],
                env: { API_KEY: "secret" },
            },
            {
                name: "cybergroupmate",
                transport: "streamable-http",
                url: "http://127.0.0.1:1/mcp",
            },
        ]), "utf-8");

        try {
            const manager = new HarnessManager({
                launcher: {
                    name: "test",
                    start: async () => {
                        throw new Error("not used");
                    },
                },
                workDir: root,
                mcpUrl: "http://127.0.0.1:3100/mcp",
                mcpToken: "token",
                persona: { name: "D", description: "desc" },
            });

            const loadExternal = (manager as unknown as {
                loadExternalMcpServers(): Record<string, Record<string, unknown>>;
            }).loadExternalMcpServers.bind(manager);

            assert.deepEqual(loadExternal(), {
                "remote-http": {
                    type: "streamable-http",
                    url: "http://127.0.0.1:9999/mcp",
                    headers: { Authorization: "Bearer token" },
                },
                "stdio-tool": {
                    type: "stdio",
                    command: "node",
                    args: ["server.js"],
                    env: { API_KEY: "secret" },
                },
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
