import assert from "node:assert/strict";
import test from "node:test";

import { verifyIntegrity } from "../src/db.js";
import {
  athleteTimeline,
  compareRosters,
  competitionResults,
  pairingProfile,
  validateRoster,
} from "../src/projection.js";
import { scenario } from "./scenario.js";

test("草案 A 自动识别：连续作战、超额报名、规则不兼容、伤号与席位缺失", () => {
  const { state } = scenario();

  const wl = validateRoster(state, "R-AG-A", { asOf: "2026-09-01T00:00:00+08:00" });
  assert.equal(wl.pinned_rule.version, "v2026");
  const codes = wl.warnings.map((warning) => warning.code);
  assert.ok(codes.includes("INJURY_UNAVAILABLE"), "应识别伤号不可用");
  assert.ok(codes.includes("OVER_ENTRY_NOC"), "应识别 W59 超额报名");
  assert.ok(codes.includes("EVENT_INCOMPATIBLE"), "应识别 W49/W59 级别不兼容");
  assert.ok(codes.includes("OVER_ENTRY_ATHLETE"), "应识别同一运动员兼项超限");
  assert.ok(codes.includes("QUOTA_MISSING"), "应识别伤号无席位仍出场");
  assert.ok(codes.includes("CONSECUTIVE_COMPETITION"), "应识别世锦赛后连续作战");
  const consecutive = wl.warnings.find((warning) => warning.code === "CONSECUTIVE_COMPETITION");
  assert.equal(consecutive.refs.other_competition_id, "WC-WL-2026");
  assert.equal(consecutive.refs.gap_days, 2);
  assert.ok(consecutive.refs.recent_training_load >= 420, "连续作战风险应附带近期负荷");
  assert.ok(wl.counts.block > 0);
});

test("乒乓草案识别：组合规则通过、女单超配、邀请赛时间冲突", () => {
  const { state } = scenario();
  const tt = validateRoster(state, "R-AG-TT", { asOf: "2026-09-01T00:00:00+08:00" });
  const ttCodes = tt.warnings.map((warning) => warning.code);
  assert.ok(ttCodes.includes("OVER_ENTRY_NOC"), "女单 3 个出场席应超过每协会 2 席");
  assert.ok(ttCodes.includes("TIME_CONFLICT"), "A-TT-03 与邀请赛赛期重叠应被识别");
  assert.ok(!ttCodes.includes("PAIRING_REQUIRED"), "有效混双组合不应误报");
  assert.ok(!ttCodes.includes("PAIRING_DISCIPLINE_MISMATCH"));
  const xdOver = tt.warnings.filter((w) => w.code === "OVER_ENTRY_NOC" && w.refs.event_code === "TT-XD");
  assert.equal(xdOver.length, 0, "混双组合计一席，不应超配");
});

test("人工决定只追加留痕，不消除系统识别结论，也不改动原始记录", () => {
  const { state, db } = scenario();

  const before = validateRoster(state, "R-AG-A");
  const beforeCount = before.warnings.length;
  assert.equal(before.latest_decision.action, "reject");
  assert.ok(before.latest_decision.rationale.length >= 2, "驳回理由必须留档");

  // 驳回决定之后再校验：风险依旧（系统识别不被人工决定回写）
  const after = validateRoster(state, "R-AG-A");
  assert.equal(after.warnings.length, beforeCount);
  assert.equal(after.latest_decision.action, "reject");

  // 被知悉的风险仍在报告中，但批准决定记录了知悉清单
  const approved = validateRoster(state, "R-AG-B");
  const approvedCodes = approved.warnings.map((warning) => warning.code);
  assert.ok(approvedCodes.includes("CONSECUTIVE_COMPETITION"));
  assert.deepEqual(approved.latest_decision.acknowledged_warning_codes,
    ["INJURY_LIMITED", "CONSECUTIVE_COMPETITION"]);

  const integrity = verifyIntegrity(db);
  assert.equal(integrity.ok, true);
  assert.ok(integrity.total >= 30);
});

test("规则调整后，历史名单仍按当时钉定的规则版本解释", () => {
  const { state } = scenario();

  // v2 在 2027 年生效，但 2026 年创建的草案永远按 v2026 解释
  const historical = validateRoster(state, "R-AG-A", { asOf: "2027-06-01T00:00:00+08:00" });
  assert.equal(historical.pinned_rule.version, "v2026");
  assert.ok(historical.warnings.every((warning) => warning.refs.rule_version !== "v2027-la"));

  // 2027 年的新草案使用新级别：旧级别应被判为不在规则内
  state.rosters.set("R-2027", {
    roster_id: "R-2027", competition_id: "AG-WL-2026", sport: "weightlifting",
    label: "洛杉矶周期演练", created_at: "2027-02-01T09:00:00+08:00",
    submitted_at: null,
    entries: new Map([
      ["E-2027-1", {
        entry_id: "E-2027-1", athlete_id: "A-WL-01", event_code: "WL-W59",
        role: "individual", pairing_id: null,
        added_at: "2027-02-01T09:10:00+08:00", removed_at: null, removed_reason: null,
      }],
    ]),
    selection_bases: [], decisions: [],
  });
  const future = validateRoster(state, "R-2027", { asOf: "2027-06-01T00:00:00+08:00" });
  assert.equal(future.pinned_rule.version, "v2027-la");
  assert.ok(future.warnings.some((warning) => warning.code === "EVENT_NOT_IN_RULES"));
});

