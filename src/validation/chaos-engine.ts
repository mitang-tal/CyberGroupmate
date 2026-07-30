/**
 * ChaosEngine — 故障注入基础设施
 *
 * 支持注入的故障类型：
 * - agent_offline: 将注册的 Agent 标记为 offline
 * - tool_failure: 模拟特定工具的调用失败
 * - llm_timeout: 模拟 LLM 调用超时
 * - host_call_error: 模拟 host_call 返回异常
 * - memory_corruption: 模拟 Memory 损坏/不可用
 */

export type ChaosFaultType =
    | "agent_offline"
    | "tool_failure"
    | "llm_timeout"
    | "host_call_error"
    | "memory_corruption";

export interface ChaosInjection {
    faultType: ChaosFaultType;
    targetComponent: string;
    durationMs: number;
    probability: number; // 0-1, 故障触发概率
}

export interface ChaosTestResult {
    testName: string;
    faultType: ChaosFaultType;
    targetComponent: string;
    injectedAtMs: number;
    durationMs: number;
    systemSurvived: boolean;
    recoveryTimeMs?: number;
    observations: string[];
}

export class ChaosEngine {
    private activeInjections: Map<string, ChaosInjection> = new Map();
    private results: ChaosTestResult[] = [];

    /**
     * 注册一个故障注入
     */
    inject(fault: ChaosInjection): string {
        const id = `${fault.faultType}:${fault.targetComponent}:${Date.now()}`;
        this.activeInjections.set(id, fault);

        // Auto-expire
        setTimeout(() => {
            this.activeInjections.delete(id);
        }, fault.durationMs);

        return id;
    }

    /**
     * 移除故障注入
     */
    remove(id: string): boolean {
        return this.activeInjections.delete(id);
    }

    /**
     * 检查某个组件是否被注入了特定类型的故障
     */
    shouldFail(faultType: ChaosFaultType, component: string): boolean {
        for (const injection of this.activeInjections.values()) {
            if (injection.faultType === faultType && injection.targetComponent === component) {
                if (Math.random() < injection.probability) {
                    return true;
                }
            }
        }
        return false;
    }

    /**
     * 获取所有活跃的注入
     */
    listActiveInjections(): ChaosInjection[] {
        return Array.from(this.activeInjections.values());
    }

    /**
     * 记录测试结果
     */
    recordResult(result: ChaosTestResult): void {
        this.results.push(result);
    }

    /**
     * 查询历史测试结果
     */
    getResults(limit = 50): ChaosTestResult[] {
        return this.results.slice(-limit).reverse();
    }

    /**
     * 获取统计摘要
     */
    getSummary(): { totalTests: number; passed: number; failed: number; passRate: number } {
        const total = this.results.length;
        const passed = this.results.filter((r) => r.systemSurvived).length;
        const failed = total - passed;
        return {
            totalTests: total,
            passed,
            failed,
            passRate: total > 0 ? Math.round((passed / total) * 10000) / 100 : 0,
        };
    }

    /**
     * 清除所有注入和结果
     */
    reset(): void {
        this.activeInjections.clear();
        this.results = [];
    }
}
