import { replayFacts } from "./facts.js";

// ---------------------------------------------------------------------------
// 赛事结果效果：区分 medal / olympic_qualification / training_validation。
// 结果事实 competition_result 可同时携带多类效果，这里确定性派生、按事实幂等。
// 新配对共同参赛单独积累在 partnership_participation，不并入个人台账。
// ---------------------------------------------------------------------------

function nowIso() {
  return new Date().toISOString();
}

function effectId(factId, type) {
  return `EFF_${factId}_${type}`;
}

export function deriveEffects(db, { factId } = {}) {
  const model = replayFacts(db);
  const pending = model.results.filter((r) => (factId == null ? true : r.fact_id === factId));
  if (factId != null && pending.length === 0) {
    const err = new Error(`结果事实 ${factId} 不存在`);
    err.status = 404;
    err.code = "NOT_FOUND";
    throw err;
  }

  const created = [];
  const insertEffect = db.prepare(
    `INSERT INTO effects(effect_id, competition_id, event_code, subject_ref, entry_kind, effect_type, medal_rank, quota_outcome, validation, recorded_at, source_fact_id)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`
  );
  const upsertPartnership = db.prepare(
    `INSERT INTO partnership_participation(pairing_id, competition_id, event_code, together_from, appearances, medals, last_result)
     VALUES(?,?,?,?,1,?,?)
     ON CONFLICT(pairing_id, competition_id, event_code) DO UPDATE SET
       medals = excluded.medals,
       last_result = excluded.last_result`
  );

  const tx = db.transaction(() => {
    for (const r of pending) {
      const subjectRef = r.entry_kind === "pair" && r.pairing_id ? r.pairing_id : r.members[0];
      const rows = [];
      if (r.medal_rank != null) rows.push(["medal", r.medal_rank, null, null]);
      if (r.quota_outcome != null) rows.push(["olympic_qualification", null, r.quota_outcome, null]);
      if (r.validation != null) rows.push(["training_validation", null, null, JSON.stringify(r.validation)]);
      if (rows.length === 0) rows.push(["training_validation", null, null, JSON.stringify({ note: "完赛记录（无显性结论，按阶段性验证留痕）" })]);

      for (const [type, medalRank, quota, validation] of rows) {
        const id = effectId(r.fact_id, type);
        const exists = db.prepare("SELECT 1 FROM effects WHERE effect_id=?").get(id);
        if (exists) continue;
        insertEffect.run(
          id,
          r.competition_id,
          r.event_code,
          subjectRef,
          r.entry_kind,
          type,
          medalRank,
          quota,
          validation,
          nowIso(),
          r.fact_id
        );
        created.push(id);
      }

      // 共同参赛台账：按"同组合+同赛事同小项"只算一次共同出场
      if (r.entry_kind === "pair" && r.pairing_id) {
        const pairing = model.pairings.get(r.pairing_id);
        const medals = r.medal_rank != null ? 1 : 0;
        upsertPartnership.run(
          r.pairing_id,
          r.competition_id,
          r.event_code,
          pairing?.formed_at ?? null,
          medals,
          JSON.stringify({ medal_rank: r.medal_rank, quota_outcome: r.quota_outcome, at: r.result_occurred_at })
        );
      }
    }
  });
  tx();
  return { derived: created.length, effect_ids: created };
}

export function listEffects(db, { competition_id, event_code, subject_ref, effect_type } = {}) {
  const where = [];
  const args = [];
  if (competition_id) { where.push("competition_id = ?"); args.push(competition_id); }
  if (event_code) { where.push("event_code = ?"); args.push(event_code); }
  if (subject_ref) { where.push("subject_ref = ?"); args.push(subject_ref); }
  if (effect_type) { where.push("effect_type = ?"); args.push(effect_type); }
  const sql = "SELECT * FROM effects" + (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY recorded_at, effect_id";
  return db.prepare(sql).all(...args).map((e) => ({ ...e, validation: e.validation ? JSON.parse(e.validation) : null }));
}

// 配对共同参赛台账：从首场共同参赛开始单独积累
export function getPartnershipLedger(db, pairingId) {
  const rows = db
    .prepare("SELECT * FROM partnership_participation WHERE pairing_id=? ORDER BY id")
    .all(pairingId);
  if (rows.length === 0) return null;
  const model = replayFacts(db);
  return {
    pairing_id: pairingId,
    members: model.pairings.get(pairingId)?.members ?? [],
    is_new: model.pairings.get(pairingId)?.is_new === 1 || model.pairings.get(pairingId)?.is_new === true,
    together_from: rows[0].together_from,
    total_appearances: rows.reduce((s, r) => s + r.appearances, 0),
    total_medals: rows.reduce((s, r) => s + r.medals, 0),
    appearances: rows.map((r) => ({ ...r, last_result: r.last_result ? JSON.parse(r.last_result) : null })),
  };
}

// 效果汇总：三类效果分别计数，避免把训练验证混同于奖牌/资格
export function effectSummary(db, { competition_id } = {}) {
  const rows = listEffects(db, competition_id ? { competition_id } : {});
  const summary = {
    medal: { gold: 0, silver: 0, bronze: 0 },
    olympic_qualification: { secured: 0, pending: 0, not_achieved: 0 },
    training_validation: 0,
  };
  for (const e of rows) {
    if (e.effect_type === "medal") {
      summary.medal[{ 1: "gold", 2: "silver", 3: "bronze" }[e.medal_rank]]++;
    } else if (e.effect_type === "olympic_qualification" && e.quota_outcome) {
      summary.olympic_qualification[e.quota_outcome]++;
    } else if (e.effect_type === "training_validation") {
      summary.training_validation++;
    }
  }
  return { competition_id: competition_id ?? null, effects_total: rows.length, summary };
}
