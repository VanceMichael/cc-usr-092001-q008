/**
 * 领域事件目录与入站校验。
 *
 * 所有业务状态都由这些事件归约得到；事件载荷只登记"发生了什么"，
 * 不保存可由其他事件推导的结论，避免同一事实两处修改。
 *
 * 时间字段一律为带偏移量的 ISO 8601 字符串（与 docs/domain.md 一致）。
 */

export const EVENT_TYPES = Object.freeze({
  ATHLETE_REGISTERED: "athlete.registered",
  RULE_PUBLISHED: "sport_rule.published",
  PAIRING_FORMED: "pairing.formed",
  PAIRING_DISSOLVED: "pairing.dissolved",
  AVAILABILITY_DECLARED: "availability.declared",
  LOAD_RECORDED: "load.recorded",
  COMPETITION_SCHEDULED: "competition.scheduled",
  QUOTA_HELD: "quota.held",
  QUOTA_STATUS_CHANGED: "quota.status_changed",
  ROSTER_CREATED: "roster.created",
  ROSTER_ENTRY_ADDED: "roster.entry_added",
  ROSTER_ENTRY_REMOVED: "roster.entry_removed",
  ROSTER_SUBMITTED: "roster.submitted",
  SELECTION_BASIS_RECORDED: "selection_basis.recorded",
  DECISION_RECORDED: "decision.recorded",
  RESULT_RECORDED: "result.recorded",
});

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function isValidIso(value) {
  return typeof value === "string" && ISO.test(value) && !Number.isNaN(Date.parse(value));
}

function fail(errors, path, message) {
  errors.push(`${path}: ${message}`);
}

function requireString(payload, key, errors, path, { nonEmpty = true } = {}) {
  const value = payload[key];
  if (typeof value !== "string" || (nonEmpty && value.trim() === "")) {
    fail(errors, path, `缺少字段 ${key} 或不是非空字符串`);
    return;
  }
  return value;
}

function requireIso(payload, key, errors, path) {
  const value = payload[key];
  if (!isValidIso(value)) fail(errors, path, `字段 ${key} 必须是带偏移量的 ISO 8601 时间`);
  return value;
}

function requireNumber(payload, key, errors, path, { min = -Infinity, finite = true } = {}) {
  const value = payload[key];
  if (typeof value !== "number" || (finite && !Number.isFinite(value)) || value < min) {
    fail(errors, path, `字段 ${key} 必须是不小于 ${min} 的数值`);
    return;
  }
  return value;
}

function requireEnum(payload, key, allowed, errors, path) {
  const value = payload[key];
  if (!allowed.includes(value)) fail(errors, path, `字段 ${key} 必须取 ${allowed.join(" / ")}`);
  return value;
}

function requireArray(payload, key, errors, path, { minLength = 0 } = {}) {
  const value = payload[key];
  if (!Array.isArray(value) || value.length < minLength) {
    fail(errors, path, `字段 ${key} 必须是长度不小于 ${minLength} 的数组`);
    return [];
  }
  return value;
}

