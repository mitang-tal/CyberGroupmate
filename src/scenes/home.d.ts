/**
 * home.d.ts — Home 场景类型定义 (L1)
 *
 * Home 场景是 agent 的默认起点 — 通知中心。
 * 在这里 agent 查看通知、决定下一步、切换场景。
 *
 * 始终可用的全局对象：scene, runtime, ctx, actions, skills
 */

// ─── 场景管理 ───

/** 场景管理器，用于切换和查询可用场景 */
declare const scene: {
    /**
     * 切换到指定场景。会输出目标场景的类型定义和说明。
     * @param name - 场景名称，如 "telegram", "memory"
     * @example scene.enter("telegram")
     */
    enter(name: string): void;

    /** 当前所在场景名称 */
    current: string;

    /**
     * 列出所有可用场景及简介
     * @example scene.list()
     */
    list(): void;

    /**
     * 展示当前场景的完整类型定义（L2）
     * 当 L1 精简类型不够用时调用
     */
    showFullTypes(): void;
};

// ─── Runtime API ───

/** 运行时管理器，用于后台任务和事件推送 */
declare const runtime: {
    /**
     * 推送事件到通知中心
     * @param event - 事件对象，必须包含 type 字段
     * @example runtime.notify({ type: "telegram.message", text: "hello" })
     */
    notify(event: { type: string;[key: string]: unknown }): void;

    /**
     * 启动一个命名的后台长驻任务
     * 同名任务不可重复，需先 kill
     * @param name - 任务名称
     * @param fn - 异步任务函数，接收 AbortSignal 用于检测取消
     * @example
     * runtime.spawn("listener", async (signal) => {
     *   while (!signal.aborted) {
     *     // ... 监听逻辑
     *   }
     * })
     */
    spawn(name: string, fn: (signal: AbortSignal) => Promise<void>): void;

    /**
     * 取消一个后台任务
     * @param name - 任务名称
     */
    kill(name: string): void;

    /**
     * 列出所有后台任务及状态
     * @example runtime.ps()
     */
    ps(): void;

    /**
     * 注册定时任务（cron 表达式）
     * @param expr - cron 表达式，如 "0 * * * *"（每小时）
     * @param name - 任务名称
     * @param fn - 触发时执行的函数
     */
    cron(expr: string, name: string, fn: () => Promise<void>): void;
};

// ─── Code-First Action Surface ───

declare const actions: {
    /**
     * 获取某个话题的结构化上下文
     * @example const topic = await actions.getTopicContext("topic_xxx")
     */
    getTopicContext(topicId: string): Promise<Record<string, unknown> | null>;

    /**
     * 列出当前活跃话题
     * @example const topics = await actions.listActiveTopics()
     */
    listActiveTopics(chatId?: string): Promise<Array<Record<string, unknown> | null>>;

    /**
     * 以话题为中心触发一次记忆检索
     * @example const ctx = await actions.recallForTopic("topic_xxx")
     */
    recallForTopic(topicId: string, options?: Record<string, unknown>): Promise<unknown>;
};

// ─── Skills（代码模块） ───

declare const skills: {
    memory: {
        recallAndSummarize(query: string, options?: Record<string, unknown>): Promise<unknown>;
        browseForAnswer(request: Record<string, unknown>): Promise<unknown>;
    };
    social: {
        replyInTelegram(
            chatId: number | string,
            text: string,
            opts?: { replyTo?: number }
        ): Promise<unknown>;
    };
};

// ─── 持久化上下文 ───

/**
 * 跨代码块、跨场景的持久化变量容器。
 * 在一个代码块中 ctx.xxx = ... 赋值后，后续代码块可直接使用。
 *
 * @example
 * // 代码块 1
 * ctx.client = new TelegramClient(...)
 * // 代码块 2（之后某个时间）
 * await ctx.client.sendText(...)
 */
declare const ctx: Record<string, any>;
