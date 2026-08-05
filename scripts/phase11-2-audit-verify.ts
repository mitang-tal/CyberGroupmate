/**
 * Audit Fix Phase 1.1 + Phase 2 — 独立运行时验收脚本
 *
 * 验证内容：
 * 1. Kill Switch 重启恢复（持久化状态 → 内存状态一致）
 * 2. policy_denied 分类（GuardrailDenied → status=policy_denied + failureCategory=policy_denied）
 * 3. policy_denied 不进入失败经验库（真实失败才进入）
 * 4. 连续失败自动生成 CONTINUOUS_FAILURE Alert（Phase 2.1 闭环）
 * 5. applyRetry 无真实 executor 时不伪造成功（Phase 2.2）
 * 6. applyMetaDiagnosis 标记 diagnosisSource=heuristic（Phase 2.3）
 */
import { SqliteGovernanceStore } from "../src/governance/sqlite-governance-store.js";
import { GlobalGuardrailEvaluator } from "../src/governance/global-guardrail-evaluator.js";
import { SqliteExecutionRecordStore } from "../src/execution/sqlite-execution-record-store.js";
import { SqliteAlertStore } from "../src/execution/sqlite-alert-store.js";
import { ExecutionRecordService } from "../src/execution/execution-record-service.js";
import { ExecutionAnomalyDetector } from "../src/execution/execution-anomaly-detector.js";
import { HealingPolicyEngine } from "../src/execution/healing-policy-engine.js";
import { SqliteHealingStore } from "../src/execution/sqlite-healing-store.js";
import { SqliteExperienceStore } from "../src/experience/sqlite-experience-store.js";
import { FailureExtractor } from "../src/experience/failure-extractor.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

