/**
 * Audit Fix Phase 3.1 — Meta Decision Lifecycle 独立验收脚本
 *
 * 验证内容：
 * 1. 完整状态流：proposed → approved → executing → executed → verified（redispatch 真实派发）
 * 2. 链路成立：decision_id → execution_id → ExecutionRecord(parentId=decision_id) → verificationResult
 * 3. verification 真实回读 ExecutionRecord（非标志位），verified 决策的 executionStatus=success
 * 4. 真实失败路径：redispatch 无可用 agent → decision failed + ExecutionRecord failure（不伪造成功）
 * 5. 无真实执行器的类型（switch_policy 等）→ 真实失败（NoExecutor），不伪造成功
 * 6. store 层非法 transition 被拒（proposed → executed 直接跳转）且记录 transitionError
 * 7. executed 无 execution_id 被拒（store 层强制绑定）
 * 8. 已终态决策重复执行被拒（verified → approved 非法）
 * 9. verifyDecision 对 executed 决策真实回读验证（executed → verified）
 */
import crypto from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteDecisionStore } from "../src/meta-decision/sqlite-decision-store.js";
import { MetaDecisionEngine } from "../src/meta-decision/meta-decision-engine.js";
import { IllegalDecisionTransitionError } from "../src/meta-decision/state-machine.js";
import { MetaDecision } from "../src/meta-decision/types.js";
import { SqliteExecutionRecordStore } from "../src/execution/sqlite-execution-record-store.js";
import { SqliteAlertStore } from "../src/execution/sqlite-alert-store.js";
import { SqliteHealingStore } from "../src/execution/sqlite-healing-store.js";
import { ExecutionRecordService } from "../src/execution/execution-record-service.js";
import { CapabilityRegistry } from "../src/capability-registry/capability-registry.js";
import { CapabilityDispatcher } from "../src/capability-registry/capability-dispatcher.js";

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

function makeDecision(decisionType: MetaDecision["decisionType"], target: string): MetaDecision {
    return {
        decisionId: crypto.randomUUID(),
        triggerEvent: { eventType: "alert_raised", sourceId: "verify-script", detail: "test" },
        decisionType,
        targetComponent: target,
        actionParams: {},
        confidenceScore: 0.8,
        reasoningText: "test decision",
        status: "proposed",
        createdAtMs: Date.now(),
    };
}

