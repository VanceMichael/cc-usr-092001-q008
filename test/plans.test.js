import assert from "node:assert/strict";
import test from "node:test";

import { seedDatabase } from "./helpers.js";
import { addDecision, addRevision, comparePlans, createPlan, getPlan } from "../src/plans.js";
import { ingestFact } from "../src/facts.js";

function entriesA() {
  // 故意汇集各类问题的名单
  return [
    { subject_ref: "A-FAN", discipline: "table_tennis", event_code: "TT_MS" },
    { subject_ref: "A-FAN", discipline: "table_tennis", event_code: "TT_MD" },
    { subject_ref: "PAIR-XD-1", entry_kind: "pair", discipline: "table_tennis", event_code: "TT_XD" },
    { subject_ref: "A-WEI", discipline: "weightlifting", event_code: "WL_M73" },
    { subject_ref: "A-MA", discipline: "weightlifting", event_code: "WL_M73" },
    { subject_ref: "A-LIU", discipline: "weightlifting", event_code: "WL_M73" },
  ];
}

test("修订草案自动识别四类问题", () => {
  const { db } = seedDatabase();
  const plan = createPlan(db, { competition_id: "G2026", title: "方案甲（问题名单）", created_by: "coach-zhang" });
  const report = addRevision(db, plan.plan_id, {
    entries: entriesA(), note: "首轮草案", created_by: "coach-zhang",
    as_of: "2026-09-19T12:00:00+08:00",
  });

  const byCode = new Map();
  for (const f of report.findings) byCode.set(f.code, [...(byCode.get(f.code) ?? []), f]);

  // 时间冲突：A-FAN 男单/男双时段交叠
  const tc = byCode.get("time_conflict") ?? [];
  assert.ok(tc.some((f) => f.severity === "block" && f.subject_ref === "A-FAN"), "应报 A-FAN 时间冲突");

  // 连续作战：世锦赛结束到亚运开赛不足间隔且高负荷
  const cr = byCode.get("consecutive_risk") ?? [];
  const fanRisk = cr.find((f) => f.subject_ref === "A-FAN");
  assert.ok(fanRisk, "应报 A-FAN 连续作战风险");
  assert.equal(fanRisk.severity, "block");
  assert.ok(fanRisk.detail.recent_load_avg >= 80);

  // 超额报名：WL_M73 剩余 1 席却报 3 人
  const oq = byCode.get("over_quota") ?? [];
  assert.ok(oq.some((f) => f.severity === "block" && f.event_code === "WL_M73" && f.detail.remaining_capacity === 1));

  // 规则不兼容：A-WEI 伤停；新配对应给出 warn
  const ri = byCode.get("rule_incompatible") ?? [];
  assert.ok(ri.some((f) => f.severity === "block" && f.subject_ref === "A-WEI" && /伤停/.test(f.message)));
  assert.ok(ri.some((f) => f.severity === "warn" && f.subject_ref === "PAIR-XD-1"));

  assert.equal(report.summary.pass, false);
  assert.ok(report.summary.block_count >= 4);

  // 规则版本被冻结到快照
  assert.equal(report.rules_snapshot["weightlifting|WL_M73"].version, "2028");
  assert.equal(report.rules_snapshot["table_tennis|TT_XD"].version, "2028");
});

test("历史草案按当时规则解释：旧版本下报新级别不兼容", () => {
  const { db } = seedDatabase();
  const plan = createPlan(db, { competition_id: "G2026", title: "回溯草案", created_by: "analyst" });
  // 在 2025 年评估：只有 2024 版规则生效，WL_M73 不在设项中
  const oldReport = addRevision(db, plan.plan_id, {
    entries: [{ subject_ref: "A-MA", discipline: "weightlifting", event_code: "WL_M73" }],
    created_by: "analyst", as_of: "2025-06-01T00:00:00+08:00",
  });
  assert.equal(oldReport.rules_snapshot["weightlifting|WL_M73"].version, "2024");
  assert.ok(
    oldReport.findings.some((f) => f.code === "rule_incompatible" && f.severity === "block" && /不在规则版本 2024/.test(f.message)),
    "旧规则下新级别应不兼容"
  );

  // 同方案后来在 2026 再评估：2028 版生效，级别兼容（A-MA 无伤停，且 WL_M73 只报 1 人不超额）
  const newReport = addRevision(db, plan.plan_id, {
    entries: [{ subject_ref: "A-LIU", discipline: "weightlifting", event_code: "WL_M73" }],
    created_by: "analyst", as_of: "2026-09-19T12:00:00+08:00",
  });
  assert.equal(newReport.rules_snapshot["weightlifting|WL_M73"].version, "2028");
  assert.equal(newReport.findings.some((f) => f.code === "rule_incompatible" && /级别|设项/.test(f.message)), false);

  // 两个历史版本都原样保留，r1 的判定不被规则更新改写
  const stored = getPlan(db, plan.plan_id);
  assert.equal(stored.revisions[0].rules_snapshot["weightlifting|WL_M73"].version, "2024");
  assert.equal(stored.revisions[1].rules_snapshot["weightlifting|WL_M73"].version, "2028");
  assert.ok(stored.revisions[0].findings.some((f) => /2024/.test(f.message)));
});

