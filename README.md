# 国家队赛历负荷决策台

面向亚运备战周期的后端决策台：登记运动员资格、项目规则版本、组合关系、伤病可用性、比赛与训练负荷、资格席位与选拔依据；形成参赛草案时自动识别时间冲突、连续作战风险、超额报名与规则不兼容；最终人工决定必须记录理由且只能追加、不能回写篡改原始数据；赛后按奖牌、奥运资格、阶段性训练验证三类效果归档，新配对的共同参赛记录单独积累；规则改版后历史名单仍按当时钉定的版本解释。

## 架构

仅追加事件流（SQLite）+ 实时投影，无任何更新/删除入口：

- `src/db.js` — 事件存储：幂等/冲突控制、规范序列化与 `sha256` 摘要、完整性校验；
- `src/events.js` — 15 类领域事件目录与入站校验（含"人工决定必须写理由"）；
- `src/projection.js` — 状态归约、草案风险引擎（规则版本钉定）、方案对比、运动员追溯、组合档案、三类结果汇总；
- `src/server.js` — HTTP 接口。

## 目录

- `contracts/` 外部交换字段示例。
- `docs/domain.md` 领域对象、时间、标识与风险代码约定。
- `docs/events.md` 事件目录与载荷形状。
- `docs/api.md` HTTP 接口与典型流程。
- `src/` 服务代码，`test/` 行为测试（含完整亚运场景端到端用例）。

## 运行

执行 `make test` 检查全部行为，执行 `make migrate` 初始化本地数据目录，执行 `make run` 启动服务。默认监听 `8080` 端口，健康检查地址为 `/health`。

```sh
make test          # 20 个测试：存储防篡改、风险引擎、决定留痕、规则钉定、追溯与对比等
make migrate       # 初始化/升级 data/app.sqlite3（幂等，旧数据按序保留）
DATABASE_PATH=./data/app.sqlite3 make run
```

配置通过环境变量传入（`PORT`、`DATABASE_PATH`），敏感值和本地数据库文件不得提交到仓库（`data/`、`*.sqlite3*` 已在 `.gitignore`）。

## 需求对应速查

| 需求 | 落点 |
| --- | --- |
| 三重目标（成绩/适应新规则/发现人才） | 方案对比含风险分布与 `youth_development` 选拔计数 |
| 举重新级别、乒乓调整 | `sport_rule.published` 版本序列 + 兼容矩阵 + `required_pairing_discipline` |
| 资格席位赛/连续世锦赛 | `quota.*` 席位状态；`CONSECUTIVE_COMPETITION`（间隔阈值可配，附带负荷证据） |
| 时间冲突 | `TIME_CONFLICT`（跨草案扫描运动员全部在录比赛） |
| 超额报名 | `OVER_ENTRY_NOC`（组合计一席）、`OVER_ENTRY_ATHLETE` |
| 规则不兼容 | `EVENT_INCOMPATIBLE`、`EVENT_NOT_IN_RULES` |
| 人工决定留痕、不可篡改 | `decision.recorded` 理由强制；仅追加存储 + 摘要 + `/integrity`；无写改写接口 |
| 三类赛事效果 | `GET /competitions/{id}/results` 按奖牌/资格/训练验证拆分 |
| 新配对独立积累 | `GET /pairings/{id}/profile` 共同报名与共同成绩独立 |
| 规则变更后历史可解释 | 草案在 `created_at` 钉定规则版本，报告明示 `pinned_rule` |
| 单人全过程追溯 | `GET /athletes/{id}/timeline`（入选/替换/依据/决定/伤病/负荷/成绩） |
