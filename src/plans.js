import { replayFacts } from "./facts.js";
import { buildRulesSnapshot, validatePlan } from "./validation.js";

// ---------------------------------------------------------------------------
// 参赛方案服务：方案 -> 多版本修订（冻结事实位点+规则快照）-> 自动校验 -> 人工决定
// 决策只追加在 plan_decisions；任何修改不得回写 fact_events。
// ---------------------------------------------------------------------------

function httpError(status, code, message, details) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  err.details = details;
  return err;
}

function nowIso() {
  return new Date().toISOString();
}

function genId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function factPosition(db) {
  const row = db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM fact_events").get();
  return row.m;
}

export function createPlan(db, { competition_id, title, created_by, variant_of }) {
  if (!competition_id || !title || !created_by) {
    throw httpError(400, "VALIDATION", "competition_id、title、created_by 必填");
  }
  const planId = genId("PLAN");
  const tx = db.transaction(() => {
    db.prepare(
      "INSERT INTO entry_plans(plan_id, competition_id, title, status, current_revision, created_at) VALUES(?,?,?,?,0,?)"
    ).run(planId, competition_id, title, "draft", nowIso());
    if (variant_of) {
      db.prepare(
        "INSERT INTO plan_links(plan_id, relation, related_plan_id) VALUES(?, 'variant_of', ?)"
      ).run(planId, variant_of);
    }
    db.prepare("INSERT INTO audit_log(at, actor, action, target, detail) VALUES(?,?,?,?,?)").run(
      nowIso(),
      created_by,
      "plan.create",
      planId,
      JSON.stringify({ competition_id, title, variant_of: variant_of ?? null })
    );
  });
  tx();
  return getPlan(db, planId);
}

function normalizeEntries(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw httpError(400, "VALIDATION", "entries 必须是非空数组");
  }
  return raw.map((e, i) => {
    if (!e || typeof e.subject_ref !== "string" || typeof e.event_code !== "string" || typeof e.discipline !== "string") {
      throw httpError(400, "VALIDATION", `entries[${i}] 缺 subject_ref/discipline/event_code`);
    }
    const kind = e.entry_kind === "pair" ? "pair" : "individual";
    const role = e.role === "alternate" ? "alternate" : "competitor";
    return { entry_seq: i + 1, subject_ref: e.subject_ref, entry_kind: kind, event_code: e.event_code, discipline: e.discipline, role };
  });
}

// 追加一个修订版本：冻结事实位点与规则版本，运行校验并固化 findings。
export function addRevision(db, planId, { entries, note, created_by, as_of }) {
  const plan = db.prepare("SELECT * FROM entry_plans WHERE plan_id = ?").get(planId);
  if (!plan) throw httpError(404, "NOT_FOUND", `方案 ${planId} 不存在`);
  if (plan.status === "decided") throw httpError(409, "PLAN_LOCKED", "方案已定稿，不能再追加修订");
  if (!created_by) throw httpError(400, "VALIDATION", "created_by 必填");
  const normalized = normalizeEntries(entries);
  const evalAt = as_of ?? nowIso();

  const position = factPosition(db);
  const model = replayFacts(db, { upToId: position, now: evalAt });
  const competition = model.competitions.get(plan.competition_id);
  if (!competition) {
    throw httpError(400, "VALIDATION", `比赛 ${plan.competition_id} 尚未登记，无法评估`);
  }
  const snapshot = buildRulesSnapshot(model, normalized, evalAt);
  const report = validatePlan(model, { competition, entries: normalized, rules_snapshot: snapshot, as_of: evalAt });

  const revision = plan.current_revision + 1;
  const tx = db.transaction(() => {
    db.prepare(
      "INSERT INTO plan_revisions(plan_id, revision, created_at, created_by, note, fact_position, rules_snapshot) VALUES(?,?,?,?,?,?,?)"
    ).run(planId, revision, nowIso(), created_by, note ?? null, position, JSON.stringify(snapshot));
    const insEntry = db.prepare(
      "INSERT INTO plan_entries(plan_id, revision, entry_seq, subject_ref, entry_kind, event_code, discipline, role) VALUES(?,?,?,?,?,?,?,?)"
    );
    for (const e of normalized) {
      insEntry.run(planId, revision, e.entry_seq, e.subject_ref, e.entry_kind, e.event_code, e.discipline, e.role);
    }
    const insFinding = db.prepare(
      "INSERT INTO plan_findings(plan_id, revision, code, severity, subject_ref, event_code, message, detail) VALUES(?,?,?,?,?,?,?,?)"
    );
    for (const f of report.findings) {
      insFinding.run(planId, revision, f.code, f.severity, f.subject_ref, f.event_code, f.message, JSON.stringify(f.detail ?? {}));
    }
    db.prepare("UPDATE entry_plans SET current_revision = ? WHERE plan_id = ?").run(revision, planId);
    db.prepare("INSERT INTO audit_log(at, actor, action, target, detail) VALUES(?,?,?,?,?)").run(
      nowIso(),
      created_by,
      "plan.revision",
      planId,
      JSON.stringify({ revision, note: note ?? null, fact_position: position, summary: report.summary })
    );
  });
  tx();
  return { plan_id: planId, revision, fact_position: position, ...report };
}

