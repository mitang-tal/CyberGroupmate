/**
 * notification-center.ts — 事件队列与 JSONL 持久化
 *
 * NotificationCenter 是系统的事件中枢。所有外部事件（Telegram 消息、cron 触发等）
 * 和内部事件（后台任务崩溃、代码执行记录等）都通过这里流转。
 *
 * 支持跨进程通知：通过 fs.watch 监视 JSONL 文件变更，
 * 当外部进程（如 CLI）写入新事件时自动读取并加入队列。
 */

import { monotonicFactory } from "ulid";
import {
    appendFileSync,
    mkdirSync,
    existsSync,
    readFileSync,
    statSync,
    watch,
    FSWatcher,
} from "node:fs";
import { dirname } from "node:path";

const ulidGen = monotonicFactory();

/** 通知事件的基础结构 */
export interface NotificationEvent {
    /** ULID 事件 ID，由 push 自动生成 */
    _id: string;
    /** 事件时间戳（ISO 8601），由 push 自动生成 */
    _ts: string;
    /** 事件类型标识，如 "telegram.message", "system.background_error" */
    type: string;
    /** 是否为加急事件（立即触发 drain） */
    _urgent?: boolean;
    /** 事件携带的任意数据 */
    [key: string]: unknown;
}

/** push 方法接受的输入：type + 任意附加字段，_id 和 _ts 由系统填充 */
export type NotificationInput = Omit<NotificationEvent, "_id" | "_ts"> & {
    type: string;
};

/**
 * NotificationCenter — 内存事件队列 + append-only JSONL 持久化 + 文件监视
 *
 * 支持：
 * - 同进程 push → drain 立即唤醒
 * - 跨进程 push（CLI 追加 JSONL）→ fs.watch 检测 → 自动读入队列
 * - 加急事件（_urgent: true）→ 立即唤醒 drain
 *
 * @example
 * ```ts
 * const nc = new NotificationCenter("data/events.jsonl");
 * nc.push({ type: "telegram.message", text: "hello" });
 * const events = await nc.drain(5000, 10);
 * nc.dispose(); // 停止文件监视
 * ```
 */
export class NotificationCenter {
    private queue: NotificationEvent[] = [];
    private waiters: Array<() => void> = [];
    private logPath: string;

    /** 已知的事件 ID 集合（防止重复读取） */
    private knownIds = new Set<string>();

    /** JSONL 文件上次已读的字节偏移 */
    private fileOffset: number = 0;

    /** 文件监视器 */
    private watcher: FSWatcher | null = null;

    /** 是否正在自己写文件（避免自触发） */
    private selfWriting = false;

    /**
     * 创建 NotificationCenter 实例
     * @param logPath - JSONL 事件日志文件路径
     * @param enableWatch - 是否启用文件监视（默认 true，测试时可关闭）
     */
    constructor(logPath: string, enableWatch: boolean = true) {
        this.logPath = logPath;

        // 确保日志目录存在
        const dir = dirname(logPath);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }

        // 记录当前文件大小作为初始偏移（忽略历史数据）
        if (existsSync(logPath)) {
            try {
                this.fileOffset = statSync(logPath).size;
            } catch {
                this.fileOffset = 0;
            }
        }

        // 启用文件监视：检测外部进程追加的事件
        if (enableWatch) {
            this.startWatching();
        }
    }

    /**
     * 推入一个事件到队列，并 append 到 JSONL 日志文件
     */
    push(input: NotificationInput): NotificationEvent {
        const event: NotificationEvent = {
            ...input,
            _id: ulidGen(),
            _ts: new Date().toISOString(),
        };

        this.queue.push(event);
        this.knownIds.add(event._id);

        // Append to JSONL (synchronous to guarantee ordering)
        this.selfWriting = true;
        appendFileSync(this.logPath, JSON.stringify(event) + "\n", "utf-8");
        this.selfWriting = false;

        // 更新偏移
        try {
            this.fileOffset = statSync(this.logPath).size;
        } catch { /* ignore */ }

        // 唤醒所有等待中的 drain 调用
        this.wakeWaiters();

        return event;
    }

    /**
     * 异步等待并批量取出事件
     *
     * @param timeout - 最大等待时间（毫秒），0 表示不等待
     * @param maxBatch - 单次最多取出的事件数，默认 50
     * @returns 事件数组（可能为空）
     */
    async drain(
        timeout: number = 5000,
        maxBatch: number = 50
    ): Promise<NotificationEvent[]> {
        // 如果队列为空且 timeout > 0，等待新事件或超时
        if (this.queue.length === 0 && timeout > 0) {
            await new Promise<void>((resolve) => {
                const timer = setTimeout(() => {
                    const idx = this.waiters.indexOf(wrappedResolve);
                    if (idx !== -1) this.waiters.splice(idx, 1);
                    resolve();
                }, timeout);

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

    /**
     * 停止文件监视（清理资源）
     */
    dispose(): void {
        if (this.watcher) {
            this.watcher.close();
            this.watcher = null;
        }
    }

    // ─── 内部方法 ───

    /**
     * 启动文件监视，检测外部进程追加的事件
     */
    private startWatching(): void {
        try {
            // 确保文件存在
            if (!existsSync(this.logPath)) {
                appendFileSync(this.logPath, "", "utf-8");
            }

            this.watcher = watch(this.logPath, () => {
                // 忽略自己的写入
                if (this.selfWriting) return;
                this.readNewEntries();
            });

            // 不阻塞进程退出
            this.watcher.unref();
        } catch {
            // watch 不支持的环境下静默降级
        }
    }

    /**
     * 读取 JSONL 文件中自上次读取以来的新行
     */
    private readNewEntries(): void {
        try {
            const stat = statSync(this.logPath);
            if (stat.size <= this.fileOffset) return;

            // 读取新增部分
            const fd = readFileSync(this.logPath, "utf-8");
            const newContent = fd.slice(this.fileOffset);
            this.fileOffset = stat.size;

            // 逐行解析
            const lines = newContent.split("\n").filter((l) => l.trim());
            let added = 0;

            for (const line of lines) {
                try {
                    const event = JSON.parse(line) as NotificationEvent;
                    // 跳过已知事件（自己 push 的）
                    if (event._id && this.knownIds.has(event._id)) continue;

                    this.knownIds.add(event._id);
                    this.queue.push(event);
                    added++;
                } catch {
                    // 解析失败的行跳过
                }
            }

            // 有新事件则唤醒 waiter
            if (added > 0) {
                this.wakeWaiters();
            }
        } catch {
            // 读取失败静默忽略
        }
    }

    /**
     * 唤醒所有等待中的 drain
     */
    private wakeWaiters(): void {
        for (const resolve of this.waiters.splice(0)) {
            resolve();
        }
    }
}