async function main() {
    const dir = mkdtempSync(join(tmpdir(), "cg-audit-verify-"));
    const govPath = join(dir, "governance.db");
    const execPath = join(dir, "exec.db");
    const alertPath = join(dir, "alert.db");
    const healingPath = join(dir, "healing.db");
    const expPath = join(dir, "experience.db");

    // ─── 1. Kill Switch 重启恢复 ───
    console.log("\n[1] Kill Switch 重启恢复");
    let govStore: SqliteGovernanceStore;
    {
        govStore = new SqliteGovernanceStore(govPath);
        const g1 = new GlobalGuardrailEvaluator(govStore);
        g1.toggleKillSwitch(true);
        check("toggle 后 isKillSwitchActive()=true", g1.isKillSwitchActive() === true);

        // 模拟重启：新 evaluator 实例（内存 flag 重置为 false），读取持久化
        const g2 = new GlobalGuardrailEvaluator(govStore);
        check("重启后 isKillSwitchActive()=true（持久化恢复）", g2.isKillSwitchActive() === true);
        const evalResult = g2.evaluateGuardrails({ sourceType: "host_call", sourceId: "x" });
        check("重启后 evaluateGuardrails 仍阻断", evalResult.allowed === false);

        // 解除
        g2.toggleKillSwitch(false);
        const g3 = new GlobalGuardrailEvaluator(govStore);
        check("解除并重启后 isKillSwitchActive()=false", g3.isKillSwitchActive() === false);
    }

    // ─── 2. policy_denied 分类 ───
    console.log("\n[2] policy_denied 分类");
    let execStore: SqliteExecutionRecordStore;
    let alertStore: SqliteAlertStore;
    let healingStore: SqliteHealingStore;
    let service: ExecutionRecordService;
    let experienceStore: SqliteExperienceStore;
    let failureExtractor: FailureExtractor;
    {
        execStore = new SqliteExecutionRecordStore(execPath);
        alertStore = new SqliteAlertStore(alertPath);
        healingStore = new SqliteHealingStore(healingPath);
        experienceStore = new SqliteExperienceStore(expPath);
        failureExtractor = new FailureExtractor(experienceStore);
        service = new ExecutionRecordService(execStore, alertStore, healingStore);
        service.setFailureExtractor(failureExtractor);
        const detector = new ExecutionAnomalyDetector(execStore, service);
        service.setAnomalyDetector(detector);

        // GuardrailDenied 拦截（pending → policy_denied）
        const id = service.start({ source: "host_call", method: "telegram_send" });
        service.complete(id, "policy_denied", { error: { type: "GuardrailDenied", message: "Kill switch active" } });
        const rec = execStore.getById(id)!;
        check("status=policy_denied", rec.status === "policy_denied", rec.status);
        check("failureCategory=policy_denied", rec.failureCategory === "policy_denied", rec.failureCategory);
        check("error.type=GuardrailDenied", rec.error?.type === "GuardrailDenied");

        // sandbox 执行中检测到 policy violation（running → policy_denied）
        const sid = service.start({ source: "agent", method: "agent.turn" });
        service.markRunning(sid);
        service.complete(sid, "policy_denied", { error: { type: "PolicyViolation", message: "not permitted from sandbox" } });
        const srec = execStore.getById(sid)!;
        check("running→policy_denied 合法转换", srec.status === "policy_denied", srec.status);
        check("sandbox 违规 failureCategory=policy_denied", srec.failureCategory === "policy_denied", srec.failureCategory);
        check("无 stuck execution", service.getActive().length === 0);

        const patternsAfterDenied = experienceStore.queryPatterns();
        check("policy_denied 不产生失败 pattern", patternsAfterDenied.length === 0, `patterns=${patternsAfterDenied.length}`);

        // 真实失败 → 进入经验库 + 分类
        const fid = service.start({ source: "host_call", method: "db_query" });
        service.markRunning(fid);
        service.complete(fid, "failure", { error: { type: "DbError", message: "connection refused" } });
        const frec = execStore.getById(fid)!;
        check("真实失败 failureCategory=execution_error", frec.failureCategory === "execution_error", frec.failureCategory);
        const patternsAfterReal = experienceStore.queryPatterns();
        check("真实失败产生 pattern", patternsAfterReal.length >= 1, `patterns=${patternsAfterReal.length}`);
    }

    // ─── 3. 连续失败自动 Alert（Phase 2.1） ───
    console.log("\n[3] 连续失败自动 Alert");
    {
        const method = "telegram_media_send";
        const before = alertStore.query({ status: "active" }).length;
        for (let i = 0; i < 3; i++) {
            const id = service.start({ source: "host_call", method });
            service.markRunning(id);
            service.complete(id, "failure", { error: { type: "ApiError", message: "media upload failed" } });
        }
        const alerts = alertStore.query({ status: "active" });
        const continuous = alerts.filter((a) => a.ruleType === "CONTINUOUS_FAILURE" && a.sourceComponent === method);
        check("CONTINUOUS_FAILURE Alert 自动生成", continuous.length >= 1, `alerts=${alerts.length} (before=${before})`);
    }

    // ─── 4. applyRetry 不伪造成功（Phase 2.2） ───
    console.log("\n[4] applyRetry 不伪造成功");
    {
        const method = "unknown_method";
        for (let i = 0; i < 5; i++) {
            const id = service.start({ source: "host_call", method });
            service.markRunning(id);
            service.complete(id, "failure", { error: { type: "UnsupportedMethod", message: "method not found" } });
        }
        const alerts = alertStore.query({ status: "active" });
        const cluster = alerts.find((a) => a.ruleType === "ERROR_CLUSTER" && a.sourceComponent === "UnsupportedMethod");
        check("ERROR_CLUSTER Alert 自动生成", !!cluster);

        const action = service.triggerSelfHealing(cluster!.alertId);
        check("triggerSelfHealing 生成 action", !!action);
        // 无 executor → 不假成功
        const ok = await service.getHealingAction(action!.actionId) && (await applyRetryViaEngine(service, action!));
        check("无 executor 时 retry 返回 false", ok === false);
        const updated = healingStore.getById(action!.actionId);
        check("action 状态=failed（不伪造 succeeded）", updated?.status === "failed", updated?.status);
        check("失败原因说明真实原因", (updated?.error ?? "").includes("no real retry executor"), updated?.error);

        // 注入真实 executor → succeeded
        const healEngine = new HealingPolicyEngine(healingStore, service);
        healEngine.setRetryExecutor(async () => ({ status: "success", durationMs: 12 }));
        const action2 = service.triggerSelfHealing(cluster!.alertId);
        const ok2 = await healEngine.applyRetry(cluster!.executionId!, action2!);
        check("注入 executor 后 retry 成功", ok2 === true);
        const updated2 = healingStore.getById(action2!.actionId);
        check("action 状态=succeeded", updated2?.status === "succeeded", updated2?.status);
    }

    // ─── 5. Meta Diagnosis 标记 heuristic（Phase 2.3） ───
    console.log("\n[5] Meta Diagnosis diagnosisSource");
    {
        const alerts = alertStore.query({ status: "active" });
        const target = alerts.find((a) => a.ruleType === "ERROR_CLUSTER");
        check("存在 ERROR_CLUSTER alert", !!target);
        const diag = await service.diagnoseExecution(target!.alertId);
        const actionRec = target && service.queryHealingActions({ alertId: target.alertId })[0];
        const details = actionRec?.actionDetails as any;
        check("diagnosisSource=heuristic", details?.diagnosis?.diagnosisSource === "heuristic", JSON.stringify(details?.diagnosis?.diagnosisSource));
        check("diagnosis 有 rootCause", !!details?.diagnosis?.rootCause);
    }

    // ─── 清理 ───
    rmSync(dir, { recursive: true, force: true });

    console.log(`\n结果: ${pass} passed, ${fail} failed`);
    if (fail > 0) process.exit(1);
}

// 通过 service 内的 healing engine 执行 applyRetry（无 executor 注入路径）
async function applyRetryViaEngine(service: ExecutionRecordService, action: any): Promise<boolean> {
    const engine = (service as any).healingEngine as HealingPolicyEngine | undefined;
    if (!engine) return false;
    return engine.applyRetry(action.executionId, action);
}

main().catch((err) => {
    console.error("验证脚本异常:", err);
    process.exit(1);
});
