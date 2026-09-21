import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// 事实类型与载荷契约
// 所有事实只追加登记；更正通过"后发生的新事实"体现，不修改既有记录。
// ---------------------------------------------------------------------------

export const FACT_TYPES = {
  athlete_eligibility: "运动员资格",
  discipline_rule: "项目规则版本",
  pairing: "组合关系",
  availability: "伤病可用性",
  competition: "比赛",
  competition_event: "比赛场次",
  load: "训练/比赛负荷",
  quota_slot: "资格席位",
  selection_basis: "选拔依据",
  competition_result: "比赛结果",
};

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function fail(message, field) {
  const error = new Error(message);
  error.code = "VALIDATION";
  error.field = field;
  return error;
}

function requireString(obj, key, where) {
  if (typeof obj[key] !== "string" || obj[key].trim() === "") {
    throw fail(`${where}缺少文本字段 ${key}`, key);
  }
  return obj[key];
}

function requireIso(obj, key, where) {
  const v = requireString(obj, key, where);
  if (!ISO.test(v) || Number.isNaN(Date.parse(v))) {
    throw fail(`${where}.${key} 必须是带偏移量的 ISO 8601 时间`, key);
  }
  return v;
}

function optionalIso(obj, key, where) {
  if (obj[key] == null) return null;
  return requireIso(obj, key, where);
}

function requireArray(obj, key, where, min = 1) {
  if (!Array.isArray(obj[key]) || obj[key].length < min) {
    throw fail(`${where}.${key} 必须是长度>=${min}的数组`, key);
  }
  return obj[key];
}

function isPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

