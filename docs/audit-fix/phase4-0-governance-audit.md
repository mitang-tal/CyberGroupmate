# Phase 4.0 — Governance Consolidation Plan（只读审计）

> 阶段：Audit Fix Phase 4.0（只读架构审计）
> 性质：本阶段未修改任何生产代码 / schema / UI / 测试。以下全部为方案设计，供 Phase 4.1 实施参考。
> 事实依据：对 `src/governance/*`、`src/ecosystem/*`、`src/governance-v2/*`、`src/main.ts`、`src/dashboard/api-routes.ts` 的逐行代码核查（2026-08-01）。

---

## 0. 结论摘要

三个治理中心中：

- **GlobalGuardrailEvaluator**：完整闭环（持久化 + 真实施），是唯一有真实运行时权力的治理组件。
- **EcosystemGovernor**：半实施。只有 `canPromote` 被生产链路（FederationStore.promote）调用；rate limit / quarantine / kill switch 全部只有 Dashboard API 能触达，无生产调用方。
- **EcosystemGovernance（GovernanceV2）**：零实施。纯内存版本容器，`syncToComponents()` 从未被调用，5 个策略字段全部是「写入但无人读取」的死配置。

三个中心的真实重叠点只有两个：**Kill Switch**（Guardrail 与 Governor 各持一个互不相干的开关）和 **Rate Limit**（两套语义不同的实现）。其余问题不是"重复管理"，而是"存储与实施脱节"。

**合并难度评估：胶水级 + 一处状态归一，不是重构级。** 逻辑本身无需重写，工作量集中在：① 唯一 Kill Switch；② 把 GovernanceV2 配置真正接线到下游组件；③ 持久化补位。

---

## 1. 三个中心现状对照表

### 1.1 GlobalGuardrailEvaluator — 执行护栏（完整闭环）

| 维度 | 事实 |
|---|---|
| 文件 | `src/governance/global-guardrail-evaluator.ts` |
| 实例化点 | `main.ts` L521-522：`new GlobalGuardrailEvaluator(new SqliteGovernanceStore(governance.db))` |
| 依赖 | `GovernanceStore`（SQLite：policies + violations，持久化） |
| 状态写入 | `killSwitchEngaged`（内存，L33）；`toggleKillSwitch` 双写内存+policy 表（L106-115）；违规写入 store（L83）；`setReplanCounterProvider`（L45） |
| 状态读取 | `isKillSwitchActive`（内存+store 双读，L117-124）；`getLoopPreventionLimit`（L57）；`getLoopRisk`（L129）；`listPolicies` / `queryViolations` 透传 |
| 实施入口（已 grep 验证） | ① `capability-dispatcher.ts` `dispatch()` L42-46（sourceType=dispatch）；② `sandbox/host-call-handler.ts` L1083-1088（host_call）；③ `subagent/code-act-executor.ts` `execute()` L642-646（dispatch）；④ `task-planner/dynamic-replanner.ts` `applyTaskPatch()` L100-104（task_patch）；⑤ `meta-test/meta-self-test-engine.ts` 探针（仅自检）；⑥ `api-routes.ts` `/governance/*` |
| 持久化 | ✅（governance.db：policies、violations） |
| 规则 | kill_switch / loop_prevention / rate_limit（violation 窗口计数，>10 阻断）/ budget_limit（预留空实现） |
| 已知缺口 | `meta_decision` 作为 ViolationSourceType 仅被自检探针使用；MetaDecisionEngine 未直接调用 `evaluateGuardrails`（redispatch 间接经 dispatcher 过护栏） |

### 1.2 EcosystemGovernor — 生态级防护网（半实施）

