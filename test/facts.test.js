import assert from "node:assert/strict";
import test from "node:test";

import { openDb } from "../src/db.js";
import { digestPayload, ingestFact, replayFacts, resolveRule } from "../src/facts.js";

function base(over = {}) {
  return {
    event_id: "EV-T-1",
    subject_ref: "A-T",
    fact_type: "load",
    occurred_at: "2026-09-01T08:00:00+08:00",
    source: "SRC",
    source_sequence: 1,
    payload: { metric_date: "2026-09-01T08:00:00+08:00", load_value: 70, unit: "a.u." },
    ...over,
  };
}

test("合法事实被登记并回算摘要", () => {
  const db = openDb(":memory:");
  const r = ingestFact(db, base());
  assert.equal(r.duplicated, false);
  const row = db.prepare("SELECT * FROM fact_events WHERE event_id='EV-T-1'").get();
  assert.equal(row.payload_digest, digestPayload(base().payload));
  // 原始发生时间保留，登记时间另行留痕
  assert.equal(row.occurred_at, "2026-09-01T08:00:00+08:00");
  assert.match(row.ingested_at, /^\d{4}-\d{2}-\d{2}T/);
});

test("重复事件幂等；不同载荷同 event_id 视为篡改并拒绝", () => {
  const db = openDb(":memory:");
  ingestFact(db, base());
  const again = ingestFact(db, base());
  assert.equal(again.duplicated, true);

  const tampered = base({ payload: { metric_date: "2026-09-01T08:00:00+08:00", load_value: 99, unit: "a.u." } });
  assert.throws(() => ingestFact(db, tampered), /不可篡改/);
});

test("显式 payload_digest 与载荷不一致时拒绝", () => {
  const db = openDb(":memory:");
  const ev = base({ payload_digest: "sha256:" + "a".repeat(64) });
  assert.throws(() => ingestFact(db, ev), /payload_digest/);
});

test("同一来源序号必须唯一", () => {
  const db = openDb(":memory:");
  ingestFact(db, base({ event_id: "EV-T-1" }));
  assert.throws(
    () => ingestFact(db, base({ event_id: "EV-T-2", payload: { metric_date: "2026-09-02T08:00:00+08:00", load_value: 71 } })),
    /序号/
  );
  // 不同来源可各自计数
  assert.doesNotThrow(() =>
    ingestFact(db, base({ event_id: "EV-T-3", source: "OTHER" }))
  );
});

test("fact_events 在存储层禁止 UPDATE/DELETE", () => {
  const db = openDb(":memory:");
  ingestFact(db, base());
  assert.throws(() => db.prepare("UPDATE fact_events SET payload=? WHERE event_id='EV-T-1'").run("{}"), /仅追加/);
  assert.throws(() => db.prepare("DELETE FROM fact_events WHERE event_id='EV-T-1'").run(), /仅追加/);
});

test("载荷校验：未知类型、缺字段、非法枚举与时间格式均被拒绝", () => {
  const db = openDb(":memory:");
  assert.throws(() => ingestFact(db, base({ fact_type: "nope" })), /未知事实类型/);
  assert.throws(() => ingestFact(db, base({ occurred_at: "2026-09-01" })), /ISO 8601/);
  assert.throws(
    () => ingestFact(db, base({ source_sequence: 0 })),
    /source_sequence/
  );
});

function ruleEvent(version, from, eventCode = null, seq = 1) {
  return {
    event_id: `RULE-${version}`,
    subject_ref: "RULE-WL",
    fact_type: "discipline_rule",
    occurred_at: from,
    source: "RULES",
    source_sequence: seq,
    payload: {
      rule_id: "RULE-WL", version, discipline: "weightlifting", event_code: eventCode,
      effective_from: from, body: { event_codes: ["WL_M73"], marker: version },
    },
  };
}

test("规则按时间点解释：历史草案用旧版本，新草案用新版本", () => {
  const db = openDb(":memory:");
  ingestFact(db, ruleEvent("2024", "2024-01-01T00:00:00+08:00"));
  ingestFact(db, ruleEvent("2028", "2026-01-01T00:00:00+08:00", null, 2));

  const oldModel = replayFacts(db);
  const old = resolveRule(oldModel, "weightlifting", "WL_M73", "2025-06-01T00:00:00+08:00");
  const now = resolveRule(oldModel, "weightlifting", "WL_M73", "2026-09-20T00:00:00+08:00");
  assert.equal(old.version, "2024");
  assert.equal(now.version, "2028");
});

test("归约位点 upToId 冻结：后来登记的规则不改变历史解释", () => {
  const db = openDb(":memory:");
  const first = ingestFact(db, ruleEvent("2024", "2024-01-01T00:00:00+08:00"));
  // 在位点 first.id 处归约，只能看到 2024 版
  const frozen = replayFacts(db, { upToId: first.id });
  assert.equal(resolveRule(frozen, "weightlifting", "WL_M73", "2026-09-20T00:00:00+08:00")?.version, "2024");
  // 之后新规则才到达
  ingestFact(db, ruleEvent("2028", "2026-01-01T00:00:00+08:00", null, 2));
  const full = replayFacts(db, { upToId: first.id });
  assert.equal(resolveRule(full, "weightlifting", "WL_M73", "2026-09-20T00:00:00+08:00")?.version, "2024");
  const current = replayFacts(db);
  assert.equal(resolveRule(current, "weightlifting", "WL_M73", "2026-09-20T00:00:00+08:00")?.version, "2028");
});

test("小项专用规则版本优先于整项通用版本", () => {
  const db = openDb(":memory:");
  ingestFact(db, ruleEvent("GEN", "2026-01-01T00:00:00+08:00", null, 1));
  ingestFact(db, ruleEvent("SPEC", "2026-01-01T00:00:00+08:00", "WL_M73", 2));
  const model = replayFacts(db);
  assert.equal(resolveRule(model, "weightlifting", "WL_M73", "2026-09-01T00:00:00+08:00").version, "SPEC");
  assert.equal(resolveRule(model, "weightlifting", "WL_M89", "2026-09-01T00:00:00+08:00").version, "GEN");
});