/** 按事件类型校验载荷；返回错误字符串数组（空数组表示通过）。 */
export function validatePayload(eventType, payload) {
  const errors = [];
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return ["payload: 必须是对象"];
  }
  const p = (key) => `payload.${key}`;

  switch (eventType) {
    case EVENT_TYPES.ATHLETE_REGISTERED: {
      requireString(payload, "athlete_id", errors, p("athlete_id"));
      requireString(payload, "pseudonym", errors, p("pseudonym"));
      requireString(payload, "sport", errors, p("sport"));
      requireEnum(payload, "gender", ["female", "male"], errors, p("gender"));
      if (payload.birth_date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(payload.birth_date)) {
        fail(errors, p("birth_date"), "必须是 YYYY-MM-DD 日期");
      }
      if (payload.tags !== undefined) requireArray(payload, "tags", errors, p("tags"));
      break;
    }

    case EVENT_TYPES.RULE_PUBLISHED: {
      requireString(payload, "rule_set_id", errors, p("rule_set_id"));
      requireString(payload, "sport", errors, p("sport"));
      requireString(payload, "version", errors, p("version"));
      requireIso(payload, "effective_from", errors, p("effective_from"));
      const entries = requireArray(payload, "entries", errors, p("entries"), { minLength: 1 });
      entries.forEach((entry, index) => {
        const ep = `payload.entries[${index}]`;
        if (entry === null || typeof entry !== "object") {
          fail(errors, ep, "必须是对象");
          return;
        }
        requireString(entry, "event_code", errors, `${ep}.event_code`);
        if (entry.max_entries_per_noc !== undefined) {
          requireNumber(entry, "max_entries_per_noc", errors, `${ep}.max_entries_per_noc`, { min: 0 });
        }
        if (entry.max_entries_per_athlete !== undefined) {
          requireNumber(entry, "max_entries_per_athlete", errors, `${ep}.max_entries_per_athlete`, { min: 1 });
        }
        if (entry.required_pairing_discipline != null) {
          requireString(entry, "required_pairing_discipline", errors, `${ep}.required_pairing_discipline`);
        }
        if (entry.compatible_with !== undefined) {
          const compat = requireArray(entry, "compatible_with", errors, `${ep}.compatible_with`);
          compat.forEach((code, ci) => {
            if (typeof code !== "string") fail(errors, `${ep}.compatible_with[${ci}]`, "必须是 event_code 字符串");
          });
        }
      });
      break;
    }

    case EVENT_TYPES.PAIRING_FORMED: {
      requireString(payload, "pairing_id", errors, p("pairing_id"));
      requireString(payload, "sport", errors, p("sport"));
      requireString(payload, "discipline", errors, p("discipline"));
      const members = requireArray(payload, "member_ids", errors, p("member_ids"), { minLength: 2 });
      members.forEach((id, index) => {
        if (typeof id !== "string" || id.trim() === "") fail(errors, `payload.member_ids[${index}]`, "必须是非空运动员编号");
      });
      requireIso(payload, "formed_at", errors, p("formed_at"));
      break;
    }

    case EVENT_TYPES.PAIRING_DISSOLVED: {
      requireString(payload, "pairing_id", errors, p("pairing_id"));
      requireIso(payload, "dissolved_at", errors, p("dissolved_at"));
      requireString(payload, "reason", errors, p("reason"));
      break;
    }

    case EVENT_TYPES.AVAILABILITY_DECLARED: {
      requireString(payload, "athlete_id", errors, p("athlete_id"));
      requireIso(payload, "valid_from", errors, p("valid_from"));
      requireIso(payload, "valid_to", errors, p("valid_to"));
      requireEnum(payload, "status", ["available", "limited", "unavailable"], errors, p("status"));
      if (payload.severity !== undefined) {
        requireEnum(payload, "severity", ["none", "light", "moderate", "severe"], errors, p("severity"));
      }
      requireString(payload, "reason", errors, p("reason"));
      if (isValidIso(payload.valid_from) && isValidIso(payload.valid_to) &&
          Date.parse(payload.valid_from) > Date.parse(payload.valid_to)) {
        fail(errors, p("valid_to"), "不能早于 valid_from");
      }
      break;
    }

    case EVENT_TYPES.LOAD_RECORDED: {
      requireString(payload, "athlete_id", errors, p("athlete_id"));
      requireIso(payload, "period_start", errors, p("period_start"));
      requireIso(payload, "period_end", errors, p("period_end"));
      requireNumber(payload, "training_load", errors, p("training_load"), { min: 0 });
      if (payload.competition_load !== undefined) {
        requireNumber(payload, "competition_load", errors, p("competition_load"), { min: 0 });
      }
      if (payload.competition_id !== undefined) requireString(payload, "competition_id", errors, p("competition_id"));
      if (isValidIso(payload.period_start) && isValidIso(payload.period_end) &&
          Date.parse(payload.period_start) > Date.parse(payload.period_end)) {
        fail(errors, p("period_end"), "不能早于 period_start");
      }
      break;
    }

    case EVENT_TYPES.COMPETITION_SCHEDULED: {
      requireString(payload, "competition_id", errors, p("competition_id"));
      requireString(payload, "name", errors, p("name"));
      requireString(payload, "sport", errors, p("sport"));
      requireIso(payload, "start_at", errors, p("start_at"));
      requireIso(payload, "end_at", errors, p("end_at"));
      if (payload.is_world_championship !== undefined && typeof payload.is_world_championship !== "boolean") {
        fail(errors, p("is_world_championship"), "必须是布尔值");
      }
      if (isValidIso(payload.start_at) && isValidIso(payload.end_at) &&
          Date.parse(payload.start_at) > Date.parse(payload.end_at)) {
        fail(errors, p("end_at"), "不能早于 start_at");
      }
      break;
    }

    case EVENT_TYPES.QUOTA_HELD: {
      requireString(payload, "quota_id", errors, p("quota_id"));
      requireString(payload, "sport", errors, p("sport"));
      requireString(payload, "event_code", errors, p("event_code"));
      requireEnum(payload, "holder_type", ["athlete", "pairing", "noc"], errors, p("holder_type"));
      requireString(payload, "holder_ref", errors, p("holder_ref"));
      requireIso(payload, "earned_at", errors, p("earned_at"));
      requireEnum(payload, "status", ["provisional", "confirmed", "returned"], errors, p("status"));
      if (payload.earned_at_competition_id !== undefined) {
        requireString(payload, "earned_at_competition_id", errors, p("earned_at_competition_id"));
      }
      break;
    }

    case EVENT_TYPES.QUOTA_STATUS_CHANGED: {
      requireString(payload, "quota_id", errors, p("quota_id"));
      requireEnum(payload, "status", ["provisional", "confirmed", "returned"], errors, p("status"));
      requireIso(payload, "changed_at", errors, p("changed_at"));
      requireString(payload, "reason", errors, p("reason"));
      break;
    }

    case EVENT_TYPES.ROSTER_CREATED: {
      requireString(payload, "roster_id", errors, p("roster_id"));
      requireString(payload, "competition_id", errors, p("competition_id"));
      requireString(payload, "sport", errors, p("sport"));
      requireString(payload, "label", errors, p("label"));
      requireIso(payload, "created_at", errors, p("created_at"));
      break;
    }

    case EVENT_TYPES.ROSTER_ENTRY_ADDED: {
      requireString(payload, "roster_id", errors, p("roster_id"));
      requireString(payload, "entry_id", errors, p("entry_id"));
      requireString(payload, "athlete_id", errors, p("athlete_id"));
      requireString(payload, "event_code", errors, p("event_code"));
      requireEnum(payload, "role", ["individual", "pair_member", "substitute"], errors, p("role"));
      if (payload.pairing_id != null) requireString(payload, "pairing_id", errors, p("pairing_id"));
      break;
    }

    case EVENT_TYPES.ROSTER_ENTRY_REMOVED: {
      requireString(payload, "roster_id", errors, p("roster_id"));
      requireString(payload, "entry_id", errors, p("entry_id"));
      requireString(payload, "reason", errors, p("reason"));
      requireIso(payload, "removed_at", errors, p("removed_at"));
      break;
    }

    case EVENT_TYPES.ROSTER_SUBMITTED: {
      requireString(payload, "roster_id", errors, p("roster_id"));
      requireIso(payload, "submitted_at", errors, p("submitted_at"));
      break;
    }

    case EVENT_TYPES.SELECTION_BASIS_RECORDED: {
      requireString(payload, "roster_id", errors, p("roster_id"));
      if (payload.entry_id !== undefined) requireString(payload, "entry_id", errors, p("entry_id"));
      requireString(payload, "athlete_id", errors, p("athlete_id"));
      requireEnum(
        payload,
        "basis_type",
        ["ranking", "trial", "quota", "coach_discretion", "youth_development"],
        errors,
        p("basis_type"),
      );
      requireString(payload, "reference", errors, p("reference"));
      requireIso(payload, "recorded_at", errors, p("recorded_at"));
      break;
    }

    case EVENT_TYPES.DECISION_RECORDED: {
      requireString(payload, "roster_id", errors, p("roster_id"));
      requireEnum(
        payload,
        "action",
        ["approve", "reject", "override_warning", "substitute"],
        errors,
        p("action"),
      );
      requireString(payload, "decided_by", errors, p("decided_by"));
      requireIso(payload, "decided_at", errors, p("decided_at"));
      // 最终人工决定必须记录理由
      const rationale = requireString(payload, "rationale", errors, p("rationale"));
      if (rationale !== undefined && rationale.trim().length < 2) {
        fail(errors, p("rationale"), "理由过短，无法承担人工决定的留痕要求");
      }
      if (payload.acknowledged_warning_codes !== undefined) {
        requireArray(payload, "acknowledged_warning_codes", errors, p("acknowledged_warning_codes"));
      }
      if (payload.action === "substitute") {
        requireString(payload, "out_entry_id", errors, p("out_entry_id"));
        requireString(payload, "in_entry_id", errors, p("in_entry_id"));
      }
      break;
    }

    case EVENT_TYPES.RESULT_RECORDED: {
      requireString(payload, "competition_id", errors, p("competition_id"));
      requireString(payload, "event_code", errors, p("event_code"));
      if (payload.athlete_id === undefined && payload.pairing_id === undefined) {
        fail(errors, p("athlete_id"), "athlete_id 与 pairing_id 至少提供一个");
      }
      if (payload.athlete_id !== undefined) requireString(payload, "athlete_id", errors, p("athlete_id"));
      if (payload.pairing_id != null) requireString(payload, "pairing_id", errors, p("pairing_id"));
      if (payload.medal !== undefined && payload.medal !== null) {
        requireEnum(payload, "medal", ["gold", "silver", "bronze"], errors, p("medal"));
      }
      if (payload.olympic_qualification !== undefined && payload.olympic_qualification !== null) {
        requireEnum(payload, "olympic_qualification", ["earned", "confirmed", "none"], errors, p("olympic_qualification"));
      }
      if (payload.training_validation !== undefined && payload.training_validation !== null) {
        const v = payload.training_validation;
        if (v === null || typeof v !== "object") {
          fail(errors, p("training_validation"), "必须是对象");
        } else {
          requireString(v, "phase", errors, "payload.training_validation.phase");
          if (typeof v.passed !== "boolean") fail(errors, "payload.training_validation.passed", "必须是布尔值");
        }
      }
      requireIso(payload, "recorded_at", errors, p("recorded_at"));
      break;
    }

    default:
      fail(errors, "event_type", `未知事件类型 ${eventType}`);
  }

  return errors;
}

/** 校验交换信封（contracts/event.example.json 的形状）。 */
export function validateEnvelope(envelope) {
  const errors = [];
  if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) {
    return ["请求体必须是事件对象"];
  }
  requireString(envelope, "event_id", errors, "event_id");
  requireString(envelope, "event_type", errors, "event_type");
  requireString(envelope, "subject_ref", errors, "subject_ref");
  requireIso(envelope, "occurred_at", errors, "occurred_at");
  requireString(envelope, "source", errors, "source");
  requireNumber(envelope, "source_sequence", errors, "source_sequence", { min: 1 });
  if (payloadIsObject(envelope.payload)) {
    errors.push(...validatePayload(envelope.event_type, envelope.payload));
  } else {
    errors.push("payload: 必须是对象");
  }
  return errors;
}

function payloadIsObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
