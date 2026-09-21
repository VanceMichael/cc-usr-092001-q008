# 领域约定

国家队赛历负荷决策台围绕**运动员、项目规则版本、组合关系、伤病可用性、比赛与训练负荷、资格席位、选拔依据与参赛草案**保存可核对的业务记录。外部主体使用不含真实身份信息的稳定引用编号，时间采用带偏移量的 ISO 8601 字符串，材料只保存受控引用和 `sha256` 摘要。

## 核心建模原则

1. **事件仅追加（append-only）**。系统中没有"修改"操作：报名调整是"移除旧条目 + 追加新条目"，规则改版是"发布新版本"，人工终决是"追加决定"。存储层不提供更新/删除事件的接口（见 `src/db.js`），每条事件保存规范序列化后的 `sha256` 摘要，`GET /integrity` 可随时重算核对。
2. **原始发生时间优先于到达时间**。归约按 `occurred_at`（领域时间）排序，乱序到达不改变历史解释；同刻事件按写入序号 `id` 定序。
3. **人工决定留痕但不回写系统识别**。自动校验结论（时间冲突、连续作战、超额、规则不兼容等）是纯函数，每次请求从事件流重算；教练的批准/驳回/替换决定只能追加，且必须包含非空理由（`rationale`），可以用 `acknowledged_warning_codes` 声明知悉哪些风险，但风险本身不会从报告中消失。
4. **规则版本在草案创建时钉定（pin）**。草案使用 `effective_from <= roster.created_at` 的最新规则版本；之后发布的新规则（如洛杉矶周期举重新级别）不影响历史名单的解释。`validation.pinned_rule` 明确展示本次解释所用版本。
5. **效果分三类，互不混淆**。赛事结果到达后，系统分别汇总：奖牌（`medal`）、奥运资格效果（`olympic_qualification`）、阶段性训练验证（`training_validation.phase/passed`）。
6. **新配对共同记录独立积累**。组合（混双等）拥有自己的共同报名与共同成绩集合，不摊派到个人；个人追溯中不混入组合成绩（见 `pairingProfile` 与 `athleteTimeline`）。

## 交换信封

交换事件包含 `event_id`、`event_type`、`subject_ref`、`occurred_at`、`source`、`source_sequence` 和 `payload`。来源序号只在同一来源内递增：

- 同一 `event_id` 重放且内容一致 → 幂等返回 `duplicated`；
- 同一 `event_id` 内容不同，或同一 `(source, source_sequence)` 被不同内容占用 → `409` 冲突，原始记录保留；
- 服务端另存 `registered_at`（到达时间）与 `payload_digest`，不参与业务归约。

完整字段形状见 [`docs/events.md`](events.md)，HTTP 接口见 [`docs/api.md`](api.md)。示例内容仅用于说明字段形状，不代表真实人员、机构或业务结论。

## 自动识别的风险代码

校验报告（`validateRoster`）中每条风险含 `severity`（`block` 阻断 / `caution` 提示）、`code`、中文说明与 `refs` 证据：

| 代码 | 级别 | 含义 |
| --- | --- | --- |
| `TIME_CONFLICT` | block | 与该运动员另一场在录比赛的赛期重叠 |
| `CONSECUTIVE_COMPETITION` | caution | 两场比赛间隔 ≤ 阈值（默认 7 天，可由 `consecutive_gap_days` 调整），附带间隔天数与窗口内训练负荷 |
| `OVER_ENTRY_NOC` | block | 小项出场席位数超过钉定规则的 `max_entries_per_noc`（组合按一个席计） |
| `OVER_ENTRY_ATHLETE` | block | 同一运动员兼报小项数超过 `max_entries_per_athlete`，或同一小项重复报名 |
| `EVENT_INCOMPATIBLE` | block | 同一运动员兼报的两个小项不在规则兼容矩阵内（如举重新旧级别不可兼项） |
| `EVENT_NOT_IN_RULES` | block | 报名小项不存在于钉定规则版本（已废止/未启用的级别） |
| `PAIRING_REQUIRED` / `PAIRING_DISCIPLINE_MISMATCH` / `PAIRING_MEMBER_MISMATCH` / `PAIRING_NOT_FORMED` / `PAIRING_DISSOLVED` | block | 要求组合的小项（如混双）上，报名未引用有效组合 |
| `INJURY_UNAVAILABLE` / `INJURY_LIMITED` | block / caution | 比赛窗口内运动员处于不可用或受限状态 |
| `QUOTA_MISSING` | caution | 出场报名没有对应的未退回资格席位（临时席位也算覆盖） |
| `RULESET_MISSING` / `COMPETITION_MISSING` | block | 草案创建时无生效规则，或引用的比赛未登记 |

## 追溯与取舍

- `GET /athletes/{id}/timeline`：一名运动员的入选、移除、替换决定、选拔依据、伤病、负荷、个人成绩的统一时间线；
- `GET /pairings/{id}/profile`：组合维度的共同参赛与共同成绩；
- `GET /competitions/{id}/compare`：同一比赛下全部草案的出场规模、阻断/提示数、风险代码分布、年轻人才选拔数与最终决定并列对比。
