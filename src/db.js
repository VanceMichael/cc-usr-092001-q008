import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// 仅追加的原始事实登记表。决策层不得回写本表；任何更正都以"新事实"追加。
// 同一来源内 source_sequence 严格递增；event_id 全局唯一（幂等接收）。
const FACT_SCHEMA = `
CREATE TABLE IF NOT EXISTS fact_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id        TEXT NOT NULL UNIQUE,
  subject_ref     TEXT NOT NULL,
  fact_type       TEXT NOT NULL,
  occurred_at     TEXT NOT NULL,   -- 原始发生时间（ISO 8601 带偏移），不以到达时间覆盖
  ingested_at     TEXT NOT NULL,   -- 到达/登记时间，仅作留痕
  source          TEXT NOT NULL,
  source_sequence INTEGER NOT NULL,
  payload_digest  TEXT NOT NULL,
  payload         TEXT NOT NULL,   -- 原样载荷 JSON
  UNIQUE(source, source_sequence)
);
CREATE INDEX IF NOT EXISTS idx_fact_subject ON fact_events(subject_ref);
CREATE INDEX IF NOT EXISTS idx_fact_type_time ON fact_events(fact_type, occurred_at);

-- 原始事实只追加：任何更新/删除在存储层直接失败，更正只能追加新事实
CREATE TRIGGER IF NOT EXISTS fact_events_no_update BEFORE UPDATE ON fact_events
BEGIN
  SELECT RAISE(FAIL, 'fact_events 仅追加：禁止更新原始事实，更正请追加新事实');
END;
CREATE TRIGGER IF NOT EXISTS fact_events_no_delete BEFORE DELETE ON fact_events
BEGIN
  SELECT RAISE(FAIL, 'fact_events 仅追加：禁止删除原始事实');
END;
`;

// 读模型不落库：由 fact_events 在内存中归约（replayFacts），可随时按位点重建。

// 决策层：人工产物，独立于事实表；只追加、不改写原始数据。
const DECISION_SCHEMA = `
CREATE TABLE IF NOT EXISTS entry_plans (
  plan_id        TEXT PRIMARY KEY,
  competition_id TEXT NOT NULL,
  title          TEXT NOT NULL,
  status         TEXT NOT NULL,      -- draft | decided | superseded
  current_revision INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plan_revisions (
  plan_id        TEXT NOT NULL,
  revision       INTEGER NOT NULL,   -- 从 1 递增
  created_at     TEXT NOT NULL,
  created_by     TEXT NOT NULL,
  note           TEXT,
  fact_position  INTEGER NOT NULL,   -- 归约位点：fact_events.id 上界，冻结解释口径
  rules_snapshot TEXT NOT NULL,      -- JSON：本次评估实际使用的规则版本映射
  PRIMARY KEY (plan_id, revision)
);

CREATE TABLE IF NOT EXISTS plan_entries (
  plan_id        TEXT NOT NULL,
  revision       INTEGER NOT NULL,
  entry_seq      INTEGER NOT NULL,
  subject_ref    TEXT NOT NULL,      -- 个人或配对（pairing_id 也登记为 subject 维度）
  entry_kind     TEXT NOT NULL,      -- individual | pair
  event_code     TEXT NOT NULL,
  discipline     TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'competitor', -- competitor | alternate
  PRIMARY KEY (plan_id, revision, entry_seq)
);
CREATE INDEX IF NOT EXISTS idx_pentry_subject ON plan_entries(subject_ref);

CREATE TABLE IF NOT EXISTS plan_findings (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id        TEXT NOT NULL,
  revision       INTEGER NOT NULL,
  code           TEXT NOT NULL,      -- time_conflict | consecutive_risk | over_quota | rule_incompatible
  severity       TEXT NOT NULL,      -- block | warn
  subject_ref    TEXT,
  event_code     TEXT,
  message        TEXT NOT NULL,
  detail         TEXT NOT NULL       -- JSON 证据
);
CREATE INDEX IF NOT EXISTS idx_finding_plan ON plan_findings(plan_id, revision);

CREATE TABLE IF NOT EXISTS plan_decisions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id        TEXT NOT NULL,
  revision       INTEGER NOT NULL,
  action         TEXT NOT NULL,      -- submit | replace | withdraw | override | approve
  subject_ref    TEXT,
  event_code     TEXT,
  reason         TEXT NOT NULL,      -- 人工理由（强制，空白拒绝）
  decided_by     TEXT NOT NULL,
  decided_at     TEXT NOT NULL,
  replaced_entry_seq INTEGER,        -- 替换动作指向的原条目
  finding_id     INTEGER,            -- override 动作指向被豁免的 block finding
  UNIQUE(plan_id, id)
);
CREATE INDEX IF NOT EXISTS idx_decision_plan ON plan_decisions(plan_id);

-- 方案被新方案取代（同项目多方案取舍/版本延续）
CREATE TABLE IF NOT EXISTS plan_links (
  plan_id        TEXT NOT NULL,
  relation       TEXT NOT NULL,      -- supersedes | variant_of
  related_plan_id TEXT NOT NULL,
  PRIMARY KEY (plan_id, relation, related_plan_id)
);
`;