| 维度 | 事实 |
|---|---|
| 文件 | `src/ecosystem/ecosystem-governor.ts` |
| 实例化点 | `main.ts` L581：`new EcosystemGovernor()`（无 store、无依赖注入） |
| 状态 | `rateLimitMap`（内存 L22）、`rateLimitPerMinute`（内存 L23，默认 10）、`killSwitchEngaged`（内存 L24）、`quarantineCategories`（内存 L25，默认 `["resource_exhausted","logic_deadlock"]`） |
| 状态写入 | `checkSubmitPermission`（L34）、`engageKillSwitch`/`disengageKillSwitch`（L131/135）、`addQuarantineCategory`/`removeQuarantineCategory`（L145/149）、`setRateLimit`（L159）、`reset`（L180） |
| 状态读取 | `FederationStore.promote()` 调 `canPromote`（federation-store.ts L43-53）；`api-routes.ts` `/ecosystem/*` 全部方法 |
| 实施入口 | **仅 1 个生产调用方**：`canPromote`（FederationStore.promote）。`checkSubmitPermission` / `evaluateCandidate` / `approveQuarantine` / `federate` / `setRateLimit` 均**无生产调用方**，只有 Dashboard API 能触达 |
| 持久化 | ❌ 全内存，重启全丢（含 kill switch、quarantine 类别、rate limit 配置） |
| 阈值 | `QUARANTINE_TRUST_THRESHOLD = 0.55` **硬编码**（L19） |

### 1.3 EcosystemGovernance（GovernanceV2）— 策略版本容器（零实施）

| 维度 | 事实 |
|---|---|
| 文件 | `src/governance-v2/ecosystem-governance.ts`、`src/governance-v2/types.ts` |
| 实例化点 | `main.ts` L586：`new EcosystemGovernance()`（无 store） |
| 状态 | `currentValues`（内存 L16）、`snapshots[]`（内存 L17）、`auditLogs[]`（内存 L18），初始版本 1.0.0 |
| 状态写入 | `update`（L54，SemVer 递增 + 快照 + 审计）、`rollback`（L93，产出 `x.y.z-rollback-<ts>` 版本） |
| 状态读取 | `api-routes.ts` `/governance-v2/*`（current/update/snapshots/rollback/audit-log，L2922-2958）→ 仅 Dashboard 展示 |
| 实施入口 | **无。** `syncToComponents()`（L148-158）从未被任何代码调用（grep `main.ts` 无命中）；5 个策略字段无一下沉到运行时组件 |
| 持久化 | ❌ 全内存，重启丢版本历史与审计日志 |
| 死配置 | `federationMinTrustScore` / `negotiationTimeoutMs` / `evolutionCoolingDays` / `governorRateLimit` / `quarantineCategories` —— **写入但无人读取** |

---

## 2. 重叠矩阵

| 功能 | GlobalGuardrail | EcosystemGovernor | GovernanceV2 | 结论 |
|---|---|---|---|---|
| Kill Switch | ✅ 内存+DB 双写；作用于 dispatch / host_call / task_patch | ✅ 仅内存；作用于 federation promote / checkSubmit | ❌ | **双实例并存，互不相干**（见 2.1） |
| Rate Limit | ✅ violation 窗口计数（countViolationsSince > 10 → block） | ✅ per-agent 60s 窗口计数（10/min） | 仅存储 `governorRateLimit`，不生效 | **两套语义不同的实现**（见 2.2） |
| Quarantine 类别 | ❌ | ✅ 内存 Set；仅 Dashboard API 触达 | 仅存储 `quarantineCategories`，不生效 | 存储/实施脱节 |
| Trust 阈值 | ❌ | ✅ 硬编码 0.55（evaluateCandidate） | 仅存储 `federationMinTrustScore`（默认同为 0.55） | **双源默认值一致，未来必然漂移**（见 2.3） |
| Loop Prevention | ✅ 系统计数（replanCounterProvider → `dynamicReplanner.getReplanCount`） | ❌ | ❌ | 唯一，无重叠 |
| 版本管理 / 回滚 | ❌ | ❌ | ✅ 内存 snapshots + rollback | 唯一，无重叠 |
| 审计 | ✅ violations 持久化 | ❌ | ✅ auditLogs（内存） | 两处审计，语义不同（违规 vs 策略变更），可共存 |

### 2.1 关键冲突：两个独立的 Kill Switch

- `POST /governance/kill-switch`（api-routes L722-730）只切 GlobalGuardrail 的开关 → 阻断 dispatch/host_call，**不阻断** federation promote。
- `POST /ecosystem/kill-switch`（api-routes L2740-2745）只切 EcosystemGovernor 的开关 → 阻断 federation，**不阻断** dispatch。
- 后果：Dashboard 上有两个 kill switch 按钮，语义都是"全局熔断"，实际各管一段。审计视角这是**状态分裂**，任何一边误判都会造成"以为全停了其实还在跑"。

### 2.2 两套 Rate Limit 语义

