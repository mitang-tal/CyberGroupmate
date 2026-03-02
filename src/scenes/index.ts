/**
 * scenes/index.ts — 场景注册表
 *
 * 将所有内置场景注册到 SceneManager。
 * 新增场景时只需在此文件中添加注册调用。
 *
 * 类型定义文件（.d.ts）通过 fs 读取内容字符串，
 * 作为 agent 的 observation 返回给 LLM。
 */

import { SceneManager } from "./scene-manager.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * 读取场景类型定义文件内容
 * @param filename - 文件名（相对于 scenes 目录）
 * @returns 文件内容字符串
 */
function readTypeDefs(filename: string): string {
    return readFileSync(join(__dirname, filename), "utf-8");
}

/**
 * 注册所有内置场景到 SceneManager
 *
 * @param sm - SceneManager 实例
 * @example
 * ```ts
 * const sm = new SceneManager();
 * registerBuiltinScenes(sm);
 * ```
 */
export function registerBuiltinScenes(sm: SceneManager): void {
    // ─── Home 场景 ───
    sm.register({
        name: "home",
        description:
            "通知中心。查看通知、决定下一步、切换场景。基础 runtime API 可用。",
        typeDefs: readTypeDefs("home.d.ts"),
        contextSetup:
            "你现在在 Home 场景。这是你的起始点。\n" +
            "你可以通过 scene.list() 查看所有可用场景，\n" +
            "通过 scene.enter(name) 切换到其他场景来执行操作。",
    });

    // ─── Telegram 场景 ───
    sm.register({
        name: "telegram",
        description:
            "Telegram 操作。发送/读取消息、获取对话列表、搜索消息、设置消息监听。",
        typeDefs: readTypeDefs("telegram.d.ts"),
        contextSetup:
            "你现在在 Telegram 场景。ctx.tg 是 TelegramClient 实例。\n" +
            "你可以读取和发送消息、获取对话列表、搜索消息历史。\n" +
            "使用 runtime.spawn() 设置后台消息监听。",
    });

    // ─── Memory 场景 ───
    sm.register({
        name: "memory",
        description:
            "记忆系统 V2。统一检索(recall)、消息档案(browseHistory)、反思(reflect)、以及兼容的搜索/画像管理。",
        typeDefs: readTypeDefs("memory.d.ts"),
        contextSetup:
            "你现在在 Memory 场景。memory 是 MemoryStore 实例（V2 stub）。\n" +
            "V2 新方法：recall()（语义检索）、browseHistory()（翻聊天记录）、reflect()（反思总结）。\n" +
            "V1 兼容方法：search()、store()、getPerson()、updatePerson()、addTodo() 等仍可使用。\n" +
            "注意：当前为占位实现，读操作返回空、写操作静默丢弃。后续接入真实数据层。",
    });
}
