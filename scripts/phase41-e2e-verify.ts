/**
 * Phase 4.1 — 治理收敛端到端验收脚本
 *
 * 验证链路：
 * 1. Gov2 为唯一 kill-switch 事实源，setKillSwitch(true) 广播到 Guardrail + Governor
 * 2. 广播后：checkSubmitPermission 拒绝（Governor）、evaluateGuardrails 拒绝（Guardrail）
 * 3. audit_log 落库（kill_switch / update / rollback 各类 entry）
 * 4. rate limit / quarantineCategories 热同步（syncToComponents）
 * 5. rollback 生效且同步回下游（Governor 限流恢复）
 *
 * 运行：pnpm tsx scripts/phase41-e2e-verify.ts
 * 退出码：0=全绿；1=存在失败
 */
import crypto from "node:crypto";
import { EcosystemGovernance } from "../src/governance-v2/ecosystem-governance.js";
import { GovernanceV2Store, GovernanceV2State } from "../src/governance-v2/governance-v2-store.js";
import { GovernanceAuditLog, GovernancePolicyValues } from "../src/governance-v2/types.js";
import { EcosystemGovernor } from "../src/ecosystem/ecosystem-governor.js";
import { GlobalGuardrailEvaluator } from "../src/governance/global-guardrail-evaluator.js";
import { GovernanceStore } from "../src/governance/governance-store.js";
import { GovernancePolicy, GuardrailViolation, GuardrailRuleType, PolicyStatus } from "../src/governance/types.js";

// ─────────────────────────────────────────────────────────────
// 内存版 GovernanceV2Store（替代 better-sqlite3，本机二进制不匹配）
// ─────────────────────────────────────────────────────────────
class MemGov2Store implements GovernanceV2Store {
    state?: GovernanceV2State;
    audit: GovernanceAuditLog[] = [];

    loadState(): GovernanceV2State | undefined {
        return this.state ? { ...this.state, values: { ...this.state.values } } : undefined;
    }
    saveState(version: string, values: GovernancePolicyValues): void {
        this.state = { version, values: { ...values }, updatedAtMs: Date.now() };
    }
    insertAudit(log: GovernanceAuditLog): void {
        this.audit.push(log);
    }
    listAudit(limit = 100): GovernanceAuditLog[] {
        return [...this.audit].reverse().slice(0, limit);
    }
}

// ─────────────────────────────────────────────────────────────
// 内存版 GovernanceStore（Guardrail 用，seed 默认策略）
// ─────────────────────────────────────────────────────────────
class MemGovernanceStore implements GovernanceStore {
    policies: GovernancePolicy[] = [];
    violations: GuardrailViolation[] = [];

    constructor() {
        const now = Date.now();
        this.policies = [
            { policyId: crypto.randomUUID(), name: "Kill Switch", ruleType: "kill_switch", config: { isKillSwitchActive: false }, status: "active", createdAtMs: now, updatedAtMs: now },
            { policyId: crypto.randomUUID(), name: "Loop Prevention", ruleType: "loop_prevention", config: { maxReplanPerExecution: 3 }, status: "active", createdAtMs: now, updatedAtMs: now },
            { policyId: crypto.randomUUID(), name: "Rate Limit", ruleType: "rate_limit", config: { cooldownPeriodSec: 60 }, status: "active", createdAtMs: now, updatedAtMs: now },
        ];
    }

