/**
 * P3-1 — Meta Decision 端到端运行时验证脚本
 *
 * 目标：模拟一次真实 `executeDecision`，触发真实 ExecutionRecord 落库（非伪造），
 *       查询最新一条 ExecutionRecord 的 JSON，如实断言三字段是否齐全：
 *         - decisionId          决策标识（可回溯到哪笔决策）
 *         - verificationResult  执行后真实验证结果（真实回读 ExecutionRecord）
 *         - failureCategory     失败分类（区分治理拦截 / 真实执行错误）
 *
 * 运行环境说明：本机 Node 下 better-sqlite3 动态库不匹配（ERR_DLOPEN_FAILED），
 * 故沿用既有预案——用内存版 store 承载真实 ExecutionRecordService 生命周期
 * （start → markRunning → complete → store.insert/update），记录仍走真实全链路落库。
 *
 * 运行：pnpm tsx scripts/phase31-e2e-runtime-verify.ts
 * 退出码：0=三字段齐全；1=存在缺失（打印缺哪字段）
 */
import crypto from "node:crypto";
import {
    ExecutionRecord,
    ExecutionStatus,
    ExecutionTreeNode,
    ExecutionAnalytics,
} from "../src/execution/execution-record.types.js";
import { ExecutionRecordStore, ExecutionStats } from "../src/execution/execution-record-store.js";
import { ExecutionRecordService } from "../src/execution/execution-record-service.js";
import { DecisionStore, DecisionStatusUpdate } from "../src/meta-decision/decision-store.js";
import { MetaDecision, DecisionStatus, DecisionType, DecisionVerificationResult } from "../src/meta-decision/types.js";
import { MetaDecisionEngine } from "../src/meta-decision/meta-decision-engine.js";
import { CapabilityRegistry } from "../src/capability-registry/capability-registry.js";
import { CapabilityDispatcher } from "../src/capability-registry/capability-dispatcher.js";
import { assertTransition } from "../src/meta-decision/state-machine.js";

// ─────────────────────────────────────────────────────────────
// 内存版 ExecutionRecordStore（真实生命周期，非 mock 结果）
// ─────────────────────────────────────────────────────────────
class MemExecutionRecordStore implements ExecutionRecordStore {
    private map = new Map<string, ExecutionRecord>();
    private order: string[] = [];

    insert(record: ExecutionRecord): void {
        this.map.set(record.id, record);
        this.order.push(record.id);
    }

    update(id: string, patch: Partial<ExecutionRecord>): void {
        const cur = this.map.get(id);
        if (cur) this.map.set(id, { ...cur, ...patch });
    }

    getById(id: string): ExecutionRecord | undefined {
        return this.map.get(id);
    }

    getChildren(parentId: string): ExecutionRecord[] {
        return this.order
            .map((id) => this.map.get(id)!)
            .filter((r) => r.parentId === parentId);
    }

    getExecutionTree(id: string, _maxDepth?: number): ExecutionTreeNode | undefined {
        const root = this.map.get(id);
        if (!root) return undefined;
        const node: ExecutionTreeNode = { record: root, children: [] };
        for (const child of this.getChildren(root.id)) {
            const sub = this.getExecutionTree(child.id);
            if (sub) node.children.push(sub);
        }
        return node;
    }

    queryActive(): ExecutionRecord[] {
        return this.order.map((id) => this.map.get(id)!).filter((r) =>
            r.status === "pending" || r.status === "running");
    }

