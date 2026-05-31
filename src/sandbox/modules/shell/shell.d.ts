/**
 * shell.d.ts — 终端 Tab 管理模块
 *
 * 提供类似 tmux/terminal tabs 的多终端管理能力。
 * 主终端 "default" 是所有 ```bash``` 代码块的执行目标。
 * 当主终端被长时间运行的服务阻塞时，可以将其 detach 到后台并获得全新主终端。
 */

declare const shell: {
    /**
     * 列出所有存活的终端 Tab 及其状态。
     *
     * @returns 每个 tab 的 id、状态和最近输出预览
     *
     * @example
     * const tabs = await shell.listTabs();
     * // [{ id: "default", state: "idle", recentOutput: "..." },
     * //  { id: "web-server", state: "busy", recentOutput: "Listening on :3000" }]
     */
    listTabs(): Promise<Array<{
        id: string;
        state: "idle" | "busy";
        recentOutput: string;
    }>>;

    /**
     * 分离当前主终端到后台，并立刻获得一个全新的 default 终端。
     *
     * 当主终端被长时间运行的命令（如 `npm run dev`）阻塞时：
     * 1. 当前 default 终端被重命名为 newTabId 并移入后台
     * 2. 系统自动创建全新的 default 终端
     * 3. 后续 ```bash``` 代码块将在新终端中执行
     *
     * @param newTabId 后台标签名（如 "web-server"、"db"）
     *
     * @example
     * // 启动 dev server（会超时，但进程仍在运行）
     * // ```bash
     * // npm run dev
     * // ```
     * // 收到 [⚠ Command timed out]
     *
     * // 将被阻塞的终端移到后台，释放主通道
     * await shell.detach("dev-server");
     *
     * // 现在可以继续在新的 default 终端工作
     */
    detach(newTabId: string): Promise<void>;

    /**
     * 读取指定终端的输出历史。
     *
     * 用于排查超时命令的残留输出，或查看后台服务日志。
     * 默认读取 default 终端，可指定 tabId 读取后台终端。
     *
     * @param tabId 终端标签 ID（默认 "default"）
     * @param lines 返回最近 N 行（默认 50）
     *
     * @example
     * // 查看 dev-server 的运行日志
     * const logs = await shell.read("dev-server", 20);
     * console.log(logs);
     */
    read(tabId?: string, lines?: number): Promise<string>;

    /**
     * 在独立后台终端**非阻塞地**启动一条长命令，**立即返回**，不卡住当前轮次。
     *
     * 这是处理耗时命令（编译 / 转码 / 长下载 / dev server）的首选方式：
     * 启动后你可以马上去回复别的消息、做别的事。Host 侧会监视这个命令，
     * 并在下列任一情况发生时，**自动给你派发一个新任务**让你回来查看（都**不会 kill 进程**）：
     * - **完成**：命令结束（带退出码）。
     * - **空闲超时**：距上次输出超过 `idleTimeout` 仍未结束（可能卡住 / 在等输入）。
     * - **硬上限**：运行时长达到 `maxDuration` 仍未结束。
     *
     * 期间你也可以随时主动用 `shell.read(tabId)` 查看进度；想停就 `shell.kill(tabId)`，
     * 要喂输入就 `shell.sendInput(input, tabId)`。
     *
     * 注意两种超时的区别：
     * - `idleTimeout` 针对"卡死/无响应"——一直有输出的长编译**不会**因它触发。
     * - `maxDuration` 是总时长兜底——即使一直在刷输出，到点也会叫你回来看一眼。
     *
     * @param command 要在后台运行的命令
     * @param opts.tabId 后台终端名（省略则自动命名 bg-N；不可为 "default"）
     * @param opts.idleTimeout 多久无输出判定空闲并唤醒，毫秒（默认 120000；传 0 关闭）
     * @param opts.maxDuration 运行硬上限并唤醒，毫秒（默认 1800000=30 分钟；传 0 关闭）
     * @returns 立即返回 { tabId }，命令已在后台启动
     *
     * @example
     * // 启动一个长编译，立刻返回去做别的事；跑完/卡住会自动叫你回来
     * const { tabId } = await shell.run("npm run build", { idleTimeout: 60000, maxDuration: 1800000 });
     * // …本轮可以继续回复消息、结束 session…
     * // 之后收到新任务时：const log = await shell.read(tabId); 决定下一步
     */
    run(
        command: string,
        opts?: { tabId?: string; idleTimeout?: number; maxDuration?: number },
    ): Promise<{ tabId: string }>;

    /**
     * 向指定终端注入按键输入。
     *
     * 用于应对交互式 CLI 的确认提示（如 "Is this ok? (y/N)"）。
     * 也可发送 Ctrl+C（"\x03"）来优雅地中断进程。
     *
     * @param input 要发送的文本（如 "y\n"、"\x03"）
     * @param tabId 目标终端（默认 "default"）
     *
     * @example
     * // 对交互提示输入 y
     * await shell.sendInput("y\n");
     *
     * @example
     * // 向后台服务发送 Ctrl+C 停止它
     * await shell.sendInput("\x03", "dev-server");
     */
    sendInput(input: string, tabId?: string): Promise<void>;

    /**
     * 销毁指定终端中的所有进程并回收该 tab。
     * 如果销毁的是 default 终端，会自动创建新的 default。
     *
     * @param tabId 要销毁的终端（默认 "default"）
     *
     * @example
     * // 强制结束并回收一个后台终端
     * await shell.kill("dev-server");
     *
     * // 重置卡死的主终端
     * await shell.kill();
     */
    kill(tabId?: string): Promise<void>;

    /**
     * 获取当前主终端的工作目录。
     */
    cwd(): Promise<string>;
};
