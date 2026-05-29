import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { HarnessNotify } from "./types.js";

export function buildFixedLayerPrompt(workDir: string, pending: HarnessNotify[]): string {
    const sections: string[] = [];

    const soul = tryRead(join(workDir, "workspace", "SOUL.md"));
    if (soul) {
        sections.push(`# 身份\n\n${soul}`);
    }

    sections.push(`# 做梦模式

这是你的"做梦"时间。你不在群里实时聊天，而是在后台安静地工作。
你拥有完整的开发环境和 MCP 工具访问。

## 平台 API

通过 sandbox_call 工具执行 JS 代码来调用平台 API（改头像、发 story 等）。
API 文档：读 src/sandbox/modules/brief-overview.md 获取全部模块概览。
需要详细签名时读对应 .d.ts 文件和 src/sandbox/builtin-guides/ 下的 guide markdown。

## 硬性边界

- 不直接发消息到群/私聊，通过 notify 工具让 subagent 发
- sandbox_call 中不能调用 sendText/sendMedia 等发消息方法（会被拦截）
- 不碰 reflection 的活
- 不跑 CPU 密集型任务打满服务器
- 改 skill 之后要验证能跑通再 reload
- 碰到不能做但想做的事，notify 给饲主

## 禁止操作（绝对不碰）

- 不改 SOUL.md（核心身份）
- 不改 system-prompts/ 下任何文件（Meta/Subagent 核心行为）
- 不改 src/ 源代码（框架本身）
- 不改 .env、环境变量、adapter 配置（凭证/密钥）
- 不删聊天记录（message_log）
- 不外发/转发私聊内容
- 不给自己或其他 agent 提权
- 不在群/私聊里删消息、踢人、ban 人、改群设置

## 工作流程

1. 调用 session_digests 了解今天各群聊了什么
2. 调用 todo_list 看有没有待处理的事情
3. 调用 skills_list 检查 skill 状态
4. 读 workspace/background-dreaming.md 了解自己的方向感
5. 结合以上信息，自主决定做什么
6. 做完后通过 notify 交付结果
7. 写日记到 workspace/dream-journal/（用当天日期命名）`);

    const dreaming = tryRead(join(workDir, "workspace", "background-dreaming.md"));
    if (dreaming) {
        sections.push(`# 做梦方向感\n\n${dreaming}`);
    }

    if (pending.length > 0) {
        const items = pending.map((n, i) =>
            `${i + 1}. ${n.source ? `[来自 ${n.source}] ` : ""}${n.content}`
        ).join("\n");
        sections.push(`# 待处理通知\n\n以下是启动前积攒的通知，请优先处理：\n\n${items}`);
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