// 效果层：赛事结果。三类效果区分；配对共同参赛单独积累。
const EFFECT_SCHEMA = `
CREATE TABLE IF NOT EXISTS effects (
  effect_id      TEXT PRIMARY KEY,
  competition_id TEXT NOT NULL,
  event_code     TEXT NOT NULL,
  subject_ref    TEXT NOT NULL,      -- 个人或配对
  entry_kind     TEXT NOT NULL,      -- individual | pair
  effect_type    TEXT NOT NULL,      -- medal | olympic_qualification | training_validation
  medal_rank     INTEGER,           -- 1/2/3，仅 medal
  quota_outcome  TEXT,              -- secured | pending | not_achieved，仅 olympic_qualification
  validation     TEXT,              -- JSON：阶段性训练验证结论/指标
  recorded_at    TEXT NOT NULL,
  source_fact_id INTEGER            -- 对应结果事实，保证可回溯
);
CREATE INDEX IF NOT EXISTS idx_effect_subject ON effects(subject_ref);
CREATE INDEX IF NOT EXISTS idx_effect_comp ON effects(competition_id, event_code);

CREATE TABLE IF NOT EXISTS effect_outcomes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  effect_id   TEXT NOT NULL,
  metric_key  TEXT NOT NULL,
  metric_value TEXT NOT NULL
);

-- 配对共同参赛台账：只按"共同出场"积累，不并入个人履历
CREATE TABLE IF NOT EXISTS partnership_participation (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  pairing_id     TEXT NOT NULL,
  competition_id TEXT NOT NULL,
  event_code     TEXT NOT NULL,
  together_from  TEXT,              -- 该组合首次共同参赛时间（首次积累时固化）
  appearances    INTEGER NOT NULL DEFAULT 0,
  medals         INTEGER NOT NULL DEFAULT 0,
  last_result    TEXT,
  UNIQUE(pairing_id, competition_id, event_code)
);
CREATE INDEX IF NOT EXISTS idx_partnership_pair ON partnership_participation(pairing_id);
`;

const AUDIT_SCHEMA = `
CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  target      TEXT,
  detail      TEXT NOT NULL
);
`;

export const SCHEMA_SQL =
  FACT_SCHEMA + DECISION_SCHEMA + EFFECT_SCHEMA + AUDIT_SCHEMA;

export function migrate(db) {
  db.exec(SCHEMA_SQL);
  db.exec(
    "CREATE TABLE IF NOT EXISTS service_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
  );
  db.prepare(
    "INSERT OR IGNORE INTO service_meta(key, value) VALUES(?, ?)"
  ).run("schema_version", "2");
}

export function openDb(databasePath = process.env.DATABASE_PATH) {
  const resolved =
    databasePath ?? path.join(process.cwd(), "data", "app.sqlite3");
  if (resolved !== ":memory:") {
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
  }
  const db = new DatabaseSync(resolved);
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  // node:sqlite 未提供 better-sqlite3 风格的 transaction()，这里补一个同步事务垫片
  if (typeof db.transaction !== "function") {
    db.transaction = (fn) => (...args) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = fn(...args);
        db.exec("COMMIT");
        return result;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    };
  }
  return db;
}