// 每类事实的载荷校验。subject_ref 在外层信封，载荷内用各自自然键。
function validatePayload(factType, payload) {
  if (!isPlainObject(payload)) throw fail("payload 必须是对象", "payload");
  const where = `payload(${factType})`;
  switch (factType) {
    case "athlete_eligibility": {
      requireString(payload, "display_ref", where);
      const eligibility = requireString(payload, "eligibility", where);
      if (!["eligible", "suspended", "retired"].includes(eligibility)) {
        throw fail("eligibility 取值非法", "eligibility");
      }
      const eligibleFor = requireArray(payload, "eligible_for", where, 0).map(
        (x) => requireString({ x }, "x", where)
      );
      return {
        display_ref: payload.display_ref,
        gender: typeof payload.gender === "string" ? payload.gender : null,
        eligibility,
        eligible_for: eligibleFor,
      };
    }
    case "discipline_rule": {
      requireString(payload, "rule_id", where);
      requireString(payload, "version", where);
      requireString(payload, "discipline", where);
      requireIso(payload, "effective_from", where);
      if (!isPlainObject(payload.body)) throw fail("body 必须是规则对象", "body");
      return {
        rule_id: payload.rule_id,
        version: payload.version,
        discipline: payload.discipline,
        event_code: payload.event_code ?? null,
        effective_from: payload.effective_from,
        body: payload.body,
      };
    }
    case "pairing": {
      requireString(payload, "pairing_id", where);
      requireString(payload, "discipline", where);
      requireString(payload, "event_code", where);
      const members = requireArray(payload, "members", where, 2);
      members.forEach((m) => requireString({ m }, "m", where));
      const action = payload.action ?? "formed";
      if (!["formed", "dissolved", "reformed"].includes(action)) {
        throw fail("pairing.action 非法", "action");
      }
      return {
        pairing_id: payload.pairing_id,
        discipline: payload.discipline,
        event_code: payload.event_code,
        members,
        action,
        predecessor: payload.predecessor ?? null,
        is_new: payload.is_new === true ? 1 : 0,
        at: optionalIso(payload, "at", where),
      };
    }
    case "availability": {
      requireIso(payload, "window_start", where);
      return {
        window_start: payload.window_start,
        window_end: payload.window_end ?? null,
        status: (() => {
          const s = requireString(payload, "status", where);
          if (!["available", "injured", "restricted"].includes(s)) {
            throw fail("availability.status 非法", "status");
          }
          return s;
        })(),
        note_ref: payload.note_ref ?? null,
      };
    }
    case "competition": {
      requireString(payload, "competition_id", where);
      requireString(payload, "name", where);
      const category = requireString(payload, "category", where);
      if (!["games", "worlds", "qualifier", "training_verification"].includes(category)) {
        throw fail("competition.category 非法", "category");
      }
      const starts = requireIso(payload, "starts_at", where);
      const ends = requireIso(payload, "ends_at", where);
      return {
        competition_id: payload.competition_id,
        name: payload.name,
        category,
        starts_at: starts,
        ends_at: ends,
      };
    }
    case "competition_event": {
      requireString(payload, "competition_id", where);
      requireString(payload, "event_code", where);
      requireString(payload, "discipline", where);
      requireString(payload, "event_label", where);
      const s = requireIso(payload, "session_starts_at", where);
      const e = requireIso(payload, "session_ends_at", where);
      return {
        competition_id: payload.competition_id,
        event_code: payload.event_code,
        discipline: payload.discipline,
        event_label: payload.event_label,
        session_starts_at: s,
        session_ends_at: e,
      };
    }
    case "load": {
      requireIso(payload, "metric_date", where);
      if (typeof payload.load_value !== "number" || Number.isNaN(payload.load_value)) {
        throw fail("load_value 必须是数值", "load_value");
      }
      return {
        metric_date: payload.metric_date,
        load_value: payload.load_value,
        unit: typeof payload.unit === "string" ? payload.unit : "a.u.",
      };
    }
    case "quota_slot": {
      requireString(payload, "slot_id", where);
      requireString(payload, "discipline", where);
      requireString(payload, "event_code", where);
      const max = payload.max_entries;
      if (!Number.isInteger(max) || max < 0) throw fail("max_entries 须为非负整数", "max_entries");
      const path = requireString(payload, "qualification_path", where);
      if (!["direct", "quota_event", "ranking", "wildcard"].includes(path)) {
        throw fail("qualification_path 非法", "qualification_path");
      }
      const status = requireString(payload, "status", where);
      if (!["open", "secured", "contested"].includes(status)) {
        throw fail("quota status 非法", "status");
      }
      return {
        slot_id: payload.slot_id,
        discipline: payload.discipline,
        event_code: payload.event_code,
        competition_id: payload.competition_id ?? null,
        max_entries: max,
        entries_used: Number.isInteger(payload.entries_used) ? payload.entries_used : 0,
        qualification_path: path,
        status,
        basis_ref: payload.basis_ref ?? null,
      };
    }
    case "selection_basis": {
      requireString(payload, "basis_id", where);
      requireString(payload, "rationale", where);
      requireIso(payload, "as_of", where);
      const refs = requireArray(payload, "evidence_refs", where, 0);
      refs.forEach((r) => {
        if (!isPlainObject(r) || typeof r.ref !== "string" || typeof r.sha256 !== "string") {
          throw fail("evidence_refs 元素需含 ref 与 sha256", "evidence_refs");
        }
      });
      return {
        basis_id: payload.basis_id,
        competition_id: payload.competition_id ?? null,
        event_code: payload.event_code ?? null,
        rationale: payload.rationale,
        evidence_refs: refs,
        as_of: payload.as_of,
      };
    }
    case "competition_result": {
      requireString(payload, "competition_id", where);
      requireString(payload, "event_code", where);
      const kind = requireString(payload, "entry_kind", where);
      if (!["individual", "pair"].includes(kind)) throw fail("entry_kind 非法", "entry_kind");
      const members = requireArray(payload, "members", where, 1).map((m) =>
        requireString({ m }, "m", where)
      );
      const out = {
        competition_id: payload.competition_id,
        event_code: payload.event_code,
        entry_kind: kind,
        members,
        pairing_id: payload.pairing_id ?? null,
        medal_rank: null,
        quota_outcome: null,
        validation: null,
        metrics: {},
      };
      if (payload.medal_rank != null) {
        if (![1, 2, 3].includes(payload.medal_rank)) throw fail("medal_rank 仅 1/2/3", "medal_rank");
        out.medal_rank = payload.medal_rank;
      }
      if (payload.quota_outcome != null) {
        if (!["secured", "pending", "not_achieved"].includes(payload.quota_outcome)) {
          throw fail("quota_outcome 非法", "quota_outcome");
        }
        out.quota_outcome = payload.quota_outcome;
      }
      if (payload.validation != null) {
        if (!isPlainObject(payload.validation)) throw fail("validation 须为对象", "validation");
        out.validation = payload.validation;
      }
      if (isPlainObject(payload.metrics)) out.metrics = payload.metrics;
      return out;
    }
    default:
      throw fail(`未知事实类型：${factType}`, "fact_type");
  }
}

