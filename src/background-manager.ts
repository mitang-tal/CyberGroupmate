/**
 * background-manager.ts — 后台任务管理器
 *
 * 管理 agent 通过 runtime.spawn() 创建的后台长驻任务。
 * 每个任务运行在 async 协程中，通过 AbortController 支持取消。
 *
 * 在整体架构中的位置：
 * - 运行在 sandbox worker 进程内
 * - Agent 代码通过 runtime.spawn/kill/ps 间接操作
 * - 任务崩溃时自动推送 system.background_error 事件到 NotificationCenter
 */

/** 后台任务的状态 */
export type TaskStatus = "running" | "done" | "error" | "cancelled";

/** 后台任务信息 */
export interface TaskInfo {
    /** 任务名称 */
    name: string;
    /** 当前状态 */
    status: TaskStatus;
    /** 启动时间（ISO 8601） */
    startedAt: string;
    /** 结束时间（ISO 8601），尚未结束则为 null */
    endedAt: string | null;
    /** 错误信息（如果状态为 error） */
    error?: string;
}

/** 内部任务记录 */
interface TaskRecord {
    info: TaskInfo;
    abortController: AbortController;
    promise: Promise<void>;
}

/**
 * BackgroundManager — 后台任务管理器
 *
 * 管理命名的后台异步任务，支持启动、取消和状态查询。
 * 任务崩溃时通过回调通知（用于推送到 NotificationCenter）。
 *
 * @example
 * ```ts
 * const bg = new BackgroundManager((event) => nc.push(event));
 *
 * bg.spawn("listener", async (signal) => {
 *   while (!signal.aborted) {
 *     const msg = await getNextMessage();
 *     runtime.notify({ type: "telegram.message", ...msg });
 *   }
 * });
 *
 * console.log(bg.ps()); // [{ name: "listener", status: "running", ... }]
 * bg.kill("listener");
 * ```
 */
export class BackgroundManager {
    private tasks: Map<string, TaskRecord> = new Map();
    private notifyCallback: (event: Record<string, unknown>) => void;

    /**
     * 创建 BackgroundManager 实例
     * @param notifyCallback - 任务崩溃时调用，推送错误事件
     */
    constructor(notifyCallback: (event: Record<string, unknown>) => void) {
        this.notifyCallback = notifyCallback;
    }

    /**
     * 启动一个命名的后台协程
     *
     * 同名任务不可重复启动，需先 kill。
     * 任务函数接收 AbortSignal 参数，用于检测取消请求。
     *
     * @param name - 任务名称（唯一标识）
     * @param fn - 异步任务函数，接收 AbortSignal
     * @throws 如果同名任务已在运行中
     */
    spawn(name: string, fn: (signal: AbortSignal) => Promise<void>): void {
        const existing = this.tasks.get(name);
        if (existing && existing.info.status === "running") {
            throw new Error(
                `Task "${name}" is already running. Kill it first with kill("${name}").`
            );
        }

        const abortController = new AbortController();
        const info: TaskInfo = {
            name,
            status: "running",
            startedAt: new Date().toISOString(),
            endedAt: null,
        };

        // guardedRun: 包裹任务执行，捕获异常并推送错误事件
        const promise = this.guardedRun(name, fn, abortController.signal);

        this.tasks.set(name, { info, abortController, promise });
    }

    /**
     * 包裹任务执行的安全运行器
     *
     * 捕获非正常取消的异常，自动推送 system.background_error 事件。
     * 这是 CodeAct "自动错误反馈 → 自我调试" 理念的延伸。
     */
    private async guardedRun(
        name: string,
        fn: (signal: AbortSignal) => Promise<void>,
        signal: AbortSignal
    ): Promise<void> {
        const record = () => this.tasks.get(name);

        try {
            await fn(signal);

            // 正常结束
            const r = record();
            if (r) {
                r.info.status = "done";
                r.info.endedAt = new Date().toISOString();
            }
        } catch (err: unknown) {
            const r = record();
            if (!r) return;

            // 区分正常取消和异常崩溃
            if (signal.aborted) {
                r.info.status = "cancelled";
                r.info.endedAt = new Date().toISOString();
            } else {
                const errorMsg =
                    err instanceof Error
                        ? `${err.name}: ${err.message}`
                        : String(err);
                const stack = err instanceof Error ? err.stack : undefined;

                r.info.status = "error";
                r.info.error = errorMsg;
                r.info.endedAt = new Date().toISOString();

                // 推送错误事件到 NotificationCenter
                this.notifyCallback({
                    type: "system.background_error",
                    taskName: name,
                    error: errorMsg,
                    stack: stack ?? "",
                });
            }
        }
    }

    /**
     * 通过 AbortController 取消指定任务
     *
     * @param name - 要取消的任务名称
     * @returns 是否成功发送取消信号（任务存在且正在运行时返回 true）
     */
    kill(name: string): boolean {
        const task = this.tasks.get(name);
        if (!task || task.info.status !== "running") {
            return false;
        }

        task.abortController.abort();
        return true;
    }

    /**
     * 列出所有任务及其状态
     *
     * @returns 任务信息数组（含已结束的任务）
     */
    ps(): TaskInfo[] {
        return Array.from(this.tasks.values()).map((t) => ({ ...t.info }));
    }

    /**
     * 获取当前运行中的任务数量
     */
    get runningCount(): number {
        let count = 0;
        for (const t of this.tasks.values()) {
            if (t.info.status === "running") count++;
        }
        return count;
    }

    /**
     * 停止所有运行中的任务
     */
    killAll(): void {
        for (const [name, task] of this.tasks) {
            if (task.info.status === "running") {
                task.abortController.abort();
            }
        }
    }
}
