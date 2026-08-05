/**
 * Audit Fix Phase 3.3 — Loop Prevention 独立验收脚本
 *
 * 验证内容：
 * 1. 同一 execution_id 连续 replan 3 次（count=1/2/3）正常，第 4 次被系统阻断（LoopPreventionError）
 * 2. 计数来源是系统 ReplanPlan 持久化记录，走真实 DynamicReplanner.applyTaskPatch 链路
 * 3. 不同 execution_id 的 replan 计数相互独立
 * 4. 调用方传入 replanCount 被忽略（payload 类型已移除该字段；运行时即使以 any 传入也不影响）
 * 5. 阈值优先级：governance policy config > 环境变量 > 默认值 3
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteGovernanceStore } from "../src/governance/sqlite-governance-store.js";
import { GlobalGuardrailEvaluator } from "../src/governance/global-guardrail-evaluator.js";
import { LoopPreventionError } from "../src/governance/loop-prevention-error.js";
import { SqliteTaskPatchStore } from "../src/task-planner/sqlite-task-patch-store.js";
import { DynamicReplanner } from "../src/task-planner/dynamic-replanner.js";
import { SqliteExecutionRecordStore } from "../src/execution/sqlite-execution-record-store.js";
import { SqliteAlertStore } from "../src/execution/sqlite-alert-store.js";
import { SqliteHealingStore } from "../src/execution/sqlite-healing-store.js";
import { ExecutionRecordService } from "../src/execution/execution-record-service.js";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string) {
    if (cond) {
        pass++;
        console.log(`  ✅ ${name}`);
    } else {
        fail++;
        console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
    }
}

/** 构造真实执行树：parent(agent.turn) → child(host_call, failure)，用于 generateTaskPatch/applyTaskPatch */
function buildFailureTrace(service: ExecutionRecordService): { parentId: string; childId: string } {
    const parentId = service.start({ source: "agent", method: "agent.turn" });
    service.markRunning(parentId);
    const childId = service.start({ source: "host_call", method: "telegram_send", parentId });
    service.markRunning(childId);
    service.complete(childId, "failure", { error: { type: "ApiError", message: "upload failed" } });
    return { parentId, childId };
}