test("人工决定强制理由；有未豁免 block 时不能报送；豁免后可定稿", () => {
  const { db } = seedDatabase();
  const plan = createPlan(db, { competition_id: "G2026", title: "方案乙", created_by: "coach-li" });
  addRevision(db, plan.plan_id, {
    entries: [
      { subject_ref: "A-FAN", discipline: "table_tennis", event_code: "TT_MS" },
      { subject_ref: "PAIR-XD-1", entry_kind: "pair", discipline: "table_tennis", event_code: "TT_XD" },
      { subject_ref: "A-LIU", discipline: "weightlifting", event_code: "WL_M73" },
    ],
    created_by: "coach-li", as_of: "2026-09-19T12:00:00+08:00",
  });

  // 理由空白被拒
  assert.throws(
    () => addDecision(db, plan.plan_id, { action: "submit", reason: "   ", decided_by: "leader-wang" }),
    /理由/
  );
  // 存在未豁免 block，报送被拒并回传待处理项
  let blocked;
  try {
    addDecision(db, plan.plan_id, { action: "submit", reason: "请报送", decided_by: "leader-wang" });
    assert.fail("应当拒绝报送");
  } catch (err) {
    blocked = err;
  }
  assert.equal(blocked.code, "OUTSTANDING_BLOCKS");
  assert.ok(blocked.details.outstanding.some((f) => f.code === "consecutive_risk"));

  const stored = getPlan(db, plan.plan_id);
  const riskFinding = stored.revisions[0].findings.find((f) => f.code === "consecutive_risk");
  // 只能豁免 block 级
  const warnFinding = stored.revisions[0].findings.find((f) => f.severity === "warn");
  assert.throws(
    () => addDecision(db, plan.plan_id, { action: "override", finding_id: warnFinding.id, reason: "试试", decided_by: "leader-wang" }),
    /只能对 block/
  );

  // 豁免：理由留痕
  addDecision(db, plan.plan_id, {
    action: "override", finding_id: riskFinding.id,
    reason: "医务与体能组联合评估：恢复指标正常，世锦赛后已安排减量，主教练与领队共同承担连续作战风险",
    decided_by: "leader-wang",
  });
  // 重复豁免被拒
  assert.throws(
    () => addDecision(db, plan.plan_id, { action: "override", finding_id: riskFinding.id, reason: "再次", decided_by: "leader-wang" }),
    /已有豁免/
  );

  // 现在可以报送并定稿
  addDecision(db, plan.plan_id, { action: "submit", reason: "名单经队会确认", decided_by: "leader-wang" });
  addDecision(db, plan.plan_id, { action: "approve", reason: "代表团批准", decided_by: "chef-de-mission" });

  const final = getPlan(db, plan.plan_id);
  assert.equal(final.status, "decided");
  assert.equal(final.revisions[0].summary.outstanding_block_count, 0);
  const override = final.revisions[0].decisions.find((d) => d.action === "override");
  assert.match(override.reason, /医务与体能组/);

  // 定稿后不能再追加修订
  assert.throws(
    () => addRevision(db, plan.plan_id, { entries: [], created_by: "coach-li" }),
    /定稿/
  );
});

