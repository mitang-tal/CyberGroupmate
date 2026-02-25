/**
 * notification-center.ts — 事件队列与 JSONL 持久化
 *
 * NotificationCenter 是系统的事件中枢。所有外部事件（Telegram 消息、cron 触发等）
 * 和内部事件（后台任务崩溃、代码执行记录等）都通过这里流转。
 *
 * 在整体架构中的位置：
 * - 后台任务通过 runtime.notify() → NC.push() 发送事件
 * - Agent main loop 通过 NC.drain() 批量取出事件
 * - 所有事件 append-only 写入 JSONL 文件，形成审计日志
 */

import { ulid } from "ulid";
import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

/** 通知事件的基础结构 */
export interface NotificationEvent {
    /** ULID 事件 ID，由 push 自动生成 */
    _id: string;
    /** 事件时间戳（ISO 8601），由 push 自动生成 */
    _ts: string;
    /** 事件类型标识，如 "telegram.message", "system.background_error" */
    type: string;
    /** 事件携带的任意数据 */
    [key: string]: unknown;
}

/** push 方法接受的输入：type + 任意附加字段，_id 和 _ts 由系统填充 */
export type NotificationInput = Omit<NotificationEvent, "_id" | "_ts"> & {
    type: string;
};

/**
 * NotificationCenter — 线程安全的内存事件队列 + append-only JSONL 持久化
 *
 * @example
 * ```ts
 * const nc = new NotificationCenter("data/events.jsonl");
 * nc.push({ type: "telegram.message", text: "hello" });
 * const events = await nc.drain(5000, 10);
 * ```
 */
export class NotificationCenter {
    private queue: NotificationEvent[] = [];
    private waiters: Array<() => void> = [];
    private logPath: string;

    /**
     * 创建 NotificationCenter 实例
     * @param logPath - JSONL 事件日志文件路径
     */
    constructor(logPath: string) {
        this.logPath = logPath;

        // 确保日志目录存在
        const dir = dirname(logPath);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
    }

    /**
     * 推入一个事件到队列，并 append 到 JSONL 日志文件
     *
     * 自动添加 `_id`（ULID）和 `_ts`（ISO 时间戳）。
     *
     * @param input - 事件数据，必须包含 `type` 字段
     * @returns 完整的事件对象（含 _id 和 _ts）
     */
    push(input: NotificationInput): NotificationEvent {
        const event: NotificationEvent = {
            ...input,
            _id: ulid(),
            _ts: new Date().toISOString(),
        };

        this.queue.push(event);

        // Append to JSONL log (synchronous to guarantee ordering)
        appendFileSync(this.logPath, JSON.stringify(event) + "\n", "utf-8");

        // 唤醒所有等待中的 drain 调用
        for (const resolve of this.waiters.splice(0)) {
            resolve();
        }

        return event;
    }

    /**
     * 异步等待并批量取出事件
     *
     * 至少等到一个事件到达或超时返回空数组。
     * 一次最多返回 `maxBatch` 条事件。
     *
     * @param timeout - 最大等待时间（毫秒），0 表示不等待
     * @param maxBatch - 单次最多取出的事件数，默认 50
     * @returns 事件数组（可能为空）
     */
    async drain(timeout: number = 5000, maxBatch: number = 50): Promise<NotificationEvent[]> {
        // 如果队列为空且 timeout > 0，等待新事件或超时
        if (this.queue.length === 0 && timeout > 0) {
            await new Promise<void>((resolve) => {
                const timer = setTimeout(() => {
                    // 超时：从 waiters 中移除自己
                    const idx = this.waiters.indexOf(resolve);
                    if (idx !== -1) this.waiters.splice(idx, 1);
                    resolve();
                }, timeout);

                // 注册 waiter，被 push 唤醒时清除 timer
                const wrappedResolve = () => {
                    clearTimeout(timer);
                    resolve();
                };
                this.waiters.push(wrappedResolve);
            });
        }

        // 取出最多 maxBatch 条事件
        const batch = this.queue.splice(0, maxBatch);
        return batch;
    }

    /**
     * 获取当前队列中的待处理事件数量
     */
    get pendingCount(): number {
        return this.queue.length;
    }
}
