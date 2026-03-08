/**
 * shared/scene.d.ts — 所有 scene 共享的场景管理能力
 */

declare const scene: {
    /**
     * 切换到指定场景。会输出目标场景的类型定义和说明。
     * @param name - 场景名称，如 "telegram", "memory"
     */
    enter(name: string, focus?: {
        chatId?: string;
        userId?: string;
        messageId?: string;
    }): never;

    /**
     * 切换当前处理焦点。常用于进入某个 scene 时显式绑定目标 chat。
     */
    focus(target: {
        scene?: string;
        chatId?: string;
        userId?: string;
        messageId?: string;
    }): never;

    /** 当前所在场景名称 */
    current: string;

    /** 列出所有可用场景及简介 */
    list(): void;

    /** 展示当前场景的完整类型定义（L2） */
    showFullTypes(): void;
};