// 稳定规范化 JSON（键排序），用于摘要
export function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function digestPayload(payload) {
  return "sha256:" + crypto.createHash("sha256").update(canonicalize(payload)).digest("hex");
}

export function validateEnvelope(envelope) {
  if (!isPlainObject(envelope)) throw fail("事件必须是对象", "envelope");
  const eventId = requireString(envelope, "event_id", "事件");
  const subjectRef = requireString(envelope, "subject_ref", "事件");
  const factType = requireString(envelope, "fact_type", "事件");
  if (!FACT_TYPES[factType]) throw fail(`未知事实类型：${factType}`, "fact_type");
  const occurredAt = requireIso(envelope, "occurred_at", "事件");
  const source = requireString(envelope, "source", "事件");
  const seq = envelope.source_sequence;
  if (!Number.isInteger(seq) || seq < 1) throw fail("source_sequence 须为>=1整数", "source_sequence");
  const payload = validatePayload(factType, envelope.payload ?? {});
  const computed = digestPayload(payload);
  const supplied = envelope.payload_digest;
  if (typeof supplied === "string" && /^sha256:[0-9a-f]{64}$/.test(supplied) && supplied !== computed) {
    throw fail("payload_digest 与载荷摘要不一致（材料可能被改动）", "payload_digest");
  }
  return {
    event_id: eventId,
    subject_ref: subjectRef,
    fact_type: factType,
    occurred_at: occurredAt,
    source,
    source_sequence: seq,
    payload,
    payload_digest: computed,
  };
}

// ---------------------------------------------------------------------------
// 登记：只追加 + 幂等
// ---------------------------------------------------------------------------