- GlobalGuardrail：以 **guardrail 违规次数**为窗口（`countViolationsSince(cooldown, "rate_limit")`），>10 次阻断。防的是"反复违规"。
- EcosystemGovernor：以 **每 agent 每 60s 提交次数**为窗口。防的是"提交风暴"。
- 两者防的不是同一件事，但都叫 rate limit，且 GovernanceV2 里还有一个 `governorRateLimit` 想配置后者。合并时必须显式命名区分：`guardrail_rate_limit` 与 `federation_submit_rate_limit`。

### 2.3 Trust 阈值双源

- `EcosystemGovernor.evaluateCandidate` 硬编码 `QUARANTINE_TRUST_THRESHOLD = 0.55`（L19）。
- `GovernanceV2` 默认 `federationMinTrustScore: 0.55`（types.ts L34），可配置但无人读取。
- 当前巧合一致；一旦 GovernanceV2 被 Dashboard 修改，Governor 仍用 0.55 → 配置"改了没反应"。

---

## 3. Governance Core 设计草案

### 3.0 原则

- **单一状态权威**：Kill Switch、Rate Limit 配置、Trust 阈值、Quarantine 类别，运行时只读一份权威状态。
- **只接线不重写**：GlobalGuardrail 的规则评估逻辑（kill/loop/rate）已通过 Phase 1-3 验证，原样保留。
- **门面兼容**：`GlobalGuardrailEvaluator` / `EcosystemGovernor` / `EcosystemGovernance` 的公共方法签名在迁移期间保持不变，main.ts 注入点与 api-routes 不动。

### 3.1 Core 主类职责边界

```
GovernanceCore（唯一 new 出来的治理组件）
├── Guard 子域     —— 执行护栏（现状 GlobalGuardrail 的职责，原样迁移）
├── Policy 子域    —— 策略版本/回滚/审计（现状 GovernanceV2 的职责 + 持久化补位）
└── Evolution 子域 —— 把 Policy 值应用到运行时组件（现状 syncToComponents 的完整化）
```

职责边界：
- Core 不直接评估规则，只做**装配与仲裁**：把 Policy 子域的当前值推给 Guard / Evolution 子域，并保证三个子域共享同一个 Kill Switch 状态。
- Core 是唯一被 main.ts 实例化的治理入口；三个旧类在迁移期作为 Core 的门面存在（见 §4）。

### 3.2 Guard 子域 — 管什么 / state schema

| 项 | 内容 |
|---|---|
| 职责 | kill_switch、loop_prevention、rate_limit、violation 审计（原 GlobalGuardrail 全部职责） |
| 权威状态 | 直接复用现有 `GovernanceStore`（SQLite），不新增状态副本 |

```
GuardState（持久化于 governance.db）
├── killSwitchActive: boolean          （唯一 Kill Switch 状态）
├── policies: GovernancePolicy[]       （现有表结构不变）
├── violations: GuardrailViolation[]   （现有表结构不变）
└── replanCount: (executionId) => number  （注入 provider，现状不变）
```

### 3.3 Policy 子域 — 管什么 / state schema

| 项 | 内容 |
|---|---|
| 职责 | 策略字段定义、SemVer 版本、快照、回滚、审计日志（原 GovernanceV2 职责） |
| 变化 | 新增持久化（建议 `governance-v2.db`）；字段定义增加"生效目标"元数据 |

```
PolicyState（持久化于 governance-v2.db，新增）
├── currentValues: GovernancePolicyValues      （现有接口不变）
├── snapshots: PolicySnapshot[]                （现有接口不变）
├── auditLogs: GovernanceAuditLog[]            （现有接口不变）
└── fieldTargets: 字段 → 下游组件映射（静态元数据，非运行时状态）
    ├── federationMinTrustScore → Evolution 子域 → FederationStore 门槛
    ├── negotiationTimeoutMs   → NegotiationEngine.bidDeadlineMs
    ├── evolutionCoolingDays   → EvolutionAnalyzer 冷却
    ├── governorRateLimit      → Evolution 子域 → Governor 提交限频
    └── quarantineCategories   → Evolution 子域 → Governor 隔离类别
```

### 3.4 Evolution 子域 — 管什么 / state schema

| 项 | 内容 |
|---|---|
| 职责 | 把 Policy 当前值**应用到**运行时组件；记录每次应用结果（applied version + 时间 + 成功/失败） |
| 本质 | 补全现有 `syncToComponents()`（L148-158）从未被调用的问题 |
| 状态 | 只需一个轻量应用记录 |