function main() {
    const dir = mkdtempSync(join(tmpdir(), "cg-phase31-verify-"));
    const decisionPath = join(dir, "meta-decisions.db");
    const execPath = join(dir, "exec.db");
    const alertPath = join(dir, "alert.db");
    const healingPath = join(dir, "healing.db");

    const decisionStore = new SqliteDecisionStore(decisionPath);
    const execStore = new SqliteExecutionRecordStore(execPath);
    const alertStore = new SqliteAlertStore(alertPath);
    const healingStore = new SqliteHealingStore(healingPath);
    const service = new ExecutionRecordService(execStore, alertStore, healingStore);

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

    // ─── 1. 完整状态流（redispatch 真实派发） ───
    console.log("\n[1] 完整状态流 proposed → verified（redispatch 真实派发）");
    let verifiedDecisionId = "";
    {
        const decision = makeDecision("redispatch", "media_send");
        decisionStore.insert(decision);

        const outcome = engine.executeDecision(decision.decisionId);
        check("执行成功（ok=true）", outcome.ok === true, JSON.stringify(outcome));
        check("终态 status=verified", outcome.status === "verified", outcome.status);
        check("绑定 execution_id", !!outcome.executionId, outcome.executionId);

        const stored = decisionStore.getById(decision.decisionId)!;
        check("持久化 executionId", stored.executionId === outcome.executionId, stored.executionId);
        check("持久化 executionResult（真实 detail）", (stored.executionResult ?? "").includes("redispatch target:"), stored.executionResult);
        check("executionResult 包含真实目标 agent", (stored.executionResult ?? "").includes(trusted.name), stored.executionResult);

        // 链路：decision → execution record → verification
        const record = execStore.getById(outcome.executionId!);
        check("ExecutionRecord 存在", !!record);
        check("ExecutionRecord.status=success", record?.status === "success", record?.status);
        check("ExecutionRecord.parentId=decision_id（链路绑定）", record?.parentId === decision.decisionId, record?.parentId);

        const vr = stored.verificationResult;
        check("verificationResult 已产出", !!vr);
        check("verificationResult.verified=true", vr?.verified === true, JSON.stringify(vr));
        check("verificationResult.executionStatus=success（真实回读）", vr?.executionStatus === "success", vr?.executionStatus);
        check("verificationResult.executionId 一致", vr?.executionId === outcome.executionId, vr?.executionId);

        verifiedDecisionId = decision.decisionId;
    }

    // ─── 2. 真实失败：无 trusted agent 可派发 → 不伪造成功 ───
    console.log("\n[2] 无 trusted agent 可派发 → 真实失败");
    {
        // 构造 untrusted-only 环境（同时验证 Phase 3.2 信任过滤 + 3.1 redispatch 真实失败）
        const reg2 = new CapabilityRegistry();
        reg2.register({
            name: "Untrusted Only",
            capabilities: [
                { name: "media_send", category: "media", tags: ["send", "media"], description: "媒体发送" },
            ],
        });
        const disp2 = new CapabilityDispatcher(reg2);
        disp2.setReputationProvider(() => ({ trustScore: 0.1, trustState: "untrusted", reliability: 0.2 }));
        const engine2 = new MetaDecisionEngine(decisionStore, {
            capabilityRegistry: reg2,
            capabilityDispatcher: disp2,
            executionRecordService: service,
        });

        const decision = makeDecision("redispatch", "media_send");
        decisionStore.insert(decision);

        const outcome = engine2.executeDecision(decision.decisionId);
        check("ok=false", outcome.ok === false, JSON.stringify(outcome));
        check("status=failed", outcome.status === "failed", outcome.status);
        check("绑定 execution_id", !!outcome.executionId, outcome.executionId);

        const record = execStore.getById(outcome.executionId!);
        check("ExecutionRecord.status=failure（真实结果）", record?.status === "failure", record?.status);
        check("ExecutionRecord 错误分类 NoSuitableAgent", record?.error?.type === "NoSuitableAgent", record?.error?.type);

        const stored = decisionStore.getById(decision.decisionId)!;
        check("executionResult 为真实失败 detail", (stored.executionResult ?? "").includes("no trusted online agent matched"), stored.executionResult);
    }

    // ─── 3. 无真实执行器类型 → 真实失败（禁止假成功） ───
    console.log("\n[3] switch_policy 无真实执行器 → 真实失败");
    {
        const decision = makeDecision("switch_policy", "media_send");
        decisionStore.insert(decision);

        const outcome = engine.executeDecision(decision.decisionId);
        check("ok=false（不伪造成功）", outcome.ok === false, JSON.stringify(outcome));
        check("status=failed", outcome.status === "failed", outcome.status);
        const record = execStore.getById(outcome.executionId!);
        check("ExecutionRecord 错误分类 NoExecutor", record?.error?.type === "NoExecutor", record?.error?.type);
        check("executionResult 说明无真实执行器", (decisionStore.getById(decision.decisionId)!.executionResult ?? "").includes("no real executor"), decisionStore.getById(decision.decisionId)!.executionResult);
    }

    // ─── 4. store 层非法 transition 被拒 + 记录 ───
    console.log("\n[4] 非法 transition（proposed → executed）被拒");
    {
        const decision = makeDecision("redispatch", "media_send");
        decisionStore.insert(decision);

        let threw = false;
        let errMsg = "";
        try {
            decisionStore.updateStatus(decision.decisionId, "executed"); // 直接跳转，跳过 approved/executing，且无 execution_id
        } catch (err) {
            threw = true;
            errMsg = err instanceof Error ? err.message : String(err);
        }
        check("抛出 IllegalDecisionTransitionError", threw && errMsg.includes("illegal decision transition"), errMsg);
        const stored = decisionStore.getById(decision.decisionId)!;
        check("状态未被改变（仍 proposed）", stored.status === "proposed", stored.status);
        check("非法尝试已记录 transitionError", !!stored.transitionError, stored.transitionError);
    }

    // ─── 5. executed 无 execution_id 被拒 ───
    console.log("\n[5] executed 无 execution_id 被拒");
    {
        const decision = makeDecision("redispatch", "media_send");
        decisionStore.insert(decision);
        decisionStore.updateStatus(decision.decisionId, "approved");
        decisionStore.updateStatus(decision.decisionId, "executing");

        let threw = false;
        let errMsg = "";
        try {
            decisionStore.updateStatus(decision.decisionId, "executed"); // 合法跳转但缺少 execution_id
        } catch (err) {
            threw = true;
            errMsg = err instanceof Error ? err.message : String(err);
        }
        check("抛出 executed requires execution_id", threw && errMsg.includes("executed requires execution_id"), errMsg);
        const stored = decisionStore.getById(decision.decisionId)!;
        check("状态仍 executing", stored.status === "executing", stored.status);
    }

    // ─── 6. 终态决策重复执行被拒（engine 层） ───
    console.log("\n[6] verified 决策重复执行被拒");
    {
        let threw = false;
        let isIllegal = false;
        try {
            engine.executeDecision(verifiedDecisionId);
        } catch (err) {
            threw = true;
            isIllegal = err instanceof IllegalDecisionTransitionError;
        }
        check("重复执行抛 IllegalDecisionTransitionError", threw && isIllegal);
        check("拒绝重复执行同样被拒", (() => {
            try {
                engine.rejectDecision(verifiedDecisionId);
                return false;
            } catch {
                return true;
            }
        })());
    }

    // ─── 7. verifyDecision 对 executed 决策真实回读验证 ───
    console.log("\n[7] verifyDecision：executed → verified（真实回读）");
    {
        // 构造一个真实成功的 ExecutionRecord
        const execId = service.start({ source: "system", method: "meta.redispatch", taskId: "media_send" });
        service.markRunning(execId);
        service.complete(execId, "success", { durationMs: 5 });

        const decision = makeDecision("redispatch", "media_send");
        decisionStore.insert(decision);
        decisionStore.updateStatus(decision.decisionId, "approved");
        decisionStore.updateStatus(decision.decisionId, "executing");
        decisionStore.updateStatus(decision.decisionId, "executed", {
            executedAtMs: Date.now(),
            executionId: execId,
            executionResult: JSON.stringify({ outcome: "success", detail: "redispatch target: Trusted Agent", executionId: execId }),
        });

        const vr = engine.verifyDecision(decision.decisionId);
        check("verifyDecision 返回 verified=true", vr.verified === true, JSON.stringify(vr));
        check("executionStatus 从 store 回读 =success", vr.executionStatus === "success", vr.executionStatus);
        const stored = decisionStore.getById(decision.decisionId)!;
        check("决策状态 → verified", stored.status === "verified", stored.status);
        check("verificationResult 持久化", stored.verificationResult?.verified === true, JSON.stringify(stored.verificationResult));

        // verified 是终态：再次验证被拒
        let threw = false;
        try {
            engine.verifyDecision(decision.decisionId);
        } catch {
            threw = true;
        }
        check("verified 终态再次验证被拒", threw);
    }

    // ─── 清理 ───
    rmSync(dir, { recursive: true, force: true });

    console.log(`\n结果: ${pass} passed, ${fail} failed`);
    if (fail > 0) process.exit(1);
}

main();
