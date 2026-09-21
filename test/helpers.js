import { openDb } from "../src/db.js";
import { ingestFact } from "../src/facts.js";
import { deriveEffects } from "../src/effects.js";

// 构造一份一致的脱敏场景：亚运会 G2026 + 此前世锦赛 W2026
let seq = 0;
function envelope(source) {
  let n = 0;
  return (fact_type, subject_ref, occurred_at, payload) => {
    n += 1;
    return {
      event_id: `EV-${source}-${(++seq).toString().padStart(3, "0")}`,
      subject_ref,
      fact_type,
      occurred_at,
      source,
      source_sequence: n,
      payload,
    };
  };
}

export function seedDatabase() {
  const db = openDb(":memory:");
  const reg = envelope("REGISTRY");
  const cal = envelope("CALENDAR");
  const med = envelope("MEDICAL");
  const perf = envelope("PERFORMANCE");

  // --- 运动员资格 ---
  ingestFact(db, reg("athlete_eligibility", "A-WEI", "2026-01-05T09:00:00+08:00", {
    display_ref: "选手W", gender: "male", eligibility: "eligible", eligible_for: ["WL_M73"],
  }));
  ingestFact(db, reg("athlete_eligibility", "A-MA", "2026-01-05T09:00:00+08:00", {
    display_ref: "选手M", gender: "male", eligibility: "eligible", eligible_for: ["WL_M73", "WL_M89"],
  }));
  ingestFact(db, reg("athlete_eligibility", "A-FAN", "2026-01-05T09:00:00+08:00", {
    display_ref: "选手F", gender: "male", eligibility: "eligible", eligible_for: ["TT_MS", "TT_XD", "TT_MD"],
  }));
  ingestFact(db, reg("athlete_eligibility", "A-CHEN", "2026-01-05T09:00:00+08:00", {
    display_ref: "选手C", gender: "female", eligibility: "eligible", eligible_for: ["TT_XD", "TT_WS"],
  }));
  ingestFact(db, reg("athlete_eligibility", "A-XU", "2026-01-05T09:00:00+08:00", {
    display_ref: "选手X", gender: "male", eligibility: "eligible", eligible_for: ["TT_MS"],
  }));
  ingestFact(db, reg("athlete_eligibility", "A-LIU", "2026-01-05T09:00:00+08:00", {
    display_ref: "选手L", gender: "male", eligibility: "eligible", eligible_for: ["WL_M73"],
  }));

  // --- 规则版本（旧级别 v2024 → 洛杉矶周期新级别 v2028） ---
  ingestFact(db, reg("discipline_rule", "RULE-WL", "2024-01-01T00:00:00+08:00", {
    rule_id: "RULE-WL", version: "2024", discipline: "weightlifting",
    effective_from: "2024-01-01T00:00:00+08:00",
    body: { event_codes: ["WL_M77", "WL_M85"], consecutive: { min_gap_days: 3, load_window_days: 7, load_avg_threshold: 80 } },
  }));
  ingestFact(db, reg("discipline_rule", "RULE-WL", "2026-01-01T00:00:00+08:00", {
    rule_id: "RULE-WL", version: "2028", discipline: "weightlifting",
    effective_from: "2026-01-01T00:00:00+08:00",
    body: { event_codes: ["WL_M73", "WL_M89"], consecutive: { min_gap_days: 3, load_window_days: 7, load_avg_threshold: 80 } },
  }));
  ingestFact(db, reg("discipline_rule", "RULE-TT", "2026-01-01T00:00:00+08:00", {
    rule_id: "RULE-TT", version: "2028", discipline: "table_tennis",
    effective_from: "2026-01-01T00:00:00+08:00",
    body: {
      event_codes: ["TT_MS", "TT_WS", "TT_XD", "TT_MD"],
      max_events_per_athlete: 3,
      pair_composition: { TT_XD: { size: 2, genders: ["female", "male"] } },
    },
  }));

  // --- 新配对（混双） ---
  ingestFact(db, reg("pairing", "PAIR-XD-1", "2026-06-01T10:00:00+08:00", {
    pairing_id: "PAIR-XD-1", discipline: "table_tennis", event_code: "TT_XD",
    members: ["A-FAN", "A-CHEN"], action: "formed", is_new: true,
    at: "2026-06-01T10:00:00+08:00",
  }));

  // --- 比赛与场次 ---
  ingestFact(db, cal("competition", "W2026", "2026-08-20T09:00:00+08:00", {
    competition_id: "W2026", name: "2026 世锦赛", category: "worlds",
    starts_at: "2026-09-10T09:00:00+08:00", ends_at: "2026-09-18T18:00:00+08:00",
  }));
  ingestFact(db, cal("competition", "G2026", "2026-08-20T09:05:00+08:00", {
    competition_id: "G2026", name: "2026 亚运会", category: "games",
    starts_at: "2026-09-20T09:00:00+08:00", ends_at: "2026-10-04T18:00:00+08:00",
  }));
  ingestFact(db, cal("competition_event", "G2026", "2026-08-20T10:00:00+08:00", {
    competition_id: "G2026", event_code: "TT_MS", discipline: "table_tennis", event_label: "男单",
    session_starts_at: "2026-09-25T10:00:00+08:00", session_ends_at: "2026-09-25T13:00:00+08:00",
  }));
  ingestFact(db, cal("competition_event", "G2026", "2026-08-20T10:01:00+08:00", {
    competition_id: "G2026", event_code: "TT_MD", discipline: "table_tennis", event_label: "男双",
    session_starts_at: "2026-09-25T11:00:00+08:00", session_ends_at: "2026-09-25T12:00:00+08:00",
  }));
  ingestFact(db, cal("competition_event", "G2026", "2026-08-20T10:02:00+08:00", {
    competition_id: "G2026", event_code: "TT_XD", discipline: "table_tennis", event_label: "混双",
    session_starts_at: "2026-09-27T14:00:00+08:00", session_ends_at: "2026-09-27T17:00:00+08:00",
  }));
  ingestFact(db, cal("competition_event", "G2026", "2026-08-20T10:03:00+08:00", {
    competition_id: "G2026", event_code: "WL_M73", discipline: "weightlifting", event_label: "男子73公斤级",
    session_starts_at: "2026-09-23T14:00:00+08:00", session_ends_at: "2026-09-23T17:00:00+08:00",
  }));

  // --- 伤病可用性：A-WEI 亚运窗口伤停 ---
  ingestFact(db, med("availability", "A-WEI", "2026-09-18T08:00:00+08:00", {
    window_start: "2026-09-18T08:00:00+08:00", window_end: null,
    status: "injured", note_ref: "med://note/wei-2026-09",
  }));

  // --- 负荷：A-FAN 连续作战且高负荷 ---
  for (const [d, v] of [["2026-09-14", 85], ["2026-09-16", 88], ["2026-09-18", 90]]) {
    ingestFact(db, perf("load", "A-FAN", `${d}T08:00:00+08:00`, {
      metric_date: `${d}T08:00:00+08:00`, load_value: v, unit: "a.u.",
    }));
  }

  // --- 资格席位（WL_M73 只剩 1 个名额；TT_XD 1 个） ---
  ingestFact(db, cal("quota_slot", "SLOT-WL-M73-1", "2026-09-01T09:00:00+08:00", {
    slot_id: "SLOT-WL-M73-1", discipline: "weightlifting", event_code: "WL_M73",
    competition_id: "G2026", max_entries: 2, entries_used: 1,
    qualification_path: "quota_event", status: "contested", basis_ref: "BASIS-WL-1",
  }));
  ingestFact(db, cal("quota_slot", "SLOT-TT-XD-1", "2026-09-01T09:00:00+08:00", {
    slot_id: "SLOT-TT-XD-1", discipline: "table_tennis", event_code: "TT_XD",
    competition_id: "G2026", max_entries: 1, entries_used: 0,
    qualification_path: "direct", status: "secured",
  }));
  ingestFact(db, cal("quota_slot", "SLOT-TT-MS-1", "2026-09-01T09:00:00+08:00", {
    slot_id: "SLOT-TT-MS-1", discipline: "table_tennis", event_code: "TT_MS",
    competition_id: "G2026", max_entries: 2, entries_used: 0,
    qualification_path: "ranking", status: "open",
  }));

  // --- 选拔依据 ---
  ingestFact(db, cal("selection_basis", "BASIS-FAN-1", "2026-09-05T09:00:00+08:00", {
    basis_id: "BASIS-FAN-1", competition_id: "G2026", event_code: "TT_MS",
    rationale: "近三站国际赛积分第一，兼项混双为洛杉矶周期试配",
    evidence_refs: [{ ref: "doc://ranking/fan", sha256: "0".repeat(64) }],
    as_of: "2026-09-05T09:00:00+08:00",
  }));

  // --- 世锦赛结果：A-FAN 连续作战的事实来源 ---
  const worldsResult = envelope("RESULTS")("competition_result", "A-FAN", "2026-09-15T20:00:00+08:00", {
    competition_id: "W2026", event_code: "TT_MS", entry_kind: "individual",
    members: ["A-FAN"], medal_rank: 1,
  });
  const worldsIngest = ingestFact(db, worldsResult);
  deriveEffects(db, { factId: worldsIngest.id });

  return { db, worldsResult, worldsFactId: worldsIngest.id };
}
