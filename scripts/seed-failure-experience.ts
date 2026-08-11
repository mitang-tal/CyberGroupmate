/**
 * Seed Failure Intelligence 经验库
 *
 * 向 SqliteExperienceStore（默认 workspace/experience.db）写入 3 条 mock 经验：
 * 1. 避免型：governance_v2_init 的 sqlite VALUES 保留字报错（avoid 规则）
 * 2. 偏好型：sqlite_query 参数化查询（prefer 规则）
 * 3. 跨领域：telegram_media_send 废弃接口 sendPhoto（avoid 规则）
 *
 * 幂等：固定 experienceId/patternId，重复运行先删旧数据再插入。
 *
 * 用法：npm run seed:experience [-- <dbPath>]
 * 自验：插入后断言经验库 3 条 active；派发注入 governance_v2_init 命中 1 条。
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { SqliteExperienceStore } from "../src/experience/sqlite-experience-store.js";
import { FailureExtractor } from "../src/experience/failure-extractor.js";
import { ExperienceInjector } from "../src/experience/experience-injector.js";
import { TTLQueryCache } from "../src/experience/query-cache.js";
import type { FailurePattern, ExperienceItem } from "../src/experience/types.js";

const DB_PATH = process.argv[2] || join("workspace", "experience.db");
const TTL_MS = 30 * 24 * 3600_000; // 与 failure-extractor 的 EXPERIENCE_TTL_MS 一致
const now = Date.now();

const PATTERNS: FailurePattern[] = [
    {
        patternId: "seed-pat-gov2-init",
        category: "parameter_invalid",
        triggerContext: "governance_v2_init",
        symptom: "sqlite_syntax_error_near_values",
        rootCause: "sqlite 保留字 VALUES 被用作字段名导致语法错误",
        frequency: 3,
        confidence: 0.9,
        firstObservedAtMs: now - 7 * 24 * 3600_000,
        lastObservedAtMs: now,
        sourceAlertIds: ["seed-alert-gov2-1"],
    },
    {
        patternId: "seed-pat-sqlite-query",
        category: "parameter_invalid",
        triggerContext: "sqlite_query",
        symptom: "sqlite_syntax_error_reserved_word",
        rootCause: "直接拼接保留字字段名触发语法错误",
        frequency: 2,
        confidence: 0.85,
        firstObservedAtMs: now - 3 * 24 * 3600_000,
        lastObservedAtMs: now,
        sourceAlertIds: ["seed-alert-sqlite-1"],
    },
    {
        patternId: "seed-pat-telegram-media",
        category: "tool_capability_mismatch",
        triggerContext: "telegram_media_send",
        symptom: "unknown_method_send_photo",
        rootCause: "agent 选择了已废弃的 sendPhoto 接口",
        frequency: 3,
        confidence: 0.9,
        firstObservedAtMs: now - 5 * 24 * 3600_000,
        lastObservedAtMs: now,
        sourceAlertIds: ["seed-alert-tg-1"],
    },
];

const EXPERIENCES: ExperienceItem[] = [
    {
        experienceId: "seed-exp-gov2-init",
        patternId: "seed-pat-gov2-init",
        type: "failure_prevention",
        context: { tool: "governance_v2_init", capability: "sqlite_query" },
        rule: {
            avoid: "sql 不要用 values 作字段名",
            constraints: { reason: "sqlite 保留字 VALUES" },
        },
        confidence: 0.9,
        frequency: 3,
        status: "active",
        expiresAtMs: now + TTL_MS,
        createdAtMs: now,
        updatedAtMs: now,
        originAgentId: "seed",
        federationStatus: "candidate",
    },
    {
        experienceId: "seed-exp-sqlite-query",
        patternId: "seed-pat-sqlite-query",
        type: "failure_prevention",
        context: { tool: "sqlite_query" },
        rule: {
            prefer: "用参数化查询避开保留字",
            constraints: { reason: "参数化查询规避保留字/注入" },
        },
        confidence: 0.85,
        frequency: 2,
        status: "active",
        expiresAtMs: now + TTL_MS,
        createdAtMs: now,
        updatedAtMs: now,
        originAgentId: "seed",
        federationStatus: "candidate",
    },
    {
        experienceId: "seed-exp-telegram-media",
        patternId: "seed-pat-telegram-media",
        type: "failure_prevention",
        context: { tool: "telegram_media_send", capability: "media_send" },
        rule: {
            avoid: "用 sendMedia 替代废弃的 sendPhoto",
            constraints: { reason: "sendPhoto 已废弃" },
        },
        confidence: 0.9,
        frequency: 3,
        status: "active",
        expiresAtMs: now + TTL_MS,
        createdAtMs: now,
        updatedAtMs: now,
        originAgentId: "seed",
        federationStatus: "candidate",
    },
];

const SEED_IDS = [
    ...PATTERNS.map((p) => p.patternId),
    ...EXPERIENCES.map((e) => e.experienceId),
];

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

async function main(): Promise<void> {
    mkdirSync(dirname(DB_PATH), { recursive: true });

    // 幂等：固定 id 先删后插（store 接口无 delete，这里直接走底层连接清理旧种子数据）
    const raw = new Database(DB_PATH);
    try {
        const placeholders = SEED_IDS.map(() => "?").join(",");
        raw.prepare(`DELETE FROM experience_items WHERE experience_id IN (${placeholders})`).run(...SEED_IDS);
        raw.prepare(`DELETE FROM failure_patterns WHERE pattern_id IN (${placeholders})`).run(...SEED_IDS);
    } finally {
        raw.close();
    }

    const store = new SqliteExperienceStore(DB_PATH);
    for (const p of PATTERNS) store.insertPattern(p);
    for (const e of EXPERIENCES) store.insertExperience(e);

    // 自验 1：经验库 3 条 active
    const all = store.queryExperiences({ status: "active" });
    check("经验库现有 3 条 active 经验", all.length === 3, String(all.length));

    // 自验 2：派发注入 governance_v2_init 命中 1 条（走真实 injector 链路）
    const injector = new ExperienceInjector(new FailureExtractor(store, new TTLQueryCache()));
    const dispatch = injector.getConstraintsForDispatch({ taskType: "governance_v2_init" });
    check("派发注入 governance_v2_init 命中经验 1 条", dispatch.experiences.length === 1,
        `命中 ${dispatch.experiences.length} 条: ${dispatch.experiences.map((e) => e.experienceId).join(",")}`);
    check("命中 avoid 规则为 values 保留字经验", dispatch.constraints.avoid.includes("sql 不要用 values 作字段名"),
        JSON.stringify(dispatch.constraints.avoid));

    // 自验 3：跨领域经验按 tool 可查（telegram_media_send）
    const tg = store.queryExperiences({ tool: "telegram_media_send", minConfidence: 0.6, status: "active" });
    check("telegram_media_send 命中跨领域经验 1 条", tg.length === 1 && tg[0].rule.avoid === "用 sendMedia 替代废弃的 sendPhoto",
        `${tg.length} 条: ${tg.map((e) => e.experienceId).join(",")}`);

    console.log(`\n已写入 ${DB_PATH}（3 条 pattern + 3 条 experience）`);
    console.log(`刷新 Dashboard「失败智能」tab 应显示 3 条经验。`);
    console.log(`结果: ${pass} passed, ${fail} failed`);
    if (fail > 0) process.exit(1);
}

await main();