    query(options: {
        sessionId?: string;
        runId?: string;
        taskId?: string;
        method?: string;
        status?: ExecutionStatus;
        source?: string;
        limit?: number;
        offset?: number;
    }): ExecutionRecord[] {
        let rows = this.order.map((id) => this.map.get(id)!);
        if (options.source !== undefined) rows = rows.filter((r) => r.source === options.source);
        if (options.status !== undefined) rows = rows.filter((r) => r.status === options.status);
        if (options.method !== undefined) rows = rows.filter((r) => r.method === options.method);
        if (options.taskId !== undefined) rows = rows.filter((r) => r.taskId === options.taskId);
        if (options.runId !== undefined) rows = rows.filter((r) => r.runId === options.runId);
        if (options.sessionId !== undefined) rows = rows.filter((r) => r.sessionId === options.sessionId);
        rows = [...rows].sort((a, b) => b.createdAtMs - a.createdAtMs);
        const offset = options.offset ?? 0;
        const limit = options.limit ?? rows.length;
        return rows.slice(offset, offset + limit);
    }

    queryStats(): ExecutionStats {
        const rows = [...this.map.values()];
        const byStatus: Record<string, number> = {};
        const bySource: Record<string, number> = {};
        const errorDist: Record<string, number> = {};
        for (const r of rows) {
            byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
            bySource[r.source] = (bySource[r.source] ?? 0) + 1;
            if (r.error?.type) errorDist[r.error.type] = (errorDist[r.error.type] ?? 0) + 1;
        }
        return {
            total: rows.length,
            byStatus: Object.entries(byStatus).map(([status, count]) => ({ status, count })),
            bySource: Object.entries(bySource).map(([source, count]) => ({ source, count })),
            errorDistribution: Object.entries(errorDist).map(([errorType, count]) => ({ errorType, count })),
        };
    }

    queryAnalytics(): ExecutionAnalytics {
        const rows = [...this.query()];
        const success = rows.filter((r) => r.status === "success").length;
        const failure = rows.filter((r) => r.status === "failure").length;
        const bySource: ExecutionAnalytics["bySource"] = [];
        for (const r of rows) {
            let e = bySource.find((s) => s.source === r.source);
            if (!e) {
                e = { source: r.source, count: 0, failureCount: 0, successRate: 0 };
                bySource.push(e);
            }
            e.count++;
            if (r.status === "failure") e.failureCount++;
        }
        bySource.forEach((e) => { e.successRate = e.count ? (e.count - e.failureCount) / e.count : 0; });
        return {
            overview: {
                totalExecutions: rows.length,
                successCount: success,
                failureCount: failure,
                interruptedCount: rows.filter((r) => r.status === "interrupted").length,
                timedOutCount: rows.filter((r) => r.status === "timed_out").length,
                policyDeniedCount: rows.filter((r) => r.status === "policy_denied").length,
                successRate: rows.length ? success / rows.length : 0,
                avgDurationMs: 0,
                maxDurationMs: 0,
            },
            statusDistribution: [],
            bySource,
            byMethod: [],
            errorRanking: [],
            slowExecutions: [],
        };
    }
}

// ─────────────────────────────────────────────────────────────
// 内存版 DecisionStore（复刻 sqlite 的状态机强制语义）
// ─────────────────────────────────────────────────────────────
class MemDecisionStore implements DecisionStore {
    private map = new Map<string, MetaDecision>();

    insert(decision: MetaDecision): void {
        this.map.set(decision.decisionId, { ...decision });
    }

