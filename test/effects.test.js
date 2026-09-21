import assert from "node:assert/strict";
import test from "node:test";

import { seedDatabase } from "./helpers.js";
import { ingestFact } from "../src/facts.js";
import { addDecision, addRevision, createPlan } from "../src/plans.js";
import { deriveEffects, effectSummary, getPartnershipLedger, listEffects } from "../src/effects.js";
import { athleteTimeline } from "../src/trace.js";

function resultEvent(over = {}) {
  return {
    event_id: "EV-RES-G1",
    subject_ref: "PAIR-XD-1",
    fact_type: "competition_result",
    occurred_at: "2026-09-27T20:00:00+08:00",
    source: "RESULTS",
    source_sequence: 2, // 1 已被种子里的世锦赛结果占用
    payload: {
      competition_id: "G2026",
      event_code: "TT_XD",
      entry_kind: "pair",
      pairing_id: "PAIR-XD-1",
      members: ["A-FAN", "A-CHEN"],
      medal_rank: 1,
      quota_outcome: "secured",
      validation: { phase: "洛杉矶周期混双配合", coordination_score: 8.6 },
    },
    ...over,
  };
}

test("一条结果派生出奖牌/奥运资格/训练验证三类效果", () => {
  const { db } = seedDatabase();
  const ingested = ingestFact(db, resultEvent());
  deriveEffects(db, { factId: ingested.id });

  const effects = listEffects(db, { competition_id: "G2026" });
  const types = new Set(effects.map((e) => e.effect_type));
  assert.deepEqual([...types].sort(), ["medal", "olympic_qualification", "training_validation"]);
  const medal = effects.find((e) => e.effect_type === "medal");
  assert.equal(medal.medal_rank, 1);
  assert.equal(medal.subject_ref, "PAIR-XD-1");
  const quota = effects.find((e) => e.effect_type === "olympic_qualification");
  assert.equal(quota.quota_outcome, "secured");
  const validation = effects.find((e) => e.effect_type === "training_validation");
  assert.equal(validation.validation.coordination_score, 8.6);

  const summary = effectSummary(db, { competition_id: "G2026" });
  assert.equal(summary.summary.medal.gold, 1);
  assert.equal(summary.summary.olympic_qualification.secured, 1);
  assert.equal(summary.summary.training_validation, 1);
});

test("效果派生幂等：重复派生不产生重复效果", () => {
  const { db } = seedDatabase();
  const before = listEffects(db).length; // 种子里世锦赛已派生 1 条奖牌
  assert.equal(before, 1);
  const ingested = ingestFact(db, resultEvent());
  deriveEffects(db, { factId: ingested.id });
  deriveEffects(db, { factId: ingested.id });
  const all = deriveEffects(db);
  assert.equal(all.derived, 0);
  assert.equal(listEffects(db).length, before + 3);
});

test("新配对共同参赛记录单独积累，不并入个人履历", () => {
  const { db } = seedDatabase();
  // 亚运混双：奖牌+资格
  const g1 = ingestFact(db, resultEvent());
  deriveEffects(db, { factId: g1.id });
  // 另一场资格赛：同一组合再次共同出场（无奖牌）
  ingestFact(db, {
    event_id: "EV-COMP-Q", subject_ref: "Q2026", fact_type: "competition",
    occurred_at: "2026-08-01T09:00:00+08:00", source: "CALENDAR", source_sequence: 500,
    payload: {
      competition_id: "Q2026", name: "奥运资格巡回赛", category: "qualifier",
      starts_at: "2026-08-10T09:00:00+08:00", ends_at: "2026-08-12T18:00:00+08:00",
    },
  });
  const q2 = {
    event_id: "EV-RES-Q1", subject_ref: "PAIR-XD-1", fact_type: "competition_result",
    occurred_at: "2026-08-12T20:00:00+08:00", source: "RESULTS", source_sequence: 3,
    payload: {
      competition_id: "Q2026", event_code: "TT_XD", entry_kind: "pair",
      pairing_id: "PAIR-XD-1", members: ["A-FAN", "A-CHEN"],
      validation: { phase: "资格赛配合检验", coordination_score: 7.9 },
    },
  };
  const ing2 = ingestFact(db, q2);
  deriveEffects(db, { factId: ing2.id });

  const ledger = getPartnershipLedger(db, "PAIR-XD-1");
  assert.ok(ledger.is_new);
  assert.deepEqual(ledger.members, ["A-FAN", "A-CHEN"]);
  assert.equal(ledger.total_appearances, 2, "两场共同出场应累计为 2");
  assert.equal(ledger.total_medals, 1, "仅亚运那场有奖牌");
  assert.equal(ledger.appearances.length, 2);

  // 成员个人履历不混入配对效果
  const fan = athleteTimeline(db, "A-FAN");
  const pairSubjects = new Set(fan.individual_effects.map((e) => e.subject_ref));
  assert.ok(!pairSubjects.has("PAIR-XD-1"), "个人效果列表不应包含配对主体");
  assert.equal(fan.pair_effects_ref.length >= 1, true, "但应给出配对台账指引");
});