```
EvolutionState
├── appliedVersion: string          （最近一次成功下发的 policy version）
├── appliedAtMs: number
├── lastSyncErrors: string[]
└── 下游适配器（targets，注入式）：
    ├── governor.setRateLimit
    ├── governor.setQuarantineCategories
    ├── governor.setTrustThreshold（新增，替换硬编码 0.55）
    ├── federationStore.setMinTrustScore
    ├── negotiationEngine.setTimeout
    └── evolutionAnalyzer.setCoolingDays
```

---

## 4. 迁移路径（Phase 4.1 及之后）

> 每一步都以"Phase 1-3 已有验证全绿"为完成条件：`scripts/phase11-2-audit-verify.ts`、`scripts/phase3-1-decision-lifecycle-verify.ts`、`scripts/phase3-2-trust-gate-verify.ts`、`scripts/phase3-3-loop-prevention-verify.ts`。

### Step 0 — 基线（可跳过，已完成）
记录当前三个类的公共 API 表面，作为门面兼容清单。

### Step 1 — Guard 子域落地（最低风险，先行）
- 新建 `GovernanceCore`（`src/governance-core/governance-core.ts`），内部持有 Guard 子域 = **原 GlobalGuardrailEvaluator 实例**（复用现有类，不重写）。
- Core 暴露 `guardrail` / `governor` / `governance` 三个门面引用，`main.ts` L521-586 的注入点全部改为从 Core 取。
- **破坏性：零。** GlobalGuardrail 类与方法签名不变，Phase 1 / 3.3 验证不受影响。
- 验收：现有 4 个验证脚本全绿 + 新脚本 phase4-1 的 T1（见 §6）。

### Step 2 — Policy 子域持久化
- GovernanceV2 加 `SqliteGovernanceStoreV2`（governance-v2.db）：`currentValues`、`snapshots`、`auditLogs` 落库。
- `update` / `rollback` 仍走内存 + 写库；重启后从库恢复。
- **破坏性：低。** 公共方法签名不变，仅构造参数新增可选 store。
- 验收：现有脚本全绿 + phase4-1 T2（rollback 后重启恢复）。

### Step 3 — Evolution 子域接线（关键一步）
- 在 `main.ts` 中真正调用一次"初始化同步 + 每次 update/rollback 后同步"：
  - `governorRateLimit → ecosystemGovernor.setRateLimit`
  - `quarantineCategories → ecosystemGovernor`（替换默认 Set）
  - `federationMinTrustScore → EcosystemGovernor.evaluateCandidate` 阈值（替换硬编码 0.55，新增 `setTrustThreshold`）
  - `negotiationTimeoutMs → negotiationEngine`、`evolutionCoolingDays → evolutionAnalyzer`（若目标组件支持，否则先记录 not-applied）
- **破坏性：中。** 只影响"配置是否生效"，不改变 Guard 规则逻辑。风险点是阈值来源变化可能改变 evaluateCandidate 结果（当前无生产调用方，实际影响面≈0）。
- 验收：现有脚本全绿 + phase4-1 T3/T4（配置→行为生效链路）。

### Step 4 — Kill Switch 归一
- 唯一 Kill Switch 状态落在 GlobalGuardrail（已双写 governance.db）。
- EcosystemGovernor 的 `engageKillSwitch`/`disengageKillSwitch`/`isKillSwitchActive` 改为**委托 Core 读取同一状态**（保持方法签名，dashboard 不感知）。
- `POST /ecosystem/kill-switch` 与 `POST /governance/kill-switch` 最终写同一状态。
- **破坏性：中。** 行为变化：生态 kill switch 现在也会阻断 dispatch（语义正确，但属于可感知变化，需在验证脚本中显式断言）。
- 验收：现有脚本全绿 + phase4-1 T1 扩展（kill switch 同时阻断 dispatch 与 promote）。

### Step 5 — 收尾
- 三个旧类保留为门面（薄委托），或按用户决策删除并更新 api-routes / dashboard 引用。
- 补 persistence 测试（重启恢复）与配置生效测试。

---

## 5. 风险清单