    listPolicies(ruleType?: GuardrailRuleType, status?: PolicyStatus): GovernancePolicy[] {
        return this.policies.filter((p) =>
            (!ruleType || p.ruleType === ruleType) &&
            (!status || p.status === status));
    }
    getPolicy(policyId: string): GovernancePolicy | undefined {
        return this.policies.find((p) => p.policyId === policyId);
    }
    upsertPolicy(policy: GovernancePolicy): void {
        const idx = this.policies.findIndex((p) => p.policyId === policy.policyId);
        if (idx >= 0) this.policies[idx] = { ...policy };
        else this.policies.push({ ...policy });
    }
    updatePolicyStatus(policyId: string, status: PolicyStatus): void {
        const p = this.policies.find((x) => x.policyId === policyId);
        if (p) { p.status = status; p.updatedAtMs = Date.now(); }
    }
    insertViolation(violation: GuardrailViolation): void {
        this.violations.push(violation);
    }
    queryViolations(options: {
        ruleType?: GuardrailRuleType;
        sourceType?: any;
        actionTaken?: any;
        limit?: number;
        offset?: number;
    }): GuardrailViolation[] {
        let rows = this.violations.filter((v) =>
            (!options.ruleType || v.ruleType === options.ruleType) &&
            (!options.sourceType || v.sourceType === options.sourceType) &&
            (!options.actionTaken || v.actionTaken === options.actionTaken));
        rows = [...rows].sort((a, b) => b.createdAtMs - a.createdAtMs);
        const offset = options.offset ?? 0;
        const limit = options.limit ?? rows.length;
        return rows.slice(offset, offset + limit);
    }
    countViolationsSince(windowMs: number, ruleType?: GuardrailRuleType): number {
        const cutoff = Date.now() - windowMs;
        return this.violations.filter((v) =>
            v.createdAtMs > cutoff && (!ruleType || v.ruleType === ruleType)).length;
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

function main() {
    // ── 装配（与 main.ts 一致的 DI 关系） ──
    const gov2Store = new MemGov2Store();
    const governanceStore = new MemGovernanceStore();
    const governance = new EcosystemGovernance(gov2Store);
    const governor = new EcosystemGovernor(governance);
    const guardrail = new GlobalGuardrailEvaluator(governanceStore);
    governance.attachTargets({
        governor,
        guardrail: { setKillSwitch: (active) => guardrail.toggleKillSwitch(active) },
    });

    console.log("[1] 初始状态：kill-switch 全链路关闭");
    {
        check("Gov2 current.killSwitch=false", governance.getCurrent().values.killSwitch === false);
        check("Governor.isKillSwitchActive=false", governor.isKillSwitchActive() === false);
        check("Guardrail.isKillSwitchActive=false", guardrail.isKillSwitchActive() === false);
        check("Governor rate limit 从 Gov2 同步=10", governor.getRateLimit() === 10, governor.getRateLimit());
        check("Governor quarantine 从 Gov2 同步", JSON.stringify(governor.getQuarantineCategories()) === JSON.stringify(["resource_exhausted", "logic_deadlock"]), governor.getQuarantineCategories());
        const sub = governor.checkSubmitPermission("agent-1");
        check("kill-off 时 checkSubmitPermission 允许", sub.allowed === true, sub);
    }

    console.log("[2] Gov2.setKillSwitch(true) → 广播 Guardrail + Governor");
    let killSnapshotVersion = "";
    {
        const snap = governance.setKillSwitch(true, "verify", "test-kill");
        killSnapshotVersion = snap.version;
        check("产生新版本快照", snap.version !== "1.0.0", snap.version);
        check("Gov2 current.killSwitch=true", governance.getCurrent().values.killSwitch === true);
        check("Governor 被广播 active=true", governor.isKillSwitchActive() === true);
        check("Guardrail 被广播 active=true", guardrail.isKillSwitchActive() === true);

        const sub = governor.checkSubmitPermission("agent-1");
        check("checkSubmitPermission 被 kill-switch 拒绝", sub.allowed === false && (sub.reason ?? "").includes("kill switch"), sub);

        const ev = guardrail.evaluateGuardrails({ sourceType: "dispatch", sourceId: "e2e-verify" });
        check("evaluateGuardrails 拒绝（violation=blocked）", ev.allowed === false && ev.violatedPolicies.length > 0, ev);
    }

    console.log("[3] audit_log 落库（kill_switch entry）");
    {
        const audit = gov2Store.listAudit();
        const ks = audit.find((a) => a.action === "kill_switch");
        check("audit 含 kill_switch entry", !!ks, audit.map((a) => a.action));
        check("audit 来源/原因正确", ks?.origin === "verify" && ks?.reason === "test-kill", ks);
    }

    console.log("[4] 热同步：update rate limit / quarantine → Governor 实时生效");
    {
        governance.update(
            { governorRateLimit: 99, quarantineCategories: ["resource_exhausted", "disk_full"] },
            "verify",
            "bump rate limit + quarantine",
        );
        check("Governor rate limit 热更新=99", governor.getRateLimit() === 99, governor.getRateLimit());
        check("Governor quarantine 热更新", JSON.stringify(governor.getQuarantineCategories()) === JSON.stringify(["resource_exhausted", "disk_full"]), governor.getQuarantineCategories());
    }

    console.log("[5] kill-switch 关闭：全链路恢复");
    {
        governance.setKillSwitch(false, "verify", "test-kill-off");
        check("Gov2 current.killSwitch=false", governance.getCurrent().values.killSwitch === false);
        check("Governor 恢复 false", governor.isKillSwitchActive() === false);
        check("Guardrail 恢复 false", guardrail.isKillSwitchActive() === false);
        const sub = governor.checkSubmitPermission("agent-1");
        check("checkSubmitPermission 恢复允许", sub.allowed === true, sub);
        const ev = guardrail.evaluateGuardrails({ sourceType: "dispatch", sourceId: "e2e-verify" });
        check("evaluateGuardrails 恢复允许", ev.allowed === true, ev);
    }

    console.log("[6] rollback：版本回退 + 下游同步 + audit entry");
    {
        const snap = governance.rollback("1.0.0", "verify", "revert to baseline");
        check("rollback 产生新快照", !!snap, snap?.version);
        const cur = governance.getCurrent();
        check("回退后 governorRateLimit=10", cur.values.governorRateLimit === 10, cur.values.governorRateLimit);
        check("回退后 killSwitch=false", cur.values.killSwitch === false, cur.values.killSwitch);
        check("回退后 quarantine 恢复默认", JSON.stringify(cur.values.quarantineCategories) === JSON.stringify(["resource_exhausted", "logic_deadlock"]), cur.values.quarantineCategories);
        check("Governor 限流随回退同步=10", governor.getRateLimit() === 10, governor.getRateLimit());
        const audit = gov2Store.listAudit();
        check("audit 含 rollback entry", audit.some((a) => a.action === "rollback"), audit.map((a) => a.action));
    }

    console.log("[7] 持久化闭环：store 状态 = 当前策略");
    {
        const st = gov2Store.loadState();
        check("store 已持久化当前版本", !!st && st.version === governance.getCurrent().version, st?.version);
        check("store 已持久化 values（含 killSwitch）", !!st && st.values.killSwitch === false && st.values.governorRateLimit === 10, st?.values);
    }

    console.log(`\n结果: ${pass} passed, ${fail} failed`);
    if (fail > 0) process.exit(1);
}

main();