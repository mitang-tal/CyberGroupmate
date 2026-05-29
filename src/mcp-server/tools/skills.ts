import { z } from "zod";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpServerDeps } from "../types.js";

export function registerSkillsTools(mcp: McpServer, deps: McpServerDeps): void {
    mcp.tool(
        "skills_list",
        "List all available skills in workspace/skills/. Returns skill names and whether they have a .ts entry point or skill.md.",
        async () => {
            const skillsDir = join(deps.workspaceRoot, "workspace", "skills");
            try {
                const entries = await readdir(skillsDir, { withFileTypes: true });
                const skills = [];
                for (const entry of entries) {
                    if (!entry.isDirectory() || entry.name === "node_modules") continue;
                    const skillPath = join(skillsDir, entry.name);
                    const files = await readdir(skillPath).catch((): string[] => []);
                    skills.push({
                        name: entry.name,
                        hasTs: files.some((f: string) => f.endsWith(".ts") || f.endsWith(".d.ts")),
                        hasMd: files.includes("skill.md"),
                        files,
                    });
                }
                return { content: [{ type: "text" as const, text: JSON.stringify(skills, null, 2) }] };
            } catch (err) {
                return { content: [{ type: "text" as const, text: `Error listing skills: ${err}` }], isError: true };
            }
        },
    );

    mcp.tool(
        "skills_readFile",
        "Read a specific file from a skill directory.",
        {
            skillName: z.string().describe("Skill directory name (e.g. 'tavily', 'danbooru')"),
            fileName: z.string().describe("File name within the skill directory"),
        },
        async ({ skillName, fileName }) => {
            if (skillName.includes("..") || fileName.includes("..")) {
                return { content: [{ type: "text" as const, text: "Path traversal not allowed" }], isError: true };
            }
            const filePath = join(deps.workspaceRoot, "workspace", "skills", skillName, fileName);
            try {
                const content = await readFile(filePath, "utf-8");
                return { content: [{ type: "text" as const, text: content }] };
            } catch (err) {
                return { content: [{ type: "text" as const, text: `Error reading file: ${err}` }], isError: true };
            }
        },
    );
}
