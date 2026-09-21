# HTTP 接口

服务默认监听 `8080`（`PORT`），数据库路径由 `DATABASE_PATH` 指定。所有读写均为 JSON；只读视图每次从事件流实时归约，不缓存可能过期的结论。

## 写入：只有追加

### `POST /events`

投递单个交换事件（信封形状见 [`events.md`](events.md)）。入站校验通过后写入：

- `201` 新建：`{ "outcome": "appended", "event": { … } }`
- `200` 幂等重放：`{ "outcome": "duplicated", "event": { … } }`
- `400` 载荷或信封校验失败，返回字段级错误数组 `errors`
- `409` `event_id` 或 `(source, source_sequence)` 被不同内容占用，返回已存在事件，**原始记录不可覆盖**

### `POST /events/batch`

请求体 `{ "events": [ … ] }`。在一个事务内顺序追加，任一事件校验/冲突失败则整体回滚（不留部分写入）。返回 `{ appended, duplicated }`。

### 不存在的接口即保证

没有任何 `PUT`/`PATCH`/`DELETE` 路径；直接改写数据库会被 `GET /integrity` 通过载荷摘要发现。

## 读取与决策支持

| 方法 & 路径 | 说明 |
| --- | --- |
| `GET /health` | 健康检查 |
| `GET /events` / `GET /events/{id}` | 原始事件流；可用 `?subject_ref=` 过滤 |
| `GET /integrity` | 重算全部事件 `sha256` 摘要，返回 `{ total, mismatches, ok }` |
| `GET /sources/next-sequence?source=` | 某来源下一个可用序号 |
| `GET /rules/effective?sport=&at=` | 某运动在指定时刻生效的规则版本；省略 `at` 取当前 |
| `GET /rosters?competition_id=&sport=` | 草案列表（含提交时间与决定链） |
| `GET /rosters/{id}/validation?as_of=&consecutive_gap_days=` | 草案校验报告 |
| `GET /competitions/{id}/compare` | 同一比赛全部方案并列对比 |
| `GET /competitions/{id}/results` | 按奖牌 / 奥运资格 / 训练验证三类拆分的结果 |
| `GET /athletes/{id}/timeline` | 运动员全周期追溯 |
| `GET /pairings/{id}/profile` | 组合共同参赛记录与共同成绩 |

### 校验报告

```json
{
  "roster_id": "R-AG-A",
  "as_of": "2026-09-01T00:00:00+08:00",
  "pinned_rule": { "rule_set_id": "WL-2026", "sport": "weightlifting",
                   "version": "v2026", "effective_from": "2026-01-01T00:00:00+08:00" },
  "competition": { "competition_id": "AG-WL-2026", "name": "亚运会·举重", "…": "…" },
  "active_entry_count": 3,
  "warnings": [
    { "code": "INJURY_UNAVAILABLE", "severity": "block",
      "message": "运动员在比赛期间处于不可用状态",
      "refs": { "entry_id": "E-A-2", "athlete_id": "A-WL-02", "reason": "…" } },
    { "code": "CONSECUTIVE_COMPETITION", "severity": "caution",
      "message": "与上/下一场比赛间隔过短，存在连续作战风险",
      "refs": { "gap_days": 2, "recent_training_load": 420, "…": "…" } }
  ],
  "counts": { "block": 4, "caution": 6, "by_code": { "…": "…" } },
  "latest_decision": null
}
```

- `as_of` 复现任一时刻仍有效的报名条目（被移除条目不参与，但保留在轨迹里）；
- `pinned_rule` 是解释这份名单所用的规则版本，规则后改不影响历史报告；
- `latest_decision` 展示最近一次人工终决（含理由与知悉的风险代码），但 `warnings` 永远是系统重算的结果。

### 方案对比

`GET /competitions/{id}/compare` 的每个方案返回：出场人数/条目数、覆盖小项、`block_count`/`caution_count` 与风险代码分布、`youth_selection_count`（年轻人才导向的选拔依据数）、提交状态与最近决定——供"按项目比较不同方案的取舍"。

### 运动员全周期追溯

`GET /athletes/{id}/timeline` 返回：

- `athlete`：资格信息；
- `pairings`：所属组合及组建/解散时间；
- `quotas`：以个人为持有人的席位；
- `roster_history`：每条报名记录（含选拔依据、移除原因、相关替换/终决及理由）；
- `results`：个人项目成绩（不含组合共同成绩）；
- `timeline`：把可用性、负荷、入选/移除、成绩合并排序的事件时间线。

## 典型流程

1. 训练管理部门用各来源（`medical`、`science`、`calendars`、`rules-office`、`decision-desk` 等）投递登记事件；
2. 教练组对同一比赛创建多份 `roster.created` 草案并追加条目，随时调用 validation 端点看四类风险；
3. 教练组用 `selection_basis.recorded` 写明每个入选的依据（积分/选拔赛季位/人才培养）；
4. 决策会上比较方案，通过 `decision.recorded`（**必须写理由**）批准/驳回/知悉风险/执行替换；
5. 赛后投递 `result.recorded`，按三类效果查看，组合成绩在 pairing profile 单独积累；
6. 规则改版只需发布新版本；审计历史名单时，钉定版本保证其仍按创建时规则解释，且可用 `/integrity` 证明原始数据未被篡改。
