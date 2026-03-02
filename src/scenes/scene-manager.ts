/**
 * scene-manager.ts — 场景管理器
 *
 * 管理场景注册表和场景切换。场景系统控制 agent 在任一时刻看到的
 * TypeScript 类型定义，类似于 AVG 游戏中进入不同房间。
 *
 * 在整体架构中的位置：
 * - SceneManager 被注入到 sandbox worker 中作为 `scene` 对象
 * - Agent 通过 scene.enter/list/showFullTypes 操作场景
 * - 每个场景提供 L1 (精简) 和可选 L2 (完整) 类型定义
 */

/** 场景定义 */
export interface SceneDefinition {
    /** 场景标识符 */
    name: string;
    /** 一句话描述 */
    description: string;
    /** L1 精简类型定义字符串（.d.ts 内容） */
    typeDefs: string;
    /** L2 完整类型定义（agent 请求时展开） */
    fullTypeDefs?: string;
    /** 进入场景时的额外说明文本 */
    contextSetup?: string;
    /** 进入场景时在 sandbox 中自动执行的代码 */
    prelude?: string;
}

/**
 * SceneManager — 场景管理器
 *
 * 管理场景的注册、切换和类型定义查询。
 *
 * @example
 * ```ts
 * const sm = new SceneManager();
 * sm.register({
 *   name: "telegram",
 *   description: "Telegram 操作",
 *   typeDefs: "...",
 * });
 *
 * const info = sm.enter("telegram");
 * console.log(info.typeDefs); // L1 类型定义
 * ```
 */
export class SceneManager {
    private scenes: Map<string, SceneDefinition> = new Map();
    private _current: string = "home";

    /**
     * 当前场景名称
     */
    get current(): string {
        return this._current;
    }

    /**
     * 注册一个新场景
     *
     * @param scene - 场景定义
     * @throws 如果场景名已存在
     */
    register(scene: SceneDefinition): void {
        if (this.scenes.has(scene.name)) {
            throw new Error(`Scene "${scene.name}" is already registered.`);
        }
        this.scenes.set(scene.name, scene);
    }

    /**
     * 切换到指定场景
     *
     * 返回场景的描述、L1 类型定义和上下文说明。
     * 这些内容作为 observation 返回给 LLM。
     *
     * @param name - 目标场景名称
     * @returns 场景切换信息，包含 typeDefs 和说明文本
     * @throws 如果场景不存在
     */
    enter(name: string): {
        name: string;
        description: string;
        typeDefs: string;
        contextSetup?: string;
        prelude?: string;
    } {
        const scene = this.scenes.get(name);
        if (!scene) {
            throw new Error(
                `Scene "${name}" not found. Available scenes: ${this.listNames().join(", ")}`
            );
        }

        this._current = name;

        return {
            name: scene.name,
            description: scene.description,
            typeDefs: scene.typeDefs,
            contextSetup: scene.contextSetup,
            prelude: scene.prelude,
        };
    }

    /**
     * 列出所有可用场景及简介
     *
     * @returns 场景列表，每项含 name 和 description
     */
    list(): Array<{ name: string; description: string }> {
        return Array.from(this.scenes.values()).map((s) => ({
            name: s.name,
            description: s.description,
        }));
    }

    /**
     * 列出所有场景名称
     */
    listNames(): string[] {
        return Array.from(this.scenes.keys());
    }

    /**
     * 展示当前场景的 L2 完整类型定义
     *
     * @returns 完整类型定义字符串，不存在时返回提示信息
     */
    showFullTypes(): string {
        const scene = this.scenes.get(this._current);
        if (!scene) {
            return `[Error: current scene "${this._current}" not found]`;
        }

        if (!scene.fullTypeDefs) {
            return `[No extended type definitions available for scene "${this._current}". The L1 types shown on entry are all that's available.]`;
        }

        return scene.fullTypeDefs;
    }

    /**
     * 获取指定场景的定义
     *
     * @param name - 场景名称
     * @returns 场景定义，不存在时返回 undefined
     */
    getScene(name: string): SceneDefinition | undefined {
        return this.scenes.get(name);
    }

    /**
     * 检查场景是否存在
     */
    hasScene(name: string): boolean {
        return this.scenes.has(name);
    }
}