function loadRevision(db, planId, revision) {
  const rev = db.prepare("SELECT * FROM plan_revisions WHERE plan_id=? AND revision=?").get(planId, revision);
  if (!rev) return null;
  rev.rules_snapshot = JSON.parse(rev.rules_snapshot);
  rev.entries = db.prepare("SELECT * FROM plan_entries WHERE plan_id=? AND revision=? ORDER BY entry_seq").all(planId, revision);
  rev.findings = db.prepare("SELECT * FROM plan_findings WHERE plan_id=? AND revision=? ORDER BY id").all(planId, revision).map((f) => ({
    ...f, detail: JSON.parse(f.detail),
  }));
  rev.decisions = db.prepare("SELECT * FROM plan_decisions WHERE plan_id=? AND revision=? ORDER BY id").all(planId, revision);
  const overridden = new Set(
    rev.decisions.filter((d) => d.action === "override").map((d) => d.finding_id)
  );
  rev.outstanding_blocks = rev.findings.filter((f) => f.severity === "block" && !overridden.has(f.id));
  rev.summary = {
    block_count: rev.findings.filter((f) => f.severity === "block").length,
    warn_count: rev.findings.filter((f) => f.severity === "warn").length,
    overridden_count: overridden.size,
    outstanding_block_count: rev.outstanding_blocks.length,
    pass: rev.outstanding_blocks.length === 0,
  };
  return rev;
}

const DECISION_ACTIONS = new Set(["submit", "replace", "withdraw", "override", "approve"]);

