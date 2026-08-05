/**
 * SandboxStateVirtualizer — 内存沙盒虚拟状态机
 *
 * #15 决策：纯逻辑模拟 + 快照/恢复接口。
 * 推演期间在内存虚拟状态上 apply，结束后整体 restore，
 * 保证沙盒推演对真实运行态无副作用（0 副作用、低延迟）。
 */

export interface SandboxStateSnapshot {
    state: Record<string, unknown>;
    createdAtMs: number;
}

export class SandboxStateVirtualizer {
    private state: Record<string, unknown> = {};

    constructor(initialState: Record<string, unknown> = {}) {
        this.state = { ...initialState };
    }

    get<T>(key: string): T | undefined {
        return this.state[key] as T | undefined;
    }

    set(key: string, value: unknown): void {
        this.state[key] = value;
    }

    remove(key: string): void {
        delete this.state[key];
    }

    snapshot(): SandboxStateSnapshot {
        return { state: { ...this.state }, createdAtMs: Date.now() };
    }

    restore(snapshot: SandboxStateSnapshot): void {
        this.state = { ...snapshot.state };
    }

    readAll(): Record<string, unknown> {
        return { ...this.state };
    }
}