/**
 * platform-adapter.ts — 平台接入抽象
 *
 * 定义平台 adapter 的统一接口。当前实现仍兼容 bootstrap listener，
 * 但新的 ingress 边界应逐步迁到这里。
 */

export interface PlatformAdapter {
    readonly platform: string;
    start(): Promise<void>;
    stop(): Promise<void>;
    getSendContext(): Record<string, unknown>;
}
