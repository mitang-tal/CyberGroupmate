# Phase 7.x Review 约束追踪（硬性开发约束）

> 来源：Phase 7.1–7.4 review 顾虑。**后续 phase 必须纳入 commit 切分与验收标准，不允许 squash 掉。**
> 状态约定：`[决策已定]`=已有结论；`[选型待定]`=需在实现前拍板；`[待办]`=尚未实现，排入对应 phase。

---

## 一、Phase 7.1 漏项追加

### #11 Dashboard 前端页面（Miss）
- **约束**：原 7.1 规范 Commit 4 交付物（Experience & Failure Intelligence 页面：Failure Patterns 看板 + Experience Memory 管理 + 手动废除/提升）未实现。
- **归属**：Phase 8.x 治理面板阶段一并做。
- **验收**：面板可见 Failure Patterns（频次/置信度）+ Active Experiences，支持手动调低置信度、Revoke、强制提升为永久规则。
- 状态：`[待办]`

### #12 `extractPatternFromFailure` 触发时机
- **约束**：实现选了"每次执行失败触发"（接入 execution-record-service），但需显式评估 tradeoff：
  - 即时触发：每次 alert 延迟低成本高、经验形成快；
  - 批量触发：省成本但经验形成慢。
- 状态：`[选型待定]`（当前实现为即时触发，需补评估记录）

### Cache（热路径缓存漏项，无编号）
- **约束**：Dispatch / Replan 前置注入是高频热路径，`queryRelevantExperience` 无缓存会拖累调度。
- **归属**：Phase 7.2 Sandbox Simulation 与 sandbox 共用同一 cache 层实现。
- 状态：`[已落地-7.2]`（`TTLQueryCache` 5s TTL，`extractFromFailure`/`runDecay` 后 invalidate；见 `scripts/phase72-sandbox-verify.ts`）

### Revoke Audit（手动 Revoke 无审计漏项，无编号）
- **约束**：目前只有 `GET /api/experience/patterns`，无 PUT/DELETE；手动改经验规则无 log = 安全后门。
- **归属**：Phase 8.x 安全治理阶段加 PUT/DELETE + audit log（记录 who/when/what）。
- 状态：`[待办]`

## 二、Phase 7.2 Sandbox Simulation 顾虑

- **#14 评分权重 W_s/W_c/W_r**：静态 vs 动态 ROI 回归校准。动态更精准但需数据积累。状态：`[已定-7.2]`（静态可配置 + 预留 `SimulationScorer` 接口，默认 10/0.01/5）。
- **#15 State Rollback Virtualizer 路线**：纯逻辑模拟（快、依赖模型准）vs 轻量隔离副本执行（慢但准）。状态：`[已定-7.2]`（纯逻辑模拟 + `SandboxStateVirtualizer` 快照/恢复，推演无副作用）。
- **#16 avoided_error_count 反事实**：无法直接验证"没这经验必然出错"，需 A/B 或定期 control run。状态：`[选型待定]`（当前仅计数，未做 control）。
- **#17 接入 6.2 Decision Engine 的延迟**：每次决策跑推演有延迟，需可配阈值（high-stakes 走完整 / low-risk 走快速路径）。状态：`[已定-7.2]`（`mode: full|fast` 分档，threshold 由调用方/配置注入，`POST /simulation/run` 透传）。
- **#18 Commit 2 过重拆分**：沙盒引擎 + 多方案评分算法应拆两个 commit。状态：`[已记录]`（后续拆分规格时执行）。

## 三、Phase 7.3 Agent Reputation 约束

- **#19 capabilityScores 算法未明**：滑窗成功率 / 贝叶斯；新 Agent 冷启动初始值需定。当前：mastery=success/total（全量），冷启动无数据 return 0.5/normal。状态：`[选型待定]`。
- **#20 trustScore 多维融合未写 + 抗 gaming 策略**：需防 Agent 专挑 low-stakes 刷 trust。当前公式 `reliability - risk*0.3 - failRate*0.2`。状态：`[选型待定]`。
- **#21 衰减曲线形状**：线性/指数/半衰期（1 天/周/月）直接影响稳定性。当前用概率型（risk/失败率）而非时间衰减。状态：`[选型待定]`。
- **#22 信任状态切换需 hysteresis（滞回窗）**：防路由抖动。当前直接用阈值切换，无滞回。状态：`[待办]`。
- **#23 probation 具体行为**：完全禁用 / 只接 low-stakes / shadow mode 三路线开销差别大。当前实现仅权重减半，未阻断。状态：`[选型待定]`。
- **#24 Commit 3 过重**：Dispatcher 集成 + Simulation 集成 + API 暴露应拆分。状态：`[已记录]`。

## 四、Phase 7.4 Meta Self-Test 约束

- **#25 健康分公式未写 + 权重分级**：Guardrail Respect失败应比 Deadlock 严重。当前 health 为 4 探针平均分，无分级。状态：`[已落地-7.4]`（加权健康分：guardrail/kill_switch 权重 1.5，deadlock/rigidity 1.0，可配置 `HealthWeights`；verify `phase74-meta-test-verify.ts`）。
- **#26 自检资源消耗**：cron 跑 Full Suite 频率+成本需控制。状态：`[已落地-7.4]`（`meta_self_test.schedule` cron 表达式 + 检查间隔配置，默认 60s 轮询、按分钟去重；main.ts 接线、shutdown 停止）。
- **#27 探针执行独立性**：Self-Kill 探针是否会污染并影响其他 probe？需定串行（安全慢）/ 并行（快但污染）。状态：`[已落地-7.4]`（串行执行 + try/finally 恢复 guardrail 状态，探针中途崩溃不泄漏 kill switch / replan provider）。
- **#28 自检失败自动响应未写**：降级/告警/停机/自愈链路？状态：`[已落地-7.4]`（`alertEmitter` 注入：critical/degraded 推送 `system.meta_health_alert` 事件到 NotificationCenter，`changed` 区分新故障/持续故障，healthy 静默）。
- **#29 Commit 2 过重**：4 探针 + Health Score 计算应拆。状态：`[已落地-7.4]`（#25/#26/#27/#28 分 4 个独立 commit 落地，均 tsc clean + verify）。

## 排期汇总（后续 commit 必含）

| 归属 | 需实现 / 需决策 | 约束编号 |
|------|----------------|----------|
| 8.x 治理面板 | Dashboard 前端（Patterns 看板 + 经验管理 + Revoke/提升） | #11 |
| 8.x 安全治理 | Experience PUT/DELETE + audit log（who/when/what） | Revoke Audit 漏项 |
| 7.2/sandbox | queryRelevantExperience 热路径缓存（与 sandbox 共用 cache 层） | Cache 漏项 |
| 待定 | 各选型决策（静态/动态权重、纯逻辑/副本、收益率 control、延迟阈值、探针串行/并行） | #14-#17,#23,#27(其余已落地) |

> 说明：本表为**约束清单**，具体实现在相应 phase 的 commit 切分 + 验收标准中落实（不 squash）。Phase 7.x 约束 #19-#29 均已按 commit 拆分落地（见各 phase-complete.md 与 verify 脚本）。