import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { HarnessNotify } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..");

export function buildFixedLayerPrompt(workDir: string, pending: HarnessNotify[]): string {
    const sections: string[] = [];

    const soul = tryRead(join(workDir, "workspace", "SOUL.md"));
    if (soul) {
        sections.push(`# 身份\n\n${soul}`);
    }

    const dreamingMode = tryRead(join(PROJECT_ROOT, "system-prompts", "harness", "dreaming-mode.md"));
    if (dreamingMode) {
        sections.push(dreamingMode);
    }

    const dreaming = tryRead(join(workDir, "workspace", "background-dreaming.md"));
    if (dreaming) {
        sections.push(`# 最近的方向感\n\n这是你从最近的日常聊天中积累下来的感受和想法，可以参考，但不用被它牵着走。\n\n${dreaming}`);
    }

    if (pending.length > 0) {
        const items = pending.map((n, i) =>
            `${i + 1}. ${n.source ? `[来自 ${n.source}] ` : ""}${n.content}`
        ).join("\n");
        sections.push(`# 有人找你\n\n这些是启动前积攒的通知：\n\n${items}`);
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