export function ingestFact(db, raw) {
  const e = validateEnvelope(raw);
  const existing = db
    .prepare("SELECT id, payload_digest FROM fact_events WHERE event_id = ?")
    .get(e.event_id);
  if (existing) {
    if (existing.payload_digest !== e.payload_digest) {
      const err = new Error(`事件 ${e.event_id} 已存在且摘要不同，原始登记不可篡改`);
      err.code = "CONFLICT";
      throw err;
    }
    return { id: existing.id, duplicated: true, payload_digest: existing.payload_digest };
  }
  const ingestedAt = new Date().toISOString();
  let info;
  try {
    info = db
      .prepare(
        `INSERT INTO fact_events
          (event_id, subject_ref, fact_type, occurred_at, ingested_at, source, source_sequence, payload_digest, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        e.event_id,
        e.subject_ref,
        e.fact_type,
        e.occurred_at,
        ingestedAt,
        e.source,
        e.source_sequence,
        e.payload_digest,
        JSON.stringify(e.payload)
      );
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) {
      const wrapped = new Error(
        `来源 ${e.source} 的序号 ${e.source_sequence} 已被占用（同来源序号须递增唯一）`
      );
      wrapped.code = "CONFLICT";
      throw wrapped;
    }
    throw err;
  }
  return { id: Number(info.lastInsertRowid), duplicated: false, payload_digest: e.payload_digest };
}

// ---------------------------------------------------------------------------
// 回放：把事实流归约成内存模型。upToId 用于按历史位点冻结解释。
// ---------------------------------------------------------------------------

export function replayFacts(db, { upToId = null, now = null } = {}) {
  const model = {
    upToId,
    asOf: now,
    athletes: new Map(), // subject_ref -> {...}
    rules: [], // {rule_id,version,discipline,event_code,effective_from,body}
    pairings: new Map(), // pairing_id -> 最新状态
    competitions: new Map(),
    competitionEvents: new Map(), // comp|event -> {...}
    availability: new Map(), // subject -> [windows]
    loads: new Map(), // subject -> [{date,value,unit}]
    quotas: new Map(), // slot_id -> latest
    selectionBasis: new Map(),
    results: [],
    facts: [],
  };

  const sql =
    "SELECT * FROM fact_events" +
    (upToId != null ? " WHERE id <= ?" : "") +
    " ORDER BY occurred_at ASC, id ASC";
  const rows = upToId != null ? db.prepare(sql).all(upToId) : db.prepare(sql).all();

  for (const row of rows) {
    const p = JSON.parse(row.payload);
    model.facts.push({ id: row.id, fact_type: row.fact_type, subject_ref: row.subject_ref, occurred_at: row.occurred_at });
    switch (row.fact_type) {
      case "athlete_eligibility":
        model.athletes.set(row.subject_ref, {
          subject_ref: row.subject_ref,
          display_ref: p.display_ref,
          gender: p.gender,
          eligibility: p.eligibility,
          eligible_for: p.eligible_for,
          updated_at: row.occurred_at,
        });
        break;
      case "discipline_rule":
        model.rules.push({
          rule_id: p.rule_id,
          version: p.version,
          discipline: p.discipline,
          event_code: p.event_code,
          effective_from: p.effective_from,
          body: p.body,
        });
        break;
      case "pairing": {
        const prev = model.pairings.get(p.pairing_id) ?? {
          pairing_id: p.pairing_id,
          discipline: p.discipline,
          event_code: p.event_code,
          members: p.members,
          formed_at: p.at ?? row.occurred_at,
          dissolved_at: null,
          predecessor: p.predecessor,
          is_new: p.is_new,
        };
        if (p.action === "dissolved") {
          prev.dissolved_at = p.at ?? row.occurred_at;
        } else {
          prev.members = p.members;
          prev.discipline = p.discipline;
          prev.event_code = p.event_code;
          if (p.action === "reformed") prev.dissolved_at = null;
          prev.is_new = p.is_new || prev.is_new;
        }
        model.pairings.set(p.pairing_id, prev);
        break;
      }
      case "availability": {
        const list = model.availability.get(row.subject_ref) ?? [];
        list.push({
          window_start: p.window_start,
          window_end: p.window_end,
          status: p.status,
          note_ref: p.note_ref,
        });
        model.availability.set(row.subject_ref, list);
        break;
      }
      case "competition":
        model.competitions.set(p.competition_id, { ...p, updated_at: row.occurred_at });
        break;
      case "competition_event":
        model.competitionEvents.set(`${p.competition_id}|${p.event_code}`, p);
        break;
      case "load": {
        const list = model.loads.get(row.subject_ref) ?? [];
        list.push({ metric_date: p.metric_date, load_value: p.load_value, unit: p.unit });
        model.loads.set(row.subject_ref, list);
        break;
      }
      case "quota_slot":
        model.quotas.set(p.slot_id, { ...p, updated_at: row.occurred_at });
        break;
      case "selection_basis":
        model.selectionBasis.set(p.basis_id, p);
        break;
      case "competition_result":
        model.results.push({ ...p, result_occurred_at: row.occurred_at, fact_id: row.id });
        break;
    }
  }
  return model;
}

// 规则时点解析：精确小项优先，退回整项通用；取 asOf 之前最近生效版本。
export function resolveRule(model, discipline, eventCode, asOf) {
  const candidates = model.rules
    .filter(
      (r) =>
        r.discipline === discipline &&
        Date.parse(r.effective_from) <= Date.parse(asOf) &&
        (r.event_code === eventCode || r.event_code == null)
    )
    .sort((a, b) => {
      const byTime = Date.parse(b.effective_from) - Date.parse(a.effective_from);
      if (byTime !== 0) return byTime;
      // 同一生效时间，小项专用优先
      return (a.event_code === eventCode ? 0 : 1) - (b.event_code === eventCode ? 0 : 1);
    });
  return candidates[0] ?? null;
}

// 某主体在某时刻的可用性：开放区间 window_end=null 视为持续有效
export function availabilityAt(model, subjectRef, at) {
  const windows = model.availability.get(subjectRef);
  if (!windows || windows.length === 0) return { status: "unknown", window: null };
  const t = Date.parse(at);
  const hit = windows
    .filter(
      (w) =>
        Date.parse(w.window_start) <= t &&
        (w.window_end == null || Date.parse(w.window_end) >= t)
    )
    .sort((a, b) => Date.parse(b.window_start) - Date.parse(a.window_start))[0];
  return hit ? { status: hit.status, window: hit } : { status: "unknown", window: null };
}