test("运动员时间线串起入选、替换、负荷变化与决定理由", () => {
  const { db } = seedDatabase();
  // 方案：r1 报 A-WEI（伤停阻断），决定替换为 A-LIU，r2 落实
  const plan = createPlan(db, { competition_id: "G2026", title: "男子举重方案", created_by: "coach-zhao" });
  const r1 = addRevision(db, plan.plan_id, {
    entries: [{ subject_ref: "A-WEI", discipline: "weightlifting", event_code: "WL_M73" }],
    created_by: "coach-zhao", as_of: "2026-09-19T12:00:00+08:00",
  });
  void r1;
  // 豁免 A-WEI 伤停本不该发生，这里走正常替换流程
  addDecision(db, plan.plan_id, {
    action: "withdraw", subject_ref: "A-WEI", event_code: "WL_M73",
    reason: "赛前三日训练中旧伤复发，医疗组建议退出", decided_by: "leader-wang",
  });
  addDecision(db, plan.plan_id, {
    action: "replace", subject_ref: "A-LIU", event_code: "WL_M73", replaced_entry_seq: 1,
    reason: "选拔赛总成绩次名递补，近期训练达标", decided_by: "leader-wang",
  });
  addRevision(db, plan.plan_id, {
    entries: [{ subject_ref: "A-LIU", discipline: "weightlifting", event_code: "WL_M73" }],
    note: "执行递补", created_by: "coach-zhao", as_of: "2026-09-19T20:00:00+08:00",
  });

  const wei = athleteTimeline(db, "A-WEI");
  const kinds = wei.timeline.map((e) => e.kind);
  assert.ok(kinds.includes("availability"), "时间线应含伤病事实");
  assert.ok(kinds.includes("decision.withdraw"), "时间线应含撤回决定");
  assert.ok(kinds.includes("roster_change"), "时间线应含移出名单");
  const withdraw = wei.timeline.find((e) => e.kind === "decision.withdraw");
  assert.match(withdraw.detail.reason, /旧伤复发/);
  // 负荷变化序列（A-WEI 无负荷事实时为空数组）
  assert.deepEqual(wei.load_series, []);

  const liu = athleteTimeline(db, "A-LIU");
  assert.ok(liu.timeline.some((e) => e.kind === "selection"), "A-LIU 应有入选记录");
  assert.ok(liu.timeline.some((e) => e.kind === "decision.replace"), "A-LIU 应有替换递补记录");
  const replace = liu.timeline.find((e) => e.kind === "decision.replace");
  assert.match(replace.detail.reason, /选拔赛/);

  // A-FAN 时间线含负荷环比变化
  const fan = athleteTimeline(db, "A-FAN");
  assert.equal(fan.load_series.length, 3);
  assert.equal(fan.load_series[0].delta_vs_previous, null);
  assert.equal(fan.load_series[2].delta_vs_previous, 2);
});

test("时间线包含世锦赛个人奖牌效果，且配对成绩只作引用", () => {
  const { db } = seedDatabase(); // 种子已让 A-FAN 获世锦赛男单金牌
  const fan = athleteTimeline(db, "A-FAN");
  const gold = fan.individual_effects.find((e) => e.effect_type === "medal" && e.medal_rank === 1);
  assert.ok(gold, "世锦赛金牌应出现在个人效果");
  assert.equal(gold.competition_id, "W2026");
});
