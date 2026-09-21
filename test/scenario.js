import { listEvents } from "../src/db.js";
import { EVENT_TYPES as T } from "../src/events.js";
import { buildState } from "../src/projection.js";
import { makeHarness } from "./support.js";


/**
 * 构造一个贴近需求的完整场景：
 * - 举重 2026 规则（旧级别 W49/W59，每人限一项，级别互不兼容）；
 * - 乒乓球 2026 规则（混双必须组合，女子单打每协会 2 席）；
 * - 亚运会按项目分为 AG-WL-2026 / AG-TT-2026 两个赛区；
 *   举重世锦赛 9/17 结束、亚运举重 9/19 开赛（连续作战）；
 *   邀请赛 9/25-9/27 与亚运乒乓赛区重叠（时间冲突）；
 * - 举重方案 A（含各类问题）与方案 B（稳健）；乒乓方案含新人替换；
 * - 2027 年洛杉矶周期举重新级别生效，验证历史名单仍按旧规则解释。
 */
function scenario() {
  const { db, emit } = makeHarness();
  const E = (type, ref, payload, at, source) => emit(type, ref, payload, at, source);

  // ---- 运动员 ----
  const athletes = [
    ["A-WL-01", "WL-甲", "weightlifting", "female", {}],
    ["A-WL-02", "WL-乙", "weightlifting", "female", {}],
    ["A-TT-01", "TT-甲", "table_tennis", "female", {}],
    ["A-TT-02", "TT-乙", "table_tennis", "male", {}],
    ["A-TT-03", "TT-丙", "table_tennis", "female", {}],
    ["A-TT-04", "TT-丁", "table_tennis", "female", {}],
    ["A-TT-06", "TT-戊", "table_tennis", "female", {}],
    ["A-TT-YOUTH", "TT-新星", "table_tennis", "female", { tags: ["youth"] }],
  ];
  athletes.forEach(([id, pseudonym, sport, gender, extra], i) => {
    E(T.ATHLETE_REGISTERED, id, {
      athlete_id: id, pseudonym, sport, gender, ...extra,
    }, `2026-01-05T09:${String(i * 5).padStart(2, "0")}:00+08:00`);
  });

  // ---- 规则版本 ----
  E(T.RULE_PUBLISHED, "WL-2026", {
    rule_set_id: "WL-2026", sport: "weightlifting", version: "v2026", effective_from: "2026-01-01T00:00:00+08:00",
    entries: [
      { event_code: "WL-W49", max_entries_per_noc: 1, max_entries_per_athlete: 1, compatible_with: ["WL-W49"] },
      { event_code: "WL-W59", max_entries_per_noc: 1, max_entries_per_athlete: 1, compatible_with: ["WL-W59"] },
    ],
  }, "2025-12-20T10:00:00+08:00", "rules-office");
  E(T.RULE_PUBLISHED, "TT-2026", {
    rule_set_id: "TT-2026", sport: "table_tennis", version: "v2026", effective_from: "2026-01-01T00:00:00+08:00",
    entries: [
      { event_code: "TT-XD", max_entries_per_noc: 1, required_pairing_discipline: "mixed_double" },
      { event_code: "TT-WS", max_entries_per_noc: 2, max_entries_per_athlete: 2,
        compatible_with: ["TT-WS", "TT-WD", "TT-XD"] },
    ],
  }, "2025-12-20T10:05:00+08:00", "rules-office");

  // ---- 组合 ----
  E(T.PAIRING_FORMED, "P-XD-01", {
    pairing_id: "P-XD-01", sport: "table_tennis", discipline: "mixed_double",
    member_ids: ["A-TT-01", "A-TT-02"], formed_at: "2026-03-01T10:00:00+08:00",
  }, "2026-03-01T10:00:00+08:00");

  // ---- 伤病可用性 ----
  E(T.AVAILABILITY_DECLARED, "A-WL-02", {
    athlete_id: "A-WL-02", valid_from: "2026-09-10T00:00:00+08:00", valid_to: "2026-10-15T00:00:00+08:00",
    status: "unavailable", severity: "severe", reason: "膝部急性损伤，医嘱免赛",
  }, "2026-09-11T12:00:00+08:00", "medical");
  E(T.AVAILABILITY_DECLARED, "A-WL-01", {
    athlete_id: "A-WL-01", valid_from: "2026-09-01T00:00:00+08:00", valid_to: "2026-09-25T00:00:00+08:00",
    status: "limited", severity: "light", reason: "手腕劳损，控制训练量",
  }, "2026-09-02T12:00:00+08:00", "medical");

  // ---- 负荷（世锦赛—亚运之间） ----
  E(T.LOAD_RECORDED, "A-WL-01", {
    athlete_id: "A-WL-01", period_start: "2026-09-10T00:00:00+08:00", period_end: "2026-09-17T23:59:00+08:00",
    training_load: 420, competition_load: 300, competition_id: "WC-WL-2026",
  }, "2026-09-18T08:00:00+08:00", "science");

  // ---- 比赛 ----
  const competitions = [
    ["WC-WL-2026", "举重世锦赛", "weightlifting", "2026-09-10T10:00:00+08:00", "2026-09-17T18:00:00+08:00", true],
    ["AG-WL-2026", "亚运会·举重", "weightlifting", "2026-09-19T09:00:00+08:00", "2026-09-24T20:00:00+08:00", false],
    ["AG-TT-2026", "亚运会·乒乓球", "table_tennis", "2026-09-24T09:00:00+08:00", "2026-10-02T20:00:00+08:00", false],
    ["INV-2026", "城际邀请赛", "table_tennis", "2026-09-25T09:00:00+08:00", "2026-09-27T18:00:00+08:00", false],
  ];
  competitions.forEach(([id, name, sport, start, end, wc], i) => {
    E(T.COMPETITION_SCHEDULED, id, {
      competition_id: id, name, sport, start_at: start, end_at: end, is_world_championship: wc,
    }, `2026-0${2 + i}-15T10:00:00+08:00`, "calendars");
  });

  // ---- 资格席位 ----
  E(T.QUOTA_HELD, "Q-WL-01", {
    quota_id: "Q-WL-01", sport: "weightlifting", event_code: "WL-W59",
    holder_type: "athlete", holder_ref: "A-WL-01", earned_at: "2026-05-01T10:00:00+08:00",
    earned_at_competition_id: "WC-WL-2026", status: "confirmed",
  }, "2026-05-01T10:00:00+08:00");
  E(T.QUOTA_HELD, "Q-TT-XD", {
    quota_id: "Q-TT-XD", sport: "table_tennis", event_code: "TT-XD",
    holder_type: "pairing", holder_ref: "P-XD-01", earned_at: "2026-05-02T10:00:00+08:00",
    status: "provisional",
  }, "2026-05-02T10:00:00+08:00");
  E(T.QUOTA_HELD, "Q-TT-06", {
    quota_id: "Q-TT-06", sport: "table_tennis", event_code: "TT-WS",
    holder_type: "athlete", holder_ref: "A-TT-06", earned_at: "2026-06-02T10:00:00+08:00",
    status: "provisional",
  }, "2026-06-02T10:00:00+08:00");

  // ---- 世锦赛名单（连续作战背景） ----
  E(T.ROSTER_CREATED, "R-WC", {
    roster_id: "R-WC", competition_id: "WC-WL-2026", sport: "weightlifting",
    label: "世锦赛出战名单", created_at: "2026-08-01T10:00:00+08:00",
  }, "2026-08-01T10:00:00+08:00");
  E(T.ROSTER_ENTRY_ADDED, "E-WC-1", {
    roster_id: "R-WC", entry_id: "E-WC-1", athlete_id: "A-WL-01",
    event_code: "WL-W59", role: "individual",
  }, "2026-08-01T10:10:00+08:00");

  // ---- 邀请赛名单（与亚运乒乓赛区时间冲突） ----
  E(T.ROSTER_CREATED, "R-INV", {
    roster_id: "R-INV", competition_id: "INV-2026", sport: "table_tennis",
    label: "邀请赛名单", created_at: "2026-08-02T10:00:00+08:00",
  }, "2026-08-02T10:00:00+08:00");
  E(T.ROSTER_ENTRY_ADDED, "E-INV-1", {
    roster_id: "R-INV", entry_id: "E-INV-1", athlete_id: "A-TT-03",
    event_code: "TT-WS", role: "individual",
  }, "2026-08-02T10:10:00+08:00");

  // ---- 亚运举重草案 A：激进，故意堆叠各类问题 ----
  E(T.ROSTER_CREATED, "R-AG-A", {
    roster_id: "R-AG-A", competition_id: "AG-WL-2026", sport: "weightlifting",
    label: "亚运举重方案A（双级别押注）", created_at: "2026-08-05T09:00:00+08:00",
  }, "2026-08-05T09:00:00+08:00");
  E(T.ROSTER_ENTRY_ADDED, "E-A-1", {
    roster_id: "R-AG-A", entry_id: "E-A-1", athlete_id: "A-WL-01",
    event_code: "WL-W59", role: "individual",
  }, "2026-08-05T09:10:00+08:00");
  E(T.ROSTER_ENTRY_ADDED, "E-A-2", {
    roster_id: "R-AG-A", entry_id: "E-A-2", athlete_id: "A-WL-02",
    event_code: "WL-W59", role: "individual",
  }, "2026-08-05T09:15:00+08:00");
  E(T.ROSTER_ENTRY_ADDED, "E-A-3", {
    roster_id: "R-AG-A", entry_id: "E-A-3", athlete_id: "A-WL-01",
    event_code: "WL-W49", role: "individual",
  }, "2026-08-05T09:20:00+08:00");
  E(T.SELECTION_BASIS_RECORDED, "BASIS-A-1", {
    roster_id: "R-AG-A", entry_id: "E-A-1", athlete_id: "A-WL-01",
    basis_type: "ranking", reference: "2026 上半年积分排名第 1", recorded_at: "2026-08-05T10:00:00+08:00",
  }, "2026-08-05T10:00:00+08:00");

  // ---- 亚运举重草案 B：稳健 ----
  E(T.ROSTER_CREATED, "R-AG-B", {
    roster_id: "R-AG-B", competition_id: "AG-WL-2026", sport: "weightlifting",
    label: "亚运举重方案B（保成绩）", created_at: "2026-08-06T09:00:00+08:00",
  }, "2026-08-06T09:00:00+08:00");
  E(T.ROSTER_ENTRY_ADDED, "E-B-1", {
    roster_id: "R-AG-B", entry_id: "E-B-1", athlete_id: "A-WL-01",
    event_code: "WL-W59", role: "individual",
  }, "2026-08-06T09:10:00+08:00");
  E(T.SELECTION_BASIS_RECORDED, "BASIS-B-1", {
    roster_id: "R-AG-B", entry_id: "E-B-1", athlete_id: "A-WL-01",
    basis_type: "quota", reference: "席位 Q-WL-01 持有人", recorded_at: "2026-08-06T10:00:00+08:00",
  }, "2026-08-06T10:00:00+08:00");

  // ---- 亚运乒乓方案：含新配对与新人替换 ----
  E(T.ROSTER_CREATED, "R-AG-TT", {
    roster_id: "R-AG-TT", competition_id: "AG-TT-2026", sport: "table_tennis",
    label: "亚运乒乓方案", created_at: "2026-08-07T09:00:00+08:00",
  }, "2026-08-07T09:00:00+08:00");
  E(T.ROSTER_ENTRY_ADDED, "E-TT-1", {
    roster_id: "R-AG-TT", entry_id: "E-TT-1", athlete_id: "A-TT-01",
    event_code: "TT-XD", role: "pair_member", pairing_id: "P-XD-01",
  }, "2026-08-07T09:10:00+08:00");
  E(T.ROSTER_ENTRY_ADDED, "E-TT-2", {
    roster_id: "R-AG-TT", entry_id: "E-TT-2", athlete_id: "A-TT-02",
    event_code: "TT-XD", role: "pair_member", pairing_id: "P-XD-01",
  }, "2026-08-07T09:15:00+08:00");
  E(T.ROSTER_ENTRY_ADDED, "E-TT-3", {
    roster_id: "R-AG-TT", entry_id: "E-TT-3", athlete_id: "A-TT-03",
    event_code: "TT-WS", role: "individual",
  }, "2026-08-07T09:20:00+08:00");
  E(T.ROSTER_ENTRY_ADDED, "E-TT-4", {
    roster_id: "R-AG-TT", entry_id: "E-TT-4", athlete_id: "A-TT-04",
    event_code: "TT-WS", role: "individual",
  }, "2026-08-07T09:22:00+08:00");
  E(T.ROSTER_ENTRY_ADDED, "E-TT-YOUTH", {
    roster_id: "R-AG-TT", entry_id: "E-TT-YOUTH", athlete_id: "A-TT-YOUTH",
    event_code: "TT-WS", role: "individual",
  }, "2026-08-07T09:25:00+08:00");
  E(T.SELECTION_BASIS_RECORDED, "BASIS-TT-YOUTH", {
    roster_id: "R-AG-TT", entry_id: "E-TT-YOUTH", athlete_id: "A-TT-YOUTH",
    basis_type: "youth_development", reference: "青年梯队重点培养，借亚运练兵",
    recorded_at: "2026-08-07T10:05:00+08:00",
  }, "2026-08-07T10:05:00+08:00");

  // 新人被替换：移除条目 + 补入 + 带理由的人工替换决定
  E(T.ROSTER_ENTRY_REMOVED, "E-TT-YOUTH", {
    roster_id: "R-AG-TT", entry_id: "E-TT-YOUTH",
    reason: "综合评估后调整为经验更足的选手，新人转观摩", removed_at: "2026-08-20T15:00:00+08:00",
  }, "2026-08-20T15:00:00+08:00");
  E(T.ROSTER_ENTRY_ADDED, "E-TT-6", {
    roster_id: "R-AG-TT", entry_id: "E-TT-6", athlete_id: "A-TT-06",
    event_code: "TT-WS", role: "individual",
  }, "2026-08-20T15:10:00+08:00");
  E(T.DECISION_RECORDED, "DEC-SUB-1", {
    roster_id: "R-AG-TT", action: "substitute", decided_by: "USER-coach-01",
    decided_at: "2026-08-20T16:00:00+08:00",
    rationale: "新星近期连续作战负荷偏高，本届先随队观摩，席位由 A-TT-06 顶替，理由记入选拔档案。",
    out_entry_id: "E-TT-YOUTH", in_entry_id: "E-TT-6",
  }, "2026-08-20T16:00:00+08:00", "decision-desk");

  // 人工终决：方案 A 驳回；方案 B 与乒乓方案批准（必须有理由）
  E(T.DECISION_RECORDED, "DEC-A", {
    roster_id: "R-AG-A", action: "reject", decided_by: "USER-director-01",
    decided_at: "2026-08-21T10:00:00+08:00",
    rationale: "存在不可用伤号、超额与兼项冲突，成绩风险不可接受，驳回并要求重组。",
  }, "2026-08-21T10:00:00+08:00", "decision-desk");
  E(T.ROSTER_SUBMITTED, "R-AG-B", {
    roster_id: "R-AG-B", submitted_at: "2026-08-22T10:00:00+08:00",
  }, "2026-08-22T10:00:00+08:00");
  E(T.DECISION_RECORDED, "DEC-B", {
    roster_id: "R-AG-B", action: "approve", decided_by: "USER-director-01",
    decided_at: "2026-08-22T10:30:00+08:00",
    rationale: "席位与规则无阻断项；运动员带轻伤与连续作战风险已知悉，由科医组同步监控，批准方案 B 上报。",
    acknowledged_warning_codes: ["INJURY_LIMITED", "CONSECUTIVE_COMPETITION"],
  }, "2026-08-22T10:30:00+08:00", "decision-desk");
  E(T.DECISION_RECORDED, "DEC-TT", {
    roster_id: "R-AG-TT", action: "approve", decided_by: "USER-director-01",
    decided_at: "2026-08-22T11:00:00+08:00",
    rationale: "女单超配与 A-TT-03 邀请赛冲突由教练组确认取舍（放弃邀请赛），混双新配对按计划历练，批准。",
    acknowledged_warning_codes: ["OVER_ENTRY_NOC", "TIME_CONFLICT", "QUOTA_MISSING"],
  }, "2026-08-22T11:00:00+08:00", "decision-desk");

  // ---- 亚运结果：奖牌 / 奥运资格 / 阶段训练验证三类效果 ----
  E(T.RESULT_RECORDED, "RES-1", {
    competition_id: "AG-WL-2026", event_code: "WL-W59", athlete_id: "A-WL-01",
    medal: "gold", olympic_qualification: "earned", recorded_at: "2026-09-23T20:00:00+08:00",
  }, "2026-09-23T20:00:00+08:00", "results");
  E(T.RESULT_RECORDED, "RES-2", {
    competition_id: "AG-TT-2026", event_code: "TT-XD", pairing_id: "P-XD-01",
    medal: "silver", olympic_qualification: "confirmed", recorded_at: "2026-09-28T20:00:00+08:00",
  }, "2026-09-28T20:00:00+08:00", "results");
  E(T.RESULT_RECORDED, "RES-3", {
    competition_id: "AG-TT-2026", event_code: "TT-WS", athlete_id: "A-TT-YOUTH",
    olympic_qualification: "none",
    training_validation: { phase: "phase-2-altogether", passed: true },
    recorded_at: "2026-09-29T20:00:00+08:00",
  }, "2026-09-29T20:00:00+08:00", "results");

  // ---- 2027 年洛杉矶周期举重新级别生效 ----
  E(T.RULE_PUBLISHED, "WL-LA28", {
    rule_set_id: "WL-LA28", sport: "weightlifting", version: "v2027-la",
    effective_from: "2027-01-01T00:00:00+08:00",
    entries: [
      { event_code: "WL-W55", max_entries_per_noc: 1, max_entries_per_athlete: 1, compatible_with: ["WL-W55"] },
      { event_code: "WL-W65", max_entries_per_noc: 1, max_entries_per_athlete: 1, compatible_with: ["WL-W65"] },
    ],
  }, "2026-12-01T10:00:00+08:00", "rules-office");

  return { db, state: buildState(listEvents(db)) };
}


export { scenario };
