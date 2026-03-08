/**
 * shared/scene.d.ts — 所有 scene 共享的场景管理能力
 */

declare const scene: {
    /**
     * 切换到指定场景。会输出目标场景的类型定义和说明。
     * @param name - 场景名称，如 "telegram", "memory"
     */
    enter(name: string): void;

    /** 当前所在场景名称 */
    current: string;

    /** 列出所有可用场景及简介 */
    list(): void;

    /** 展示当前场景的完整类型定义（L2） */
    showFullTypes(): void;
};