test("替换决定必须指向原条目并记录理由，且不改动事实层", () => {
  const { db } = seedDatabase();
  const plan = createPlan(db, { competition_id: "G2026", title: "方案丙", created_by: "coach-li" });
  addRevision(db, plan.plan_id, {
    entries: [{ subject_ref: "A-WEI", discipline: "weightlifting", event_code: "WL_M73" }],
    created_by: "coach-li", as_of: "2026-09-19T12:00:00+08:00",
  });
  assert.throws(
    () => addDecision(db, plan.plan_id, { action: "replace", subject_ref: "A-LIU", reason: "换将", decided_by: "leader-wang" }),
    /replaced_entry_seq/
  );
  addDecision(db, plan.plan_id, {
    action: "replace", subject_ref: "A-LIU", event_code: "WL_M73", replaced_entry_seq: 1,
    reason: "A-WEI 赛前受伤，由选拔赛第二名 A-LIU 替补，医疗证明见伤病事实",
    decided_by: "leader-wang",
  });
  // r2 落实替换
  addRevision(db, plan.plan_id, {
    entries: [{ subject_ref: "A-LIU", discipline: "weightlifting", event_code: "WL_M73" }],
    note: "执行替换决定", created_by: "coach-li", as_of: "2026-09-19T18:00:00+08:00",
  });
  const stored = getPlan(db, plan.plan_id);
  assert.equal(stored.revisions[0].entries[0].subject_ref, "A-WEI"); // 历史条目原样
  assert.equal(stored.revisions[1].entries[0].subject_ref, "A-LIU");
  // 原始事实未被改写：A-WEI 伤停事实仍在
  const facts = db.prepare("SELECT COUNT(*) c FROM fact_events WHERE subject_ref='A-WEI' AND fact_type='availability'").get();
  assert.equal(facts.c, 1);
});

test("按项目对比两个方案的取舍", () => {
  const { db } = seedDatabase();
  const p1 = createPlan(db, { competition_id: "G2026", title: "方案甲：稳成绩", created_by: "coach-zhang" });
  addRevision(db, p1.plan_id, {
    entries: [
      { subject_ref: "A-XU", discipline: "table_tennis", event_code: "TT_MS" },
      { subject_ref: "A-LIU", discipline: "weightlifting", event_code: "WL_M73" },
    ],
    created_by: "coach-zhang", as_of: "2026-09-19T12:00:00+08:00",
  });
  const p2 = createPlan(db, {
    competition_id: "G2026", title: "方案乙：练新人+试新配", created_by: "coach-zhang", variant_of: p1.plan_id,
  });
  addRevision(db, p2.plan_id, {
    entries: [
      { subject_ref: "A-FAN", discipline: "table_tennis", event_code: "TT_MS" },
      { subject_ref: "PAIR-XD-1", entry_kind: "pair", discipline: "table_tennis", event_code: "TT_XD" },
      { subject_ref: "A-LIU", discipline: "weightlifting", event_code: "WL_M73" },
    ],
    created_by: "coach-zhang", as_of: "2026-09-19T12:00:00+08:00",
  });

  const cmp = comparePlans(db, "G2026");
  const tt = cmp.by_discipline.table_tennis;
  assert.equal(tt.length, 2);
  const stable = tt.find((x) => x.title.includes("稳成绩"));
  const youth = tt.find((x) => x.title.includes("练新人"));
  assert.equal(stable.competitors_count, 1);
  // 方案乙乒乓球条目：男单 1 + 混双配对 1 = 2（配对作为一个参赛单位）
  assert.equal(youth.competitors_count, 2);
  // 方案乙包含连续作战风险提示
  assert.ok(youth.findings.block.some((f) => f.code === "consecutive_risk") || youth.findings.warn.some((f) => f.code === "consecutive_risk"));
  assert.deepEqual(stable.rules_versions, ["2028"]);
});

test("兼项超过规则上限被判超额", () => {
  const { db } = seedDatabase();
  ingestFact(db, {
    event_id: "EV-EXTRA-1", subject_ref: "A-FAN", fact_type: "athlete_eligibility",
    occurred_at: "2026-08-01T09:00:00+08:00", source: "REGISTRY", source_sequence: 900,
    payload: {
      display_ref: "选手F", gender: "male", eligibility: "eligible",
      eligible_for: ["TT_MS", "TT_XD", "TT_MD", "TT_WS"],
    },
  });
  ingestFact(db, {
    event_id: "EV-EXTRA-2", subject_ref: "G2026", fact_type: "competition_event",
    occurred_at: "2026-08-20T10:04:00+08:00", source: "CALENDAR", source_sequence: 900,
    payload: {
      competition_id: "G2026", event_code: "TT_WS", discipline: "table_tennis", event_label: "第四小项（兼项测试）",
      session_starts_at: "2026-09-29T10:00:00+08:00", session_ends_at: "2026-09-29T12:00:00+08:00",
    },
  });
  const plan = createPlan(db, { competition_id: "G2026", title: "兼项超限", created_by: "coach" });
  const report = addRevision(db, plan.plan_id, {
    entries: ["TT_MS", "TT_MD", "TT_XD", "TT_WS"].map((c) => ({ subject_ref: "A-FAN", discipline: "table_tennis", event_code: c })),
    created_by: "coach", as_of: "2026-09-19T12:00:00+08:00",
  });
  assert.ok(
    report.findings.some((f) => f.code === "over_quota" && /兼项 4 个/.test(f.message)),
    "兼项 4 个超上限 3 应判 block"
  );
});
