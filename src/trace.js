import { replayFacts } from "./facts.js";

// ---------------------------------------------------------------------------
// 运动员全历程追溯：从一名运动员追溯其入选、替换、负荷变化全过程。
// 按 occurred_at / decided_at 合并事实流与决策流；配对相关成绩只做指引，
// 共同参赛明细在配对台账单独积累。
// ---------------------------------------------------------------------------

export function athleteTimeline(db, subjectRef) {
  const model = replayFacts(db);
  const athlete = model.athletes.get(subjectRef);
  if (!athlete) {
    const err = new Error(`运动员 ${subjectRef} 无资格登记`);
    err.status = 404;
    err.code = "NOT_FOUND";
    throw err;
  }

  const events = [];
  const push = (at, kind, title, detail = {}) => events.push({ at, kind, title, detail });

  // --- 事实层 ---
  const facts = db
    .prepare("SELECT * FROM fact_events WHERE subject_ref=? ORDER BY occurred_at, id")
    .all(subjectRef);
  for (const f of facts) {
    const p = JSON.parse(f.payload);
    if (f.fact_type === "athlete_eligibility") {
      push(f.occurred_at, "eligibility", `资格状态更新为 ${p.eligibility}`, {
        eligible_for: p.eligible_for, display_ref: p.display_ref,
      });
    } else if (f.fact_type === "availability") {
      push(f.occurred_at, "availability", `可用性：${p.status}（${p.window_start} 至 ${p.window_end ?? "开放"}）`, {
        status: p.status, window_start: p.window_start, window_end: p.window_end, note_ref: p.note_ref ?? null,
      });
    } else if (f.fact_type === "load") {
      push(f.occurred_at, "load", `负荷记录 ${p.load_value}${p.unit}`, {
        metric_date: p.metric_date, load_value: p.load_value, unit: p.unit,
      });
    } else if (f.fact_type === "selection_basis") {
      push(f.occurred_at, "selection_basis", `选拔依据登记：${p.basis_id}`, {
        basis_id: p.basis_id, rationale: p.rationale, event_code: p.event_code, as_of: p.as_of,
        evidence_count: p.evidence_refs.length,
      });
    }
  }

  // 负荷变化序列（带环比）
  const loads = (model.loads.get(subjectRef) ?? [])
    .slice()
    .sort((a, b) => Date.parse(a.metric_date) - Date.parse(b.metric_date));
  const loadSeries = loads.map((l, i) => ({
    metric_date: l.metric_date,
    load_value: l.load_value,
    unit: l.unit,
    delta_vs_previous: i === 0 ? null : Number((l.load_value - loads[i - 1].load_value).toFixed(2)),
  }));

  // 该运动员所属（含曾属）的组合
  const pairings = [...model.pairings.values()].filter((pa) => pa.members.includes(subjectRef));
  const pairingIds = new Set(pairings.map((p) => p.pairing_id));

  // --- 决策层：遍历所有方案的全部修订 ---
  const plans = db.prepare("SELECT * FROM entry_plans ORDER BY created_at").all();
  const planInvolvement = [];
  for (const plan of plans) {
    let previousKeys = null;
    const involvement = { plan_id: plan.plan_id, title: plan.title, competition_id: plan.competition_id, revisions: [] };
    let touched = false;
    for (let r = 1; r <= plan.current_revision; r++) {
      const entries = db
        .prepare("SELECT * FROM plan_entries WHERE plan_id=? AND revision=? ORDER BY entry_seq")
        .all(plan.plan_id, r);
      const mine = entries.filter(
        (e) => e.subject_ref === subjectRef || (e.entry_kind === "pair" && pairingIds.has(e.subject_ref))
      );
      const keys = new Set(mine.map((e) => `${e.subject_ref}|${e.event_code}|${e.role}`));
      if (mine.length > 0) touched = true;
      if (mine.length > 0 || previousKeys) {
        const added = previousKeys ? [...keys].filter((k) => !previousKeys.has(k)) : [...keys];
        const removed = previousKeys ? [...previousKeys].filter((k) => !keys.has(k)) : [];
        involvement.revisions.push({
          revision: r, included: mine, added: added.map(decodeKey), removed: removed.map(decodeKey),
        });
        const revRow = db.prepare("SELECT created_at, note FROM plan_revisions WHERE plan_id=? AND revision=?").get(plan.plan_id, r);
        if (added.length) push(revRow.created_at, "selection", `入选方案《${plan.title}》r${r}`, { plan_id: plan.plan_id, revision: r, added: added.map(decodeKey) });
        for (const k of removed) {
          push(revRow.created_at, "roster_change", `从方案《${plan.title}》r${r} 名单中移出`, {
            plan_id: plan.plan_id, revision: r, removed: decodeKey(k),
          });
        }
      }
      previousKeys = keys;

      const decisions = db
        .prepare("SELECT * FROM plan_decisions WHERE plan_id=? AND revision=? ORDER BY id")
        .all(plan.plan_id, r);
      for (const d of decisions) {
        const relatesToMe =
          d.subject_ref === subjectRef ||
          pairingIds.has(d.subject_ref) ||
          (d.replaced_entry_seq != null &&
            entries.some(
              (e) => e.entry_seq === d.replaced_entry_seq &&
                (e.subject_ref === subjectRef || (e.entry_kind === "pair" && pairingIds.has(e.subject_ref)))
            ));
        if (!relatesToMe) continue;
        let title;
        if (d.action === "replace") {
          const replaced = entries.find((e) => e.entry_seq === d.replaced_entry_seq);
          title = `替换：${replaced ? replaced.subject_ref + "(" + replaced.event_code + ")" : "条目#" + d.replaced_entry_seq} → ${d.subject_ref ?? "另行安排"}（${d.event_code ?? ""}）`;
        } else {
          const map = { submit: "确认报送", withdraw: "撤回", override: "阻断问题被人工豁免", approve: "方案定稿" };
          title = `${map[d.action] ?? d.action}（${d.event_code ?? ""}）`;
        }
        push(d.decided_at, `decision.${d.action}`, title, {
          plan_id: plan.plan_id, revision: r, reason: d.reason, decided_by: d.decided_by,
          event_code: d.event_code, replaced_entry_seq: d.replaced_entry_seq,
        });
      }
    }
    if (touched) planInvolvement.push(involvement);
  }

  events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  // 个人项目效果（配对成绩不并入，仅指引）
  const individualEffects = db
    .prepare("SELECT * FROM effects WHERE subject_ref=? ORDER BY recorded_at")
    .all(subjectRef)
    .map((e) => ({ ...e, validation: e.validation ? JSON.parse(e.validation) : null }));
  const pairEffectRefs = db
    .prepare("SELECT DISTINCT subject_ref, competition_id, event_code FROM effects WHERE entry_kind='pair'")
    .all()
    .filter((row) => pairingIds.has(row.subject_ref));

  return {
    subject_ref: subjectRef,
    display_ref: athlete.display_ref,
    current: {
      eligibility: athlete.eligibility,
      eligible_for: athlete.eligible_for,
      pairings: pairings.map((p) => ({ pairing_id: p.pairing_id, event_code: p.event_code, dissolved_at: p.dissolved_at, is_new: !!p.is_new })),
    },

    load_series: loadSeries,
    individual_effects: individualEffects,
    pair_effects_ref: pairEffectRefs.map((r) => ({
      pairing_id: r.subject_ref, competition_id: r.competition_id, event_code: r.event_code,
      ledger_hint: "配对共同参赛记录单独积累，请查 /pairings/:id/ledger",
    })),
    plan_involvement: planInvolvement,
    timeline: events,
  };
}

function decodeKey(k) {
  const [subject_ref, event_code, role] = k.split("|");
  return { subject_ref, event_code, role };
}