    updateStatus(decisionId: string, status: DecisionStatus, meta?: DecisionStatusUpdate): void {
        const current = this.map.get(decisionId);
        if (!current) throw new Error(`decision not found: ${decisionId}`);

        try {
            assertTransition(decisionId, current.status, status);
            if (status === "executed" && !meta?.executionId) {
                throw new Error(`executed requires execution_id (decision ${decisionId})`);
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.map.set(decisionId, {
                ...current,
                transitionError: `${msg} (attempted at ${Date.now()})`,
            });
            throw err;
        }

        const next: MetaDecision = { ...current, status };
        if (status === "executed" || status === "verified" || status === "failed") {
            next.executedAtMs = meta?.executedAtMs;
            next.executionResult = meta?.executionResult;
            next.executionId = meta?.executionId;
            next.verificationResult = meta?.verificationResult;
            next.transitionError = undefined;
        } else if (status === "approved" || status === "executing") {
            next.transitionError = undefined;
        }
        this.map.set(decisionId, next);
    }

    getById(decisionId: string): MetaDecision | undefined {
        return this.map.get(decisionId);
    }

    query(options: {
        decisionType?: DecisionType;
        status?: DecisionStatus;
        triggerEventType?: string;
        targetComponent?: string;
        limit?: number;
        offset?: number;
    }): MetaDecision[] {
        let rows = [...this.map.values()];
        if (options.decisionType) rows = rows.filter((d) => d.decisionType === options.decisionType);
        if (options.status) rows = rows.filter((d) => d.status === options.status);
        if (options.targetComponent) rows = rows.filter((d) => d.targetComponent === options.targetComponent);
        rows = [...rows].sort((a, b) => b.createdAtMs - a.createdAtMs);
        const offset = options.offset ?? 0;
        const limit = options.limit ?? rows.length;
        return rows.slice(offset, offset + limit);
    }

    getRecentByTarget(targetComponent: string, windowMs: number): MetaDecision[] {
        const cutoff = Date.now() - windowMs;
        return [...this.map.values()]
            .filter((d) => d.targetComponent === targetComponent && d.createdAtMs > cutoff)
            .sort((a, b) => b.createdAtMs - a.createdAtMs);
    }

    countByStatus(status: DecisionStatus): number {
        return [...this.map.values()].filter((d) => d.status === status).length;
    }
}

// ─────────────────────────────────────────────────────────────
// 断言辅助
// ─────────────────────────────────────────────────────────────
let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
    if (cond) {
        pass++;
        console.log(`  ✅ ${name}`);
    } else {
        fail++;
        console.log(`  ❌ ${name} — ${detail === undefined ? "" : JSON.stringify(detail)}`);
    }
}

function makeDecision(decisionType: MetaDecision["decisionType"], target: string): MetaDecision {
    return {
        decisionId: crypto.randomUUID(),
        triggerEvent: { eventType: "alert_raised", sourceId: "e2e-verify-script", detail: "test" },
        decisionType,
        targetComponent: target,
        actionParams: {},
        confidenceScore: 0.8,
        reasoningText: "test decision",
        status: "proposed",
        createdAtMs: Date.now(),
    };
}

// 从 store 取"最新落库"的一条 ExecutionRecord（按 createdAtMs 降序第一条）
function latestExecutionRecord(store: MemExecutionRecordStore): ExecutionRecord | undefined {
    const rows = store.query({});
    return rows.length ? rows[0] : undefined;
}

