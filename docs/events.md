# 领域事件目录

所有业务状态都由下列事件归约得到。事件载荷只登记"发生了什么"，不保存可由其他事件推导的结论。信封字段（`event_id`、`subject_ref`、`occurred_at`、`source`、`source_sequence`）的约定见 `domain.md`。

## athlete.registered — 登记运动员资格

```json
{
  "athlete_id": "A-WL-01",
  "pseudonym": "WL-甲",
  "sport": "weightlifting",
  "gender": "female",
  "birth_date": "2000-03-01",
  "tags": ["youth"]
}
```

`sport`/`pseudonym` 为受控文本；`gender` ∈ `female|male`；`birth_date` 可选，格式 `YYYY-MM-DD`；`tags` 可选（如年轻人才标记 `youth`）。

## sport_rule.published — 发布项目规则版本

```json
{
  "rule_set_id": "WL-2026",
  "sport": "weightlifting",
  "version": "v2026",
  "effective_from": "2026-01-01T00:00:00+08:00",
  "entries": [
    {
      "event_code": "WL-W59",
      "max_entries_per_noc": 1,
      "max_entries_per_athlete": 1,
      "compatible_with": ["WL-W59"],
      "required_pairing_discipline": null
    }
  ]
}
```

同一运动可多次发布；按 `effective_from` 形成版本序列，草案在创建时刻自动钉定当时最新版本。`compatible_with` 是小项兼容矩阵（未列出即不可兼报；留空数组表示不校验兼容）；`required_pairing_discipline` 表示该小项必须以组合身份参赛（如混双）。

## pairing.formed / pairing.dissolved — 组合组建与解散

```json
{ "pairing_id": "P-XD-01", "sport": "table_tennis", "discipline": "mixed_double",
  "member_ids": ["A-TT-01", "A-TT-02"], "formed_at": "2026-03-01T10:00:00+08:00" }
```
```json
{ "pairing_id": "P-XD-01", "dissolved_at": "2027-01-10T10:00:00+08:00", "reason": "周期调整" }
```

## availability.declared — 伤病/可用性申报

```json
{ "athlete_id": "A-WL-02",
  "valid_from": "2026-09-10T00:00:00+08:00", "valid_to": "2026-10-15T00:00:00+08:00",
  "status": "unavailable", "severity": "severe", "reason": "膝部急性损伤，医嘱免赛" }
```

`status` ∈ `available|limited|unavailable`；`severity` ∈ `none|light|moderate|severe`（可省略，按 status 推断）。同一时间窗可多次申报，`unavailable` 优先于 `limited`。

## load.recorded — 训练与比赛负荷

```json
{ "athlete_id": "A-WL-01",
  "period_start": "2026-09-10T00:00:00+08:00", "period_end": "2026-09-17T23:59:00+08:00",
  "training_load": 420, "competition_load": 300, "competition_id": "WC-WL-2026" }
```

`competition_load`、`competition_id` 可选。连续作战风险会汇总开赛日前窗口内的训练负荷作为证据。

## competition.scheduled — 登记比赛赛历

```json
{ "competition_id": "AG-WL-2026", "name": "亚运会·举重", "sport": "weightlifting",
  "start_at": "2026-09-19T09:00:00+08:00", "end_at": "2026-09-24T20:00:00+08:00",
  "is_world_championship": false }
```

## quota.held / quota.status_changed — 资格席位获取与状态变化

```json
{ "quota_id": "Q-TT-XD", "sport": "table_tennis", "event_code": "TT-XD",
  "holder_type": "pairing", "holder_ref": "P-XD-01",
  "earned_at": "2026-05-02T10:00:00+08:00",
  "earned_at_competition_id": "QT-ASIA-2026", "status": "provisional" }
```
```json
{ "quota_id": "Q-TT-XD", "status": "confirmed",
  "changed_at": "2026-09-28T20:00:00+08:00", "reason": "亚运混双亚军确认席位" }
```

`holder_type` ∈ `athlete|pairing|noc`；`status` ∈ `provisional|confirmed|returned`，`returned` 的席位不再覆盖出场报名。

## roster.created / entry_added / entry_removed / submitted — 参赛草案生命周期

```json
{ "roster_id": "R-AG-A", "competition_id": "AG-WL-2026", "sport": "weightlifting",
  "label": "亚运举重方案A（双级别押注）", "created_at": "2026-08-05T09:00:00+08:00" }
```
```json
{ "roster_id": "R-AG-A", "entry_id": "E-A-1", "athlete_id": "A-WL-01",
  "event_code": "WL-W59", "role": "individual", "pairing_id": null }
```
```json
{ "roster_id": "R-AG-TT", "entry_id": "E-TT-YOUTH",
  "reason": "综合评估后调整为经验更足的选手，新人转观摩",
  "removed_at": "2026-08-20T15:00:00+08:00" }
```
```json
{ "roster_id": "R-AG-B", "submitted_at": "2026-08-22T10:00:00+08:00" }
```

`role` ∈ `individual|pair_member|substitute`。移除不是删除：条目保留 `removed_at/reason`，历史校验可用 `as_of` 复现任一时刻的名单。同一比赛可以存在多份草案用于横向比较。

## selection_basis.recorded — 选拔依据

```json
{ "roster_id": "R-AG-B", "entry_id": "E-B-1", "athlete_id": "A-WL-01",
  "basis_type": "quota", "reference": "席位 Q-WL-01 持有人",
  "recorded_at": "2026-08-06T10:00:00+08:00" }
```

`basis_type` ∈ `ranking|trial|quota|coach_discretion|youth_development`。`entry_id` 可省略（针对整个名单的依据）。`youth_development` 在方案对比中计入"年轻人才选拔数"。

## decision.recorded — 最终人工决定

```json
{ "roster_id": "R-AG-B", "action": "approve", "decided_by": "USER-director-01",
  "decided_at": "2026-08-22T10:30:00+08:00",
  "rationale": "席位与规则无阻断项；连续作战风险已知悉，由科医组同步监控，批准。",
  "acknowledged_warning_codes": ["INJURY_LIMITED", "CONSECUTIVE_COMPETITION"] }
```

`action` ∈ `approve|reject|override_warning|substitute`。`rationale` 必填且不可为空白（至少 2 个字符）——这是"最终人工决定必须记录理由"的入站强制。`substitute` 时必须提供 `out_entry_id` 与 `in_entry_id`。决定只追加，不修改任何事件或校验结论。

## result.recorded — 赛事结果（三类效果）

```json
{ "competition_id": "AG-WL-2026", "event_code": "WL-W59", "athlete_id": "A-WL-01",
  "medal": "gold", "olympic_qualification": "earned",
  "recorded_at": "2026-09-23T20:00:00+08:00" }
```
```json
{ "competition_id": "AG-TT-2026", "event_code": "TT-XD", "pairing_id": "P-XD-01",
  "medal": "silver", "olympic_qualification": "confirmed",
  "recorded_at": "2026-09-28T20:00:00+08:00" }
```
```json
{ "competition_id": "AG-TT-2026", "event_code": "TT-WS", "athlete_id": "A-TT-YOUTH",
  "olympic_qualification": "none",
  "training_validation": { "phase": "phase-2-altogether", "passed": true },
  "recorded_at": "2026-09-29T20:00:00+08:00" }
```

`athlete_id` 与 `pairing_id` 至少给一个；组合成绩挂在 `pairing_id` 上独立积累。`medal` ∈ `gold|silver|bronze`，`olympic_qualification` ∈ `earned|confirmed|none`，三类效果各自可空，查询端点按类拆分汇总。
