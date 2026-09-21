# 领域约定

国家队赛历负荷决策台围绕**运动员、项目规则与参赛方案**保存可核对的业务记录。系统分三层：只追加的事实层、人工产物的决策层、赛事到达后的效果层。外部主体使用不含真实身份信息的稳定引用编号（如 `A-FAN`、`PAIR-XD-1`、`G2026`），时间采用带偏移量的 ISO 8601 字符串，材料只保存受控引用和 `sha256` 摘要。

## 一、事实层（只追加，不可回写）

所有外部信息以交换事件登记到 `fact_events`，字段包含 `event_id`、`subject_ref`、`fact_type`、`occurred_at`、`source`、`source_sequence`、`payload_digest` 与 `payload`。

- 来源序号只在同一来源内递增且唯一；`event_id` 全局唯一，重复提交按幂等处理。
- 接收方必须保留原始 `occurred_at`，不得用到达时间（`ingested_at`）覆盖。
- `payload_digest` 为载荷规范化 JSON 的 `sha256:` 摘要；同 `event_id` 不同摘要视为篡改并拒绝。
- **存储层设有触发器，禁止对 `fact_events` 执行 UPDATE/DELETE。** 任何更正只能以"后发生的新事实"追加（例如伤停恢复、资格变更、组合重组）。

事实类型（`fact_type`）：

| 类型 | 说明 | 关键字段 |
| --- | --- | --- |
| `athlete_eligibility` | 运动员资格（eligible/suspended/retired）与可报项目 | `eligible_for[]` |
| `discipline_rule` | 项目规则版本，按 `effective_from` 分时点生效 | `rule_id`、`version`、`event_code`(可空=整项通用)、`body` |
| `pairing` | 双打/组合关系 | `members[]`、`action=formed/reformed/dissolved`、`is_new` |
| `availability` | 伤病/可用性时间窗 | `window_start`、`window_end`(空=开放)、`status` |
| `competition` | 比赛（games/worlds/qualifier/training_verification） | `starts_at`、`ends_at` |
| `competition_event` | 比赛内具体上场时段 | `session_starts_at/ends_at` |
| `load` | 训练/比赛负荷 | `metric_date`、`load_value` |
| `quota_slot` | 资格席位与剩余名额 | `max_entries`、`entries_used`、`qualification_path` |
| `selection_basis` | 选拔依据（含证据引用+摘要） | `rationale`、`evidence_refs[]` |
| `competition_result` | 比赛结果 | `medal_rank`、`quota_outcome`、`validation` |

读模型**不落库**：`replayFacts(db, { upToId })` 按 `occurred_at` 顺序把事实流归约为内存模型，可用 `upToId` 冻结到任一历史位点。

## 二、规则版本冻结（历史名单按当时规则解释）

`resolveRule(discipline, event_code, asOf)` 取评估时点之前最近生效的版本；同一生效时间下，小项专用版本（`event_code` 非空）优先于整项通用版本。

方案每次生成修订版本时固化两样东西：

1. `fact_position`：归约位点（`fact_events.id` 上界）；
2. `rules_snapshot`：本方案涉及的每个小项实际使用的规则版本映射。

因此规则后来调整（如举重新级别、乒乓球设项变化）**不会改写历史名单的判定**——重看旧修订时，仍按其冻结的规则版本与事实位点解释。

## 三、决策层（人工产物，另存于决策表）

方案 `entry_plans` 可有多个修订 `plan_revisions`；每个修订固化名单 `plan_entries` 与自动校验结果 `plan_findings`。

四类自动识别：

| code | 判定 | 严重级 |
| --- | --- | --- |
| `time_conflict` | 同一自然人上场时段交叠 | block |
| `consecutive_risk` | 距上一场赛事间隔不足，叠加赛前负荷窗口均值超阈值时升级为 block | warn/block |
| `over_quota` | 超过资格席位剩余名额；超过规则兼项上限 | block |
| `rule_incompatible` | 无生效规则/级别已调整/组合解散或构成不符/资格不符/伤停 | block（新配对提示为 warn） |

人工决定 `plan_decisions` 只追加：`submit / replace / withdraw / override / approve`。

- **任何决定都必须填写非空 `reason`**，无理由返回 `REASON_REQUIRED`。
- 存在未豁免 block 时 `submit` 返回 `OUTSTANDING_BLOCKS`；`override` 必须指向具体 block finding 且留理由，豁免后该问题不再阻断报送。
- `approve` 后方案定稿（`decided`），不可再追加修订；历史修订的名单原样保留。
- 决策层永不写回 `fact_events`。

## 四、效果层（三类效果严格区分）

结果事实到达后确定性派生 `effects`（按结果事实幂等）：

- `medal`：奖牌，`medal_rank` 1/2/3；
- `olympic_qualification`：奥运资格，`quota_outcome` secured/pending/not_achieved；
- `training_validation`：阶段性训练验证，结论存 `validation`。

三类效果在汇总中分别计数，训练验证不与奖牌、资格混算。**新配对组合**的共同出场单独积累到 `partnership_participation`（累计共同出场次数、奖牌数，从首场 `together_from` 起算），不并入成员个人履历；运动员时间线中配对成绩仅给出台账指引。

## 五、追溯与方案对比

- `GET /v1/athletes/:ref/timeline` 合并事实流与决策流，串起一名运动员的入选、移出、替换（含理由）、伤病、负荷环比变化与个人效果。
- `GET /v1/competitions/:id/compare` 按项目并列不同方案的条目数、阻断/警示问题与所适用规则版本，支撑"争成绩 / 适应新规则 / 练新人"三目标的取舍。