| # | 风险 | 等级 | 说明与规避 |
|---|---|---|---|
| R1 | Kill Switch 状态双写/多写 | High | 现状已有内存+DB 双写；合并时严禁引入第三个写入点。所有 toggle 走 Core 单一方法。 |
| R2 | Policy 优先级冲突 | High | loop_prevention 已有 `policy config > env > default` 优先级（resolveMaxReplan L204-213）；GovernanceV2 引入后不得再叠加一层优先级，需明确：**运行时护栏阈值以 Guard 子域 policy 为准，GovernanceV2 只做版本管理**。 |
| R3 | quarantine 突然生效改变现有行为 | Medium | `evaluateCandidate` 当前无生产调用方，一旦接线可能突然开始拦截。接线顺序：先接 `canPromote`（已生效），再评估 `evaluateCandidate` 是否需要生产接入，避免行为突变。 |
| R4 | 内存状态重启丢失 | High | Governor / GovernanceV2 全内存。Step 2 必须先行补持久化，否则 Step 4 kill switch 归一会把"唯一状态"建立在易失内存上。 |
| R5 | 验证脚本依赖具体类名 | Medium | phase3-2 等脚本 import 具体类。门面兼容保证签名不变；脚本无需改动。 |
| R6 | 反向漂移 | Medium | `setRateLimit` 被 Evolution 子域调用后若不同步回写 GovernanceV2，会再次出现双源。约定：**运行时组件只读，不回写**。 |
| R7 | meta_decision 入口未直连护栏 | Medium | ViolationSourceType 含 meta_decision，但 MetaDecisionEngine 未直接调用 evaluateGuardrails（仅 redispatch 间接过护栏）。Phase 4.1 实施时复核是否需要为 scale_agent / switch_policy / degrade 增加护栏前置评估。 |
| R8 | `syncToComponents` 的 targets 全用 `any` | Low | federationStore / negotiationEngine / evolutionAnalyzer 参数类型为 any。接线时补明确接口类型，避免编译期漏配。 |

---

## 6. Phase 4.1 独立验证脚本设计

`scripts/phase4-1-governance-core-verify.ts`（参考 phase3-1 风格，真实实例 + 断言）：

| # | 用例 | 断言 |
|---|---|---|
| T1 | 唯一 Kill Switch | `core.toggleKillSwitch(true)` 后：dispatch 被拦（返回 undefined）+ host_call 被拦 + `ecosystemGovernor.isKillSwitchActive() === true`（委托生效）+ `federationStore.promote` 被拒。关闭后全部恢复。 |
| T2 | 权威状态唯一（重启恢复） | `core` 重建（新实例读 governance.db + governance-v2.db）：kill switch 状态、GovernanceV2 当前版本与快照与审计日志恢复一致。 |
| T3 | Policy 生效链路（rate limit） | `ecosystemGovernance.update({ governorRateLimit: 2 }, ...)` → 同步后 `ecosystemGovernor.getRateLimit() === 2`；`checkSubmitPermission` 第 3 次提交被拒。 |
| T4 | Policy 生效链路（trust 阈值） | `ecosystemGovernance.update({ federationMinTrustScore: 0.9 }, ...)` → `evaluateCandidate({ originTrustScore: 0.8, ... })` 返回 quarantined。 |
| T5 | Policy 生效链路（quarantine 类别） | `update({ quarantineCategories: ["a","b"] })` → `ecosystemGovernor.getQuarantineCategories() === ["a","b"]`，且 evaluateCandidate 按新类别隔离。 |
| T6 | 回滚回归 | rollback 后：GovernanceV2 版本/快照正确，且已下发的组件状态回退（或明确标记需手动重新同步）。 |
| T7 | 回归 | 复跑 phase11-2 / phase3-1 / phase3-2 / phase3-3 全部通过（防 Phase 1-3 被打散）。 |

---

## 7. 重叠程度评估

- **逻辑重叠**：仅 Kill Switch（双实例）与 Rate Limit（双语义）两处，且都可归类为"命名冲突 + 接线缺失"，非"两套逻辑都在跑同一条链路的同一步"。
- **存储重叠**：Guardrail 有持久化，另两个全内存，无存储冲突。
- **判定：胶水级合并 + 一处状态归一（Kill Switch）**。工作量 ≈ 新增 1 个装配类 + 2 个 SQLite store + 1 条同步接线；不需要重写任何规则评估逻辑。真正需要谨慎的是 Step 4（Kill Switch 归一会改变现有可感知行为）与 Step 3（配置首次生效）。