function main() {
    const dir = mkdtempSync(join(tmpdir(), "cg-phase33-verify-"));
    const govPath = join(dir, "governance.db");
    const patchPath = join(dir, "patches.db");
    const execPath = join(dir, "exec.db");
    const alertPath = join(dir, "alert.db");
    const healingPath = join(dir, "healing.db");

    const govStore = new SqliteGovernanceStore(govPath);
    const guardrail = new GlobalGuardrailEvaluator(govStore);

    const patchStore = new SqliteTaskPatchStore(patchPath);
    const execStore = new SqliteExecutionRecordStore(execPath);
    const alertStore = new SqliteAlertStore(alertPath);
    const healingStore = new SqliteHealingStore(healingPath);
    const service = new ExecutionRecordService(execStore, alertStore, healingStore);

    const replanner = new DynamicReplanner(patchStore, service);
    // 真实接线：replan 入口护栏 + 系统侧计数提供者（计数来自 ReplanPlan 持久化记录）
    replanner.setGuardrailEvaluator(guardrail);
    guardrail.setReplanCounterProvider((executionId) => replanner.getReplanCount(executionId));

    // ─── 1. 同一 execution_id 连续 replan 3 次正常，第 4 次阻断 ───
    console.log("\n[1] 同一 execution_id：3 次 replan 正常，第 4 次阻断");
    const trace = buildFailureTrace(service);
    let blocked = false;
    let blockedMsg = "";
    for (let i = 1; i <= 4; i++) {
        const patch = replanner.generateTaskPatch(trace.parentId, trace.childId);
        check(`第 ${i} 次生成 patch 成功`, !!patch);
        try {
            const plan = replanner.applyTaskPatch(patch!.patchId);
            check(`第 ${i} 次 replan 成功（count=${i}）`, !!plan, JSON.stringify(plan));
        } catch (err) {
            if (err instanceof LoopPreventionError) {
                blocked = true;
                blockedMsg = err.message;
                check(`第 ${i} 次 replan 被阻断（LoopPreventionError）`, i === 4, `i=${i}`);
            } else {
                check(`第 ${i} 次 replan 抛错类型`, false, String(err));
            }
        }
    }
    check("第 4 次确实被阻断", blocked, blockedMsg);
    check("系统计数 = 3（plan 未被创建）", replanner.getReplanCount(trace.parentId) === 3, String(replanner.getReplanCount(trace.parentId)));
    const evalBlocked = guardrail.evaluateGuardrails({ sourceType: "task_patch", sourceId: trace.parentId, executionId: trace.parentId });
    check("guardrail 评估同一 execution → 拒绝", evalBlocked.allowed === false, evalBlocked.reasoning);

    // ─── 2. 不同 execution_id 计数独立 ───
    console.log("\n[2] 不同 execution_id 计数独立");
    const trace2 = buildFailureTrace(service);
    check("新 execution 初始 count=0", replanner.getReplanCount(trace2.parentId) === 0);
    const p2 = replanner.generateTaskPatch(trace2.parentId, trace2.childId);
    const plan2 = replanner.applyTaskPatch(p2!.patchId);
    check("新 execution replan 1 次成功", !!plan2);
    check("exec1 count 仍为 3（不受影响）", replanner.getReplanCount(trace.parentId) === 3, String(replanner.getReplanCount(trace.parentId)));
    check("exec2 count = 1", replanner.getReplanCount(trace2.parentId) === 1, String(replanner.getReplanCount(trace2.parentId)));
    const eval2 = guardrail.evaluateGuardrails({ sourceType: "task_patch", sourceId: trace2.parentId, executionId: trace2.parentId });
    check("exec2（count=1 < 3）允许继续 replan", eval2.allowed === true, eval2.reasoning);

    // ─── 3. 调用方传入 replanCount 被忽略（运行时证明） ───
    console.log("\n[3] 调用方 replanCount 被忽略");
    // exec1 系统计数=3 → 即使调用方声称 replanCount=0 也阻断
    const fake0 = guardrail.evaluateGuardrails({
        sourceType: "task_patch",
        sourceId: trace.parentId,
        executionId: trace.parentId,
        replanCount: 0, // 类型已移除该字段，此处以调用方恶意构造证明运行时忽略
    } as any);
    check("调用方 replanCount=0 仍被阻断（系统计数=3）", fake0.allowed === false, fake0.reasoning);
    // exec2 系统计数=1 → 调用方声称 replanCount=99 仍允许（99 被忽略）
    const fake99 = guardrail.evaluateGuardrails({
        sourceType: "task_patch",
        sourceId: trace2.parentId,
        executionId: trace2.parentId,
        replanCount: 99,
    } as any);
    check("调用方 replanCount=99 被忽略（系统计数=1 < 3）", fake99.allowed === true, fake99.reasoning);

    // ─── 4. 阈值优先级：policy config > 环境变量 > 默认值 3 ───
    console.log("\n[4] 阈值优先级");
    const loopPolicyId = govStore.listPolicies("loop_prevention", "active")[0].policyId;

    // 4a. policy config 存在（seed 默认 3）→ policy 分支生效
    check("policy config 分支：limit=3（seed）", guardrail.getLoopPreventionLimit() === 3, String(guardrail.getLoopPreventionLimit()));

    // 4b. policy config 存在时环境变量被遮蔽（policy > env）
    process.env.CG_MAX_REPLAN_PER_EXECUTION = "1";
    check("policy 存在时 env 被遮蔽（limit 仍为 3）", guardrail.getLoopPreventionLimit() === 3, String(guardrail.getLoopPreventionLimit()));
    const evalShadow = guardrail.evaluateGuardrails({ sourceType: "task_patch", sourceId: trace2.parentId, executionId: trace2.parentId });
    check("env=1 被 policy=3 遮蔽：exec2（count=1）仍允许", evalShadow.allowed === true, evalShadow.reasoning);

    // 4c. policy 无 maxReplanPerExecution 配置 → 环境变量分支生效（env > default）
    const loopPolicy = govStore.getPolicy(loopPolicyId)!;
    govStore.upsertPolicy({ ...loopPolicy, config: {}, updatedAtMs: Date.now() });
    check("policy 无配置 + env=1 → limit=1（env 分支）", guardrail.getLoopPreventionLimit() === 1, String(guardrail.getLoopPreventionLimit()));
    const evalEnv = guardrail.evaluateGuardrails({ sourceType: "task_patch", sourceId: trace2.parentId, executionId: trace2.parentId });
    check("env=1 时 exec2（count=1）被阻断", evalEnv.allowed === false, evalEnv.reasoning);

    // 4d. policy config 重新设置 → 覆盖环境变量（policy > env）
    govStore.upsertPolicy({ ...loopPolicy, config: { maxReplanPerExecution: 5 }, updatedAtMs: Date.now() });
    check("policy=5 覆盖 env=1（limit=5）", guardrail.getLoopPreventionLimit() === 5, String(guardrail.getLoopPreventionLimit()));
    const evalPolicy = guardrail.evaluateGuardrails({ sourceType: "task_patch", sourceId: trace.parentId, executionId: trace.parentId });
    check("policy=5 时 exec1（count=3）恢复允许", evalPolicy.allowed === true, evalPolicy.reasoning);

    delete process.env.CG_MAX_REPLAN_PER_EXECUTION;

    // ─── 清理 ───
    rmSync(dir, { recursive: true, force: true });

    console.log(`\n结果: ${pass} passed, ${fail} failed`);
    if (fail > 0) process.exit(1);
}

main();