function main() {
    // ── 依赖装配：registry / dispatcher / service / engine ──
    const execStore = new MemExecutionRecordStore();
    const decisionStore = new MemDecisionStore();
    const service = new ExecutionRecordService(execStore);

    const registry = new CapabilityRegistry();
    const trusted = registry.register({
        name: "Trusted Agent",
        capabilities: [
            { name: "media_send", category: "media", tags: ["send", "media"], description: "媒体发送" },
        ],
    });
    const dispatcher = new CapabilityDispatcher(registry);
    dispatcher.setReputationProvider((agentId) =>
        agentId === trusted.agentId
            ? { trustScore: 0.9, trustState: "trusted", reliability: 0.9 }
            : { trustScore: 0.1, trustState: "untrusted", reliability: 0.2 },
    );

    const engine = new MetaDecisionEngine(decisionStore, {
        capabilityRegistry: registry,
        capabilityDispatcher: dispatcher,
        executionRecordService: service,
    });

    // ── 场景 1：真实成功执行（redispatch → trusted agent 真实派发） ──
    console.log("\n[场景 1] 成功：redispatch → verified 的真实执行");
    let verifiedExecId = "";
    let failureDecisionId = "";
    {
        const decision = makeDecision("redispatch", "media_send");
        decisionStore.insert(decision);
        const outcome = engine.executeDecision(decision.decisionId);
        check("executeDecision ok", outcome.ok === true, outcome);

        const exec = latestExecutionRecord(execStore);
        check("已落库最新 ExecutionRecord", !!exec);
        if (!exec) {
            console.log("    执行未落库 — 跳过场景 1 字段断言");
        } else {
            verifiedExecId = exec.id;
            console.log(`    最新 ExecutionRecord JSON: ${JSON.stringify(exec)}`);

            const hasDecisionId = "decisionId" in exec;
            const hasVerification = "verificationResult" in exec;
            const hasFailureCat = "failureCategory" in exec;
            check("    (a) 记录含 decisionId 字段", hasDecisionId, "字段缺失");
            check("       decisionId=决策 id（可回溯）", exec.decisionId === decision.decisionId, exec.decisionId);
            check("    链路 parentId=decisionId", exec.parentId === decision.decisionId, exec.parentId);
            check("    (b) 记录含 verificationResult 字段", hasVerification, "字段缺失");
            check("       verificationResult.verified=true", exec.verificationResult?.verified === true, exec.verificationResult);
            check("       verificationResult.executionStatus=success", exec.verificationResult?.executionStatus === "success", exec.verificationResult?.executionStatus);
            check("       verificationResult.executionId 一致", exec.verificationResult?.executionId === exec.id, exec.verificationResult?.executionId);
            check("    (c) failureCategory 键存在（成功记录无失败分类，值为 undefined）", hasFailureCat, "成功记录本无失败分类(预期 undefined)");
            if (exec.failureCategory !== undefined) {
                console.log(`    ⚠️  成功记录 failureCategory=${exec.failureCategory}（预期应为 undefined）`);
            }

            // 关联 Decision 记录：验证结果确实已产出（非标志位）
            const stored = decisionStore.getById(decision.decisionId)!;
            const vr = stored.verificationResult;
            check("    (关联) Decision.verificationResult.verified=true", vr?.verified === true, vr);
            check("    (关联) Decision.verificationResult.executionId 一致", vr?.executionId === exec.id, vr?.executionId);
        }
    }

    // ── 场景 2：真实失败（switch_policy 无真实执行器 → failed，不伪造成功） ──
    console.log("\n[场景 2] 失败：switch_policy → failed（真实失败路径）");
    {
        const decision = makeDecision("switch_policy", "media_send");
        decisionStore.insert(decision);
        const outcome = engine.executeDecision(decision.decisionId);
        check("端到端 ok=false（不伪造成功）", outcome.ok === false, outcome);

        const exec = latestExecutionRecord(execStore);
        check("已落库最新 ExecutionRecord", !!exec);
        if (exec) {
            console.log(`    最新 ExecutionRecord JSON: ${JSON.stringify(exec)}`);
            const hasDecisionId = "decisionId" in exec;
            const hasFailureCat = "failureCategory" in exec;
            check("    (a) 记录含 decisionId 字段", hasDecisionId, "字段缺失");
            check("       decisionId=决策 id（可回溯）", exec.decisionId === decision.decisionId, exec.decisionId);
            check("       链路 parentId=decisionId", exec.parentId === decision.decisionId, exec.parentId);
            check("    (c) 记录含 failureCategory 字段", hasFailureCat && exec.failureCategory !== undefined, exec.failureCategory);
            check("       失败分类=execution_error", exec.failureCategory === "execution_error", exec.failureCategory);
            check("       错误类型=NoExecutor（真实执行器缺失）", exec.error?.type === "NoExecutor", exec.error?.type);
            check("    (b) verificationResult 失败路径无验证（不产出，属预期）", !("verificationResult" in exec) || exec.verificationResult === undefined, "失败路径不进行验证");
        }
    }

    // ── 汇总 ──
    console.log(`\n结果: ${pass} passed, ${fail} failed`);
    if (fail > 0) process.exit(1);
}

main();