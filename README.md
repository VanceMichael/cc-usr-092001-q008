# 国家队赛历负荷决策台

面向亚运会"争成绩、适应洛杉矶奥运新规则、发现年轻人才"三目标的后端决策台。登记运动员资格、项目规则版本、组合关系、伤病可用性、比赛与训练负荷、资格席位及选拔依据；生成参赛草案时自动识别**时间冲突、连续作战风险、超额报名、规则不兼容**；人工决定必须记录理由且不能回写篡改原始数据；赛事结果区分**奖牌、奥运资格、阶段性训练验证**三类效果，新配对共同参赛单独积累；规则调整后历史名单仍按当时规则解释。

## 设计要点

- **事实只追加**：原始事实存 `fact_events`，库内触发器禁止 UPDATE/DELETE；更正只能追加新事实。
- **规则按版本冻结**：每个方案修订固化事实位点（`fact_position`）与规则版本快照（`rules_snapshot`），历史名单永远按当时规则解释。
- **决策另存**：方案/修订/校验结果/人工理由全部在决策表，只追加，绝不回写事实层。
- **读模型即归约**：注册簿视图由事实流在内存重放得到，可随时重建。

领域对象与判定口径见 [`docs/domain.md`](docs/domain.md)，交换字段示例见 [`contracts/`](contracts/)。

## 运行

```bash
make test      # node:test 行为检查
make migrate   # 初始化本地数据目录 data/app.sqlite3
make run       # 启动服务，默认 :8080，健康检查 GET /health
```

配置经环境变量传入：`PORT`、`DATABASE_PATH`。敏感值与本地数据库文件不提交仓库。需要 Node.js ≥ 22（使用内置 `node:sqlite`）。

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/v1/facts` | 登记一个或一批事实（幂等，按 `event_id`/来源序号去重）；结果事实自动派生效果 |
| GET | `/v1/facts` | 事实查询（`subject_ref`/`fact_type`/`source` 过滤） |
| GET | `/v1/registry/{athletes,rules,pairings,competitions,quotas,selection-basis}` | 注册簿只读视图 |
| GET | `/v1/registry/availability/:ref` · `/v1/registry/loads/:ref` | 伤病窗口 / 负荷序列 |
| POST | `/v1/plans` | 建立参赛方案（可带 `variant_of` 关联备选方案） |
| POST | `/v1/plans/:id/revisions` | 追加修订：冻结位点+规则版本并运行四类校验 |
| POST | `/v1/plans/:id/decisions` | 追加人工决定（`reason` 必填）：submit/replace/withdraw/override/approve |
| GET | `/v1/plans` · `/v1/plans/:id` | 方案列表 / 方案含全部修订、findings、决定 |
| GET | `/v1/competitions/:id/compare` | 按项目并列不同方案的取舍 |
| GET | `/v1/effects` · `/v1/effects/summary` | 三类效果查询与分别汇总 |
| GET | `/v1/pairings/:id/ledger` | 新配对共同参赛台账 |
| GET | `/v1/athletes/:ref/timeline` | 一名运动员的入选/替换/负荷变化全过程 |

### 最小流程

```bash
curl -s localhost:8080/v1/facts -H 'content-type: application/json' -d @contracts/fact.eligibility.example.json
curl -s localhost:8080/v1/plans -H 'content-type: application/json' \
  -d '{"competition_id":"G2026","title":"亚运名单甲","created_by":"coach-zhang"}'
```

无理由的人工决定返回 `422 REASON_REQUIRED`；存在未豁免阻断问题时报送返回 `409 OUTSTANDING_BLOCKS` 并回传待处理项。