test("赛事结果区分奖牌、奥运资格与阶段性训练验证三类效果", () => {
  const { state } = scenario();

  const ttSummary = competitionResults(state, "AG-TT-2026");
  assert.deepEqual(ttSummary.medals.map((result) => result.medal), ["silver"]);
  assert.deepEqual(
    ttSummary.olympic_qualifications.map((result) => result.olympic_qualification),
    ["confirmed"],
  );
  assert.equal(ttSummary.training_validations.length, 1);
  assert.equal(ttSummary.training_validations[0].athlete_id, "A-TT-YOUTH");
  assert.equal(ttSummary.training_validations[0].training_validation.phase, "phase-2-altogether");
  assert.equal(ttSummary.training_validations[0].training_validation.passed, true);

  const wlSummary = competitionResults(state, "AG-WL-2026");
  assert.equal(wlSummary.medals[0].medal, "gold");
  assert.equal(wlSummary.medals[0].olympic_qualification, "earned");
  // 训练验证与奖牌互不混淆
  assert.equal(wlSummary.training_validations.length, 0);
});

test("新配对的共同参赛记录独立积累", () => {
  const { state } = scenario();
  const profile = pairingProfile(state, "P-XD-01");
  assert.equal(profile.joint_competition_count, 1);
  // 共同成绩挂在组合上，而不是摊到个人
  assert.equal(profile.joint_results.length, 1);
  assert.equal(profile.joint_results[0].medal, "silver");
  assert.deepEqual(profile.pairing.member_ids, ["A-TT-01", "A-TT-02"]);
  // 个人追溯里不混入组合成绩
  const individual = athleteTimeline(state, "A-TT-01");
  assert.ok(individual.results.every((result) => result.pairing_id === null));
  assert.ok(individual.pairings.some((pairing) => pairing.pairing_id === "P-XD-01"));
});

test("按项目比较多份方案的取舍", () => {
  const { state } = scenario();
  const comparison = compareRosters(state, "AG-WL-2026");
  assert.deepEqual(comparison.options.map((row) => row.roster_id), ["R-AG-A", "R-AG-B"]);
  const planA = comparison.options.find((row) => row.roster_id === "R-AG-A");
  const planB = comparison.options.find((row) => row.roster_id === "R-AG-B");
  assert.ok(planA.block_count > planB.block_count, "方案 A 阻断项应多于方案 B");
  assert.equal(planB.block_count, 0);
  assert.equal(planB.latest_decision.action, "approve");
  assert.ok(Object.keys(planA.warning_codes).length > 0);
});

test("从一名运动员可追溯入选、替换与负荷变化全过程", () => {
  const { state } = scenario();
  const timeline = athleteTimeline(state, "A-WL-01");
  const kinds = timeline.timeline.map((item) => item.kind);
  assert.ok(kinds.includes("load"), "应包含负荷变化");
  assert.ok(kinds.includes("entry_added"), "应包含入选");
  assert.ok(kinds.includes("availability"), "应包含伤病可用性");
  assert.ok(kinds.includes("result"), "应包含成绩效果");

  // 世锦赛 → 亚运连续两届的入选轨迹（同方案兼报两个级别时只计一次方案）
  const rosterIds = [...new Set(timeline.roster_history.map((record) => record.roster_id))];
  assert.deepEqual(rosterIds, ["R-WC", "R-AG-A", "R-AG-B"]);

  // 被替换新人的轨迹：移除记录与替换决定均可追溯
  const youth = athleteTimeline(state, "A-TT-YOUTH");
  const removed = youth.roster_history.find((record) => record.entry_id === "E-TT-YOUTH");
  assert.ok(removed.removed_at);
  assert.match(removed.removed_reason, /观摩/);
  const substitution = removed.decisions.find((decision) => decision.action === "substitute");
  assert.ok(substitution);
  assert.equal(substitution.out_entry_id, "E-TT-YOUTH");
  assert.equal(substitution.in_entry_id, "E-TT-6");
  assert.ok(substitution.rationale.length >= 2);
  // 训练验证效果也能在个人轨迹中看到
  assert.ok(youth.results.some((result) => result.training_validation?.phase === "phase-2-altogether"));
});