// 追加人工决定。reason 强制非空；override 必须指向具体 block finding。
export function addDecision(db, planId, body) {
  const plan = db.prepare("SELECT * FROM entry_plans WHERE plan_id = ?").get(planId);
  if (!plan) throw httpError(404, "NOT_FOUND", `方案 ${planId} 不存在`);
  const action = body?.action;
  if (!DECISION_ACTIONS.has(action)) throw httpError(400, "VALIDATION", `action 须为 ${[...DECISION_ACTIONS].join("/")}`);
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!reason) throw httpError(422, "REASON_REQUIRED", "人工决定必须记录理由（reason 不能为空）");
  const decidedBy = body.decided_by;
  if (!decidedBy) throw httpError(400, "VALIDATION", "decided_by 必填");
  const revision = Number.isInteger(body.revision) ? body.revision : plan.current_revision;
  const rev = loadRevision(db, planId, revision);
  if (!rev) throw httpError(404, "NOT_FOUND", `修订版本 ${revision} 不存在`);

  let findingId = null;
  if (action === "override") {
    findingId = body.finding_id;
    const target = rev.findings.find((f) => f.id === findingId);
    if (!target) throw httpError(404, "NOT_FOUND", `finding ${findingId} 不存在于该版本`);
    if (target.severity !== "block") throw httpError(422, "INVALID_OVERRIDE", "只能对 block 级问题作豁免决定");
    if (rev.decisions.some((d) => d.action === "override" && d.finding_id === findingId)) {
      throw httpError(409, "ALREADY_OVERRIDDEN", "该问题已有豁免决定");
    }
  }
  if (action === "replace" && !Number.isInteger(body.replaced_entry_seq)) {
    throw httpError(422, "VALIDATION", "replace 决定必须给出 replaced_entry_seq");
  }
  if (action === "submit" && rev.outstanding_blocks.length > 0) {
    throw httpError(409, "OUTSTANDING_BLOCKS", "仍有未豁免的阻断性问题，不能报送", {
      outstanding: rev.outstanding_blocks.map((f) => ({ id: f.id, code: f.code, message: f.message })),
    });
  }

  const at = nowIso();
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO plan_decisions(plan_id, revision, action, subject_ref, event_code, reason, decided_by, decided_at, replaced_entry_seq, finding_id)
       VALUES(?,?,?,?,?,?,?,?,?,?)`
    ).run(
      planId,
      revision,
      action,
      body.subject_ref ?? null,
      body.event_code ?? null,
      reason,
      decidedBy,
      at,
      body.replaced_entry_seq ?? null,
      findingId
    );
    if (action === "approve") {
      db.prepare("UPDATE entry_plans SET status='decided' WHERE plan_id=?").run(planId);
    }
    db.prepare("INSERT INTO audit_log(at, actor, action, target, detail) VALUES(?,?,?,?,?)").run(
      at,
      decidedBy,
      `plan.decision.${action}`,
      planId,
      JSON.stringify({ revision, subject_ref: body.subject_ref ?? null, event_code: body.event_code ?? null, reason })
    );
  });
  tx();
  return getPlan(db, planId);
}

export function getPlan(db, planId) {
  const plan = db.prepare("SELECT * FROM entry_plans WHERE plan_id=?").get(planId);
  if (!plan) throw httpError(404, "NOT_FOUND", `方案 ${planId} 不存在`);
  const revisions = [];
  for (let r = 1; r <= plan.current_revision; r++) revisions.push(loadRevision(db, planId, r));
  return {
    ...plan,
    links: db.prepare("SELECT relation, related_plan_id FROM plan_links WHERE plan_id=?").all(planId),
    revisions,
  };
}

export function listPlans(db, { competition_id } = {}) {
  const rows = competition_id
    ? db.prepare("SELECT * FROM entry_plans WHERE competition_id=? ORDER BY created_at").all(competition_id)
    : db.prepare("SELECT * FROM entry_plans ORDER BY created_at").all();
  return rows.map((p) => {
    const latest = p.current_revision > 0 ? loadRevision(db, p.plan_id, p.current_revision) : null;
    return {
      plan_id: p.plan_id,
      competition_id: p.competition_id,
      title: p.title,
      status: p.status,
      current_revision: p.current_revision,
      created_at: p.created_at,
      latest_summary: latest ? latest.summary : null,
    };
  });
}

// 按项目（比赛/项群）对比不同方案的取舍
export function comparePlans(db, competitionId) {
  const plans = listPlans(db, { competition_id: competitionId });
  const full = plans.map((p) => getPlan(db, p.plan_id));
  const byDiscipline = new Map();
  for (const plan of full) {
    const latest = plan.revisions[plan.revisions.length - 1];
    if (!latest) continue;
    const disciplines = new Set(latest.entries.map((e) => e.discipline));
    for (const discipline of disciplines) {
      const entries = latest.entries.filter((e) => e.discipline === discipline);
      const findings = latest.findings.filter((f) =>
        entries.some((e) => e.subject_ref === f.subject_ref || e.event_code === f.event_code)
      );
      const bucket = byDiscipline.get(discipline) ?? [];
      bucket.push({
        plan_id: plan.plan_id,
        title: plan.title,
        status: plan.status,
        revision: latest.revision,
        entries: entries.map((e) => ({
          subject_ref: e.subject_ref,
          entry_kind: e.entry_kind,
          event_code: e.event_code,
          role: e.role,
        })),
        entries_count: entries.length,
        competitors_count: entries.filter((e) => e.role === "competitor").length,
        findings: {
          block: findings.filter((f) => f.severity === "block").map((f) => ({ code: f.code, message: f.message, subject_ref: f.subject_ref })),
          warn: findings.filter((f) => f.severity === "warn").map((f) => ({ code: f.code, message: f.message, subject_ref: f.subject_ref })),
        },
        overrides: latest.decisions.filter((d) => d.action === "override" && d.reason).length,
        rules_versions: [...new Set(entries.map((e) => latest.rules_snapshot[`${e.discipline}|${e.event_code}`]?.version).filter(Boolean))],
      });
      byDiscipline.set(discipline, bucket);
    }
  }
  return { competition_id: competitionId, by_discipline: Object.fromEntries(byDiscipline) };
}
