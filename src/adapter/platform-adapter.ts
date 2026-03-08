/**
 * platform-adapter.ts — 平台接入抽象
 *
 * 定义平台 adapter 的统一接口。
 * 平台连接、消息监听、消息标准化、以及面向 sandbox 的 host-call
 * 都应通过官方 adapter 暴露，而不是由 bootstrap 代码自行创建监听器。
 */

export interface PlatformAdapter {
    readonly platform: string;
    start(): Promise<void>;
    stop(): Promise<void>;
    canHandle(method: string): boolean;
    handleCall(method: string, args: unknown[]): Promise<unknown>;
    getSceneTypeDefs?(scene: string, baseTypeDefs: string): string | undefined;
}
