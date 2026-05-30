import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { HarnessNotify } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..");

export function buildSystemPrompt(
    workDir: string,
    persona: { name: string; description: string },
): string {
    const sections: string[] = [];

    sections.push(`# 身份\n\n你是「${persona.name}」。\n\n${persona.description}`);

    const dreamingMode = tryRead(join(PROJECT_ROOT, "system-prompts", "harness", "dreaming-mode.md"));
    if (dreamingMode) {
        sections.push(dreamingMode);
    }

    sections.push(`# 工作区\n\n当前项目根目录是：\`${workDir}\`。`);

    return sections.join("\n\n---\n\n");
}

export function buildTaskPrompt(
    workDir: string,
    pending: HarnessNotify[],
): string {
    const sections: string[] = [];

    // 不把回顾内容内联进 prompt（可达上百 KB，会撑爆命令行参数导致 spawn E2BIG），
    // 只指引 agent 自己去读这个文件。
    const dreaming = tryRead(join(workDir, "workspace", "background-dreaming.md"));
    if (dreaming) {
        sections.push(
            "# 本周期回顾\n\n" +
            "`workspace/background-dreaming.md` 里是你这个周期（上次做梦以来）通过 subagent 实际做过的事，" +
            "按聊天分组，并附了每个群的关系画像和可用的 MCP 探索入口。\n\n" +
            "先把它完整读一遍，作为今晚做梦的起点。",
        );
    }

    if (pending.length > 0) {
        const items = pending.map((n, i) =>
            `${i + 1}. ${n.source ? `[来自 ${n.source}] ` : ""}${n.content}`
        ).join("\n");
        sections.push(`# 有人找你\n\n这些是启动前积攒的通知：\n\n${items}`);
    }

    if (sections.length === 0) {
        sections.push("# 本次任务\n\n进行一次后台做梦：回顾最近可用的上下文，寻找值得整理、研究、维护或交给其他 agent 的方向。");
    }

    return sections.join("\n\n---\n\n");
}

function tryRead(path: string): string | null {
    try {
        return readFileSync(path, "utf-8").trim();
    } catch {
        return null;
    }
}
