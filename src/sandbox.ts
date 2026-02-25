/**
 * sandbox.ts — Sandbox Host 侧管理
 *
 * 管理 sandbox worker 子进程的生命周期。通过 stdin/stdout JSON 行协议
 * 与 worker 通信，提供代码执行和崩溃检测能力。
 *
 * 在整体架构中的位置：
 * - Orchestrator (main.ts) 创建 Sandbox 实例
 * - Agent 的 CodeAct session 通过 sandbox.execute() 提交代码
 * - Worker 通过 notify 消息将事件转发到 NotificationCenter
 */

import { spawn, ChildProcess } from "node:child_process";
import { createInterface, Interface } from "node:readline";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** 执行结果 */
export interface ExecutionResult {
    /** 代码产生的输出（console.log 捕获） */
    output: string;
    /** 是否有错误 */
    error: boolean;
}

/** Worker → Host 消息 */
interface WorkerMessage {
    type: "result" | "notify";
    id?: string;
    output?: string;
    error?: boolean;
    event?: Record<string, unknown>;
}

/**
 * Sandbox — 代码执行沙箱的 Host 侧管理器
 *
 * 通过 child_process.spawn 启动 worker 子进程，通过 JSON 行协议通信。
 * 支持代码执行、超时控制和崩溃检测。
 *
 * @example
 * ```ts
 * const sandbox = new Sandbox();
 * await sandbox.start();
 * const result = await sandbox.execute('console.log("hello")', 5000);
 * console.log(result.output); // "hello"
 * ```
 */
export class Sandbox extends EventEmitter {
    private child: ChildProcess | null = null;
    private rl: Interface | null = null;
    private pendingRequests: Map<
        string,
        {
            resolve: (result: ExecutionResult) => void;
            reject: (err: Error) => void;
            timer?: ReturnType<typeof setTimeout>;
        }
    > = new Map();
    private requestCounter = 0;
    private projectRoot: string;

    /**
     * 创建 Sandbox 实例
     * @param projectRoot - 项目根目录，用于定位 sandbox-worker.ts
     */
    constructor(projectRoot?: string) {
        super();
        this.projectRoot = projectRoot ?? join(__dirname, "..");
    }

    /**
     * 启动 worker 子进程
     *
     * 返回的 Promise 在 worker 发送 ready 信号后 resolve。
     */
    async start(): Promise<void> {
        if (this.child) {
            throw new Error("Sandbox already started");
        }

        const workerPath = join(this.projectRoot, "src", "sandbox-worker.ts");

        this.child = spawn("npx", ["tsx", workerPath], {
            stdio: ["pipe", "pipe", "pipe"],
            cwd: this.projectRoot,
            env: { ...process.env },
        });

        // 读取 stderr 用于调试（不阻塞）
        this.child.stderr?.on("data", (data: Buffer) => {
            this.emit("stderr", data.toString());
        });

        // 监听子进程退出
        this.child.on("exit", (code, signal) => {
            this.emit("exit", code, signal);
            // 拒绝所有 pending 请求
            for (const [id, req] of this.pendingRequests) {
                req.reject(
                    new Error(
                        `Sandbox worker exited (code=${code}, signal=${signal}) while request ${id} was pending`
                    )
                );
                if (req.timer) clearTimeout(req.timer);
            }
            this.pendingRequests.clear();
            this.child = null;
            this.rl = null;
        });

        this.child.on("error", (err) => {
            this.emit("error", err);
        });

        // 按行读取 stdout
        this.rl = createInterface({
            input: this.child.stdout!,
            terminal: false,
        });

        this.rl.on("line", (line: string) => {
            this.handleWorkerMessage(line);
        });

        // 等待 worker ready
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error("Sandbox worker did not become ready within 10s"));
            }, 10000);

            this.pendingRequests.set("__ready__", {
                resolve: () => {
                    clearTimeout(timer);
                    resolve();
                },
                reject: (err) => {
                    clearTimeout(timer);
                    reject(err);
                },
            });
        });
    }

    /**
     * 处理 worker 发来的消息
     */
    private handleWorkerMessage(line: string): void {
        let msg: WorkerMessage;
        try {
            msg = JSON.parse(line);
        } catch {
            // 忽略非 JSON 输出
            return;
        }

        if (msg.type === "result" && msg.id) {
            const pending = this.pendingRequests.get(msg.id);
            if (pending) {
                this.pendingRequests.delete(msg.id);
                if (pending.timer) clearTimeout(pending.timer);
                pending.resolve({
                    output: msg.output ?? "",
                    error: msg.error ?? false,
                });
            }
        } else if (msg.type === "notify" && msg.event) {
            // 转发事件，由 Orchestrator 接入 NotificationCenter
            this.emit("notify", msg.event);
        }
    }

    /**
     * 在 sandbox 中执行代码
     *
     * @param code - 要执行的 TypeScript/JavaScript 代码
     * @param timeout - 超时时间（毫秒），默认 30000
     * @returns 执行结果（含输出和错误标志）
     * @throws 如果超时或 worker 已退出
     */
    async execute(code: string, timeout: number = 30000): Promise<ExecutionResult> {
        if (!this.child || !this.child.stdin) {
            throw new Error("Sandbox worker is not running");
        }

        const id = `req_${++this.requestCounter}`;

        return new Promise<ExecutionResult>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingRequests.delete(id);
                reject(new Error(`Code execution timed out after ${timeout}ms`));
            }, timeout);

            this.pendingRequests.set(id, { resolve, reject, timer });

            const msg = JSON.stringify({ type: "execute", id, code });
            this.child!.stdin!.write(msg + "\n");
        });
    }

    /**
     * 检查 worker 子进程是否存活
     */
    isAlive(): boolean {
        return this.child !== null && this.child.exitCode === null;
    }

    /**
     * 停止 worker 子进程
     */
    async stop(): Promise<void> {
        if (!this.child) return;

        return new Promise<void>((resolve) => {
            this.child!.once("exit", () => {
                this.child = null;
                this.rl = null;
                resolve();
            });
            this.child!.kill("SIGTERM");

            // 强制 kill 超时
            setTimeout(() => {
                if (this.child) {
                    this.child.kill("SIGKILL");
                }
            }, 3000);
        });
    }
}
