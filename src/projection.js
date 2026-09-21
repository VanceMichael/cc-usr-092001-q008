/**
 * 投影：把仅追加的事件流归约成可查询状态，并在状态上执行草案校验与追溯。
 *
 * 关键约定：
 * - 事件按 occurred_at（领域时间）归约，到达先后不改变历史解释；
 * - 草案的规则版本在草案创建时"钉定"，之后发布的新规则不影响历史名单；
 * - 所有 add/remove、决定、结果都保留带时间的完整轨迹，投影只读取，从不回写事件。
 */

import { EVENT_TYPES } from "./events.js";

/** 两场比赛间隔不超过该天数即判定为连续作战风险（可由调用方在选项中覆盖）。 */
export const DEFAULT_CONSECUTIVE_GAP_DAYS = 7;

const BLOCK = "block";
const CAUTION = "caution";

function toTime(value) {
  return Date.parse(value);
}

function warn(code, severity, message, refs = {}) {
  return { code, severity, message, refs };
}

export function buildState(events) {
  const state = {
    athletes: new Map(),
    // sport -> 按 effective_from 升序的版本数组
    ruleVersions: new Map(),
    pairings: new Map(),
    // athlete_id -> 申报数组（按 valid_from 升序）
    availabilities: new Map(),
    // athlete_id -> 负荷记录数组
    loads: new Map(),
    competitions: new Map(),
    quotas: new Map(),
    rosters: new Map(),
    results: [],
  };

  const ordered = [...events].sort((a, b) => {
    const delta = toTime(a.occurred_at) - toTime(b.occurred_at);
    return delta !== 0 ? delta : a.id - b.id;
  });

  for (const event of ordered) {
    apply(state, event);
  }
  return state;
}

function apply(state, event) {
  const p = event.payload;
  switch (event.event_type) {
    case EVENT_TYPES.ATHLETE_REGISTERED: {
      state.athletes.set(p.athlete_id, {
        athlete_id: p.athlete_id,
        pseudonym: p.pseudonym,
        sport: p.sport,
        gender: p.gender,
        birth_date: p.birth_date ?? null,
        tags: p.tags ?? [],
        registered_at: event.occurred_at,
      });
      break;
    }

    case EVENT_TYPES.RULE_PUBLISHED: {
      const list = state.ruleVersions.get(p.sport) ?? [];
      list.push({
        rule_set_id: p.rule_set_id,
        sport: p.sport,
        version: p.version,
        effective_from: p.effective_from,
        entries: new Map(
          p.entries.map((entry) => [
            entry.event_code,
            {
              event_code: entry.event_code,
              max_entries_per_noc: entry.max_entries_per_noc ?? null,
              max_entries_per_athlete: entry.max_entries_per_athlete ?? null,
              required_pairing_discipline: entry.required_pairing_discipline ?? null,
              compatible_with: new Set(entry.compatible_with ?? []),
            },
          ]),
        ),
      });
      list.sort((a, b) => toTime(a.effective_from) - toTime(b.effective_from));
      state.ruleVersions.set(p.sport, list);
      break;
    }

    case EVENT_TYPES.PAIRING_FORMED: {
      state.pairings.set(p.pairing_id, {
        pairing_id: p.pairing_id,
        sport: p.sport,
        discipline: p.discipline,
        member_ids: [...p.member_ids],
        formed_at: p.formed_at,
        dissolved_at: null,
        dissolved_reason: null,
      });
      break;
    }

    case EVENT_TYPES.PAIRING_DISSOLVED: {
      const pairing = state.pairings.get(p.pairing_id);
      if (pairing) {
        pairing.dissolved_at = p.dissolved_at;
        pairing.dissolved_reason = p.reason;
      }
      break;
    }

    case EVENT_TYPES.AVAILABILITY_DECLARED: {
      const list = state.availabilities.get(p.athlete_id) ?? [];
      list.push({
        valid_from: p.valid_from,
        valid_to: p.valid_to,
        status: p.status,
        severity: p.severity ?? (p.status === "available" ? "none" : "moderate"),
        reason: p.reason,
        recorded_at: event.occurred_at,
      });
      list.sort((a, b) => toTime(a.valid_from) - toTime(b.valid_from));
      state.availabilities.set(p.athlete_id, list);
      break;
    }

    case EVENT_TYPES.LOAD_RECORDED: {
      const list = state.loads.get(p.athlete_id) ?? [];
      list.push({
        period_start: p.period_start,
        period_end: p.period_end,
        training_load: p.training_load,
        competition_load: p.competition_load ?? 0,
        competition_id: p.competition_id ?? null,
        recorded_at: event.occurred_at,
      });
      state.loads.set(p.athlete_id, list);
      break;
    }

    case EVENT_TYPES.COMPETITION_SCHEDULED: {
      state.competitions.set(p.competition_id, {
        competition_id: p.competition_id,
        name: p.name,
        sport: p.sport,
        start_at: p.start_at,
        end_at: p.end_at,
        is_world_championship: p.is_world_championship ?? false,
      });
      break;
    }

    case EVENT_TYPES.QUOTA_HELD: {
      state.quotas.set(p.quota_id, {
        quota_id: p.quota_id,
        sport: p.sport,
        event_code: p.event_code,
        holder_type: p.holder_type,
        holder_ref: p.holder_ref,
        earned_at: p.earned_at,
        earned_at_competition_id: p.earned_at_competition_id ?? null,
        status: p.status,
      });
      break;
    }

    case EVENT_TYPES.QUOTA_STATUS_CHANGED: {
      const quota = state.quotas.get(p.quota_id);
      if (quota) {
        quota.status = p.status;
        quota.status_changed_at = p.changed_at;
        quota.status_reason = p.reason;
      }
      break;
    }

    case EVENT_TYPES.ROSTER_CREATED: {
      state.rosters.set(p.roster_id, {
        roster_id: p.roster_id,
        competition_id: p.competition_id,
        sport: p.sport,
        label: p.label,
        created_at: p.created_at,
        submitted_at: null,
        entries: new Map(),
        selection_bases: [],
        decisions: [],
      });
      break;
    }

    case EVENT_TYPES.ROSTER_ENTRY_ADDED: {
      const roster = state.rosters.get(p.roster_id);
      if (!roster) break;
      roster.entries.set(p.entry_id, {
        entry_id: p.entry_id,
        athlete_id: p.athlete_id,
        event_code: p.event_code,
        role: p.role,
        pairing_id: p.pairing_id ?? null,
        added_at: event.occurred_at,
        removed_at: null,
        removed_reason: null,
      });
      break;
    }

    case EVENT_TYPES.ROSTER_ENTRY_REMOVED: {
      const roster = state.rosters.get(p.roster_id);
      const entry = roster?.entries.get(p.entry_id);
      if (entry) {
        entry.removed_at = p.removed_at;
        entry.removed_reason = p.reason;
      }
      break;
    }

    case EVENT_TYPES.ROSTER_SUBMITTED: {
      const roster = state.rosters.get(p.roster_id);
      if (roster) roster.submitted_at = p.submitted_at;
      break;
    }

    case EVENT_TYPES.SELECTION_BASIS_RECORDED: {
      const roster = state.rosters.get(p.roster_id);
      if (!roster) break;
      roster.selection_bases.push({
        entry_id: p.entry_id ?? null,
        athlete_id: p.athlete_id,
        basis_type: p.basis_type,
        reference: p.reference,
        recorded_at: p.recorded_at,
      });
      break;
    }

    case EVENT_TYPES.DECISION_RECORDED: {
      const roster = state.rosters.get(p.roster_id);
      if (!roster) break;
      roster.decisions.push({
        action: p.action,
        decided_by: p.decided_by,
        decided_at: p.decided_at,
        rationale: p.rationale,
        acknowledged_warning_codes: p.acknowledged_warning_codes ?? [],
        out_entry_id: p.out_entry_id ?? null,
        in_entry_id: p.in_entry_id ?? null,
      });
      break;
    }

    case EVENT_TYPES.RESULT_RECORDED: {
      state.results.push({
        competition_id: p.competition_id,
        event_code: p.event_code,
        athlete_id: p.athlete_id ?? null,
        pairing_id: p.pairing_id ?? null,
        medal: p.medal ?? null,
        olympic_qualification: p.olympic_qualification ?? null,
        training_validation: p.training_validation ?? null,
        recorded_at: p.recorded_at,
      });
      break;
    }

    default:
      break;
  }
}

/** 解析某运动在指定时刻生效的规则版本（取 effective_from <= at 的最新一版）。 */
export function resolveRuleVersion(state, sport, at) {
  const versions = state.ruleVersions.get(sport) ?? [];
  let picked = null;
  for (const version of versions) {
    if (toTime(version.effective_from) <= toTime(at)) picked = version;
  }
  return picked;
}

function intervalsOverlap(aStart, aEnd, bStart, bEnd) {
  return toTime(aStart) < toTime(bEnd) && toTime(bStart) < toTime(aEnd);
}

function activeEntries(roster, asOf) {
  const cutoff = toTime(asOf);
  return [...roster.entries.values()].filter(
    (entry) =>
      toTime(entry.added_at) <= cutoff &&
      (entry.removed_at === null || toTime(entry.removed_at) > cutoff),
  );
}

/** 某运动员在时间窗内的可用性（任何 unavailable 优先，其次 limited）。 */
function availabilityDuring(state, athleteId, startAt, endAt) {
  const declarations = state.availabilities.get(athleteId) ?? [];
  let hit = null;
  for (const declaration of declarations) {
    if (intervalsOverlap(declaration.valid_from, declaration.valid_to, startAt, endAt)) {
      if (declaration.status === "unavailable") return declaration;
      if (declaration.status === "limited") hit = declaration;
    }
  }
  return hit;
}

/** 该运动员在指定窗口内有记录的训练/比赛负荷合计。 */
function loadInWindow(state, athleteId, startAt, endAt) {
  const records = state.loads.get(athleteId) ?? [];
  let training = 0;
  let competition = 0;
  for (const record of records) {
    if (toTime(record.period_end) <= toTime(startAt)) continue;
    if (toTime(record.period_start) >= toTime(endAt)) continue;
    training += record.training_load;
    competition += record.competition_load;
  }
  return { training_load: training, competition_load: competition };
}

/**
 * 校验一份参赛草案。
 *
 * 选项：
 * - asOf：按哪个时刻解释名单（默认当前时间）；追溯历史时传草案提交时间；
 * - consecutiveGapDays：连续作战的间隔阈值。
 * 返回钉定的规则版本、按严重程度排序的风险清单与统计。
 */
export function validateRoster(state, rosterId, options = {}) {
  const roster = state.rosters.get(rosterId);
  if (!roster) return null;
  const competition = state.competitions.get(roster.competition_id);
  const asOf = options.asOf ?? new Date().toISOString();
  const gapMs = (options.consecutiveGapDays ?? DEFAULT_CONSECUTIVE_GAP_DAYS) * 24 * 60 * 60 * 1000;
  const warnings = [];

  // 规则版本在草案创建时钉定：历史名单永远按当时规则解释。
  const pinned = resolveRuleVersion(state, roster.sport, roster.created_at);
  const rules = pinned ? pinned.entries : null;
  if (!competition) {
    warnings.push(warn("COMPETITION_MISSING", BLOCK, "草案引用的比赛尚未登记", {
      competition_id: roster.competition_id,
    }));
  }
  if (!rules) {
    warnings.push(warn("RULESET_MISSING", BLOCK, "草案创建时没有已生效的项目规则版本，无法进行规则校验", {
      sport: roster.sport,
      created_at: roster.created_at,
    }));
  }

  const entries = activeEntries(roster, asOf);

  // 1) 伤病可用性（同一运动员在同一比赛只告警一次，避免多报名条目造成重复）
  const injuredSeen = new Set();
  if (competition) {
    for (const entry of entries) {
      const declaration = availabilityDuring(state, entry.athlete_id, competition.start_at, competition.end_at);
      if (!declaration) continue;
      const dedupeKey = `${entry.athlete_id}|${declaration.status}|${declaration.valid_from}`;
      if (injuredSeen.has(dedupeKey)) continue;
      injuredSeen.add(dedupeKey);
      if (declaration.status === "unavailable") {
        warnings.push(warn("INJURY_UNAVAILABLE", BLOCK, "运动员在比赛期间处于不可用状态", {
          entry_id: entry.entry_id,
          athlete_id: entry.athlete_id,
          reason: declaration.reason,
          valid_from: declaration.valid_from,
          valid_to: declaration.valid_to,
        }));
      } else if (declaration.status === "limited") {
        warnings.push(warn("INJURY_LIMITED", CAUTION, "运动员在比赛期间带伤/受限参赛", {
          entry_id: entry.entry_id,
          athlete_id: entry.athlete_id,
          reason: declaration.reason,
        }));
      }
    }
  }

  // 2) 规则不兼容 & 3) 超额报名（均基于钉定版本）
  const slotsByEvent = new Map();
  const seenAthleteEvent = new Set();
  for (const entry of entries) {
    const rule = rules?.get(entry.event_code);
    if (rules && !rule) {
      warnings.push(warn("EVENT_NOT_IN_RULES", BLOCK, "报名小项不在钉定规则版本中（可能是已废止或未启用的级别）", {
        entry_id: entry.entry_id,
        event_code: entry.event_code,
        rule_version: pinned.version,
      }));
      continue;
    }

    // 同一运动员在同一小项重复登记
    const athleteEventKey = `${entry.athlete_id}|${entry.event_code}`;
    if (seenAthleteEvent.has(athleteEventKey)) {
      warnings.push(warn("OVER_ENTRY_ATHLETE", BLOCK, "同一运动员在同一小项重复报名", {
        entry_id: entry.entry_id,
        athlete_id: entry.athlete_id,
        event_code: entry.event_code,
      }));
    }
    seenAthleteEvent.add(athleteEventKey);

    // 需要配对的小项：必须以 pair_member 身份属于一个有效组合
    if (rule?.required_pairing_discipline) {
      const pairing = entry.pairing_id ? state.pairings.get(entry.pairing_id) : null;
      if (entry.role !== "pair_member" || !pairing) {
        warnings.push(warn("PAIRING_REQUIRED", BLOCK, "该小项要求组合参赛，但报名不是有效组合成员", {
          entry_id: entry.entry_id,
          event_code: entry.event_code,
          pairing_id: entry.pairing_id ?? null,
        }));
      } else {
        if (pairing.discipline !== rule.required_pairing_discipline) {
          warnings.push(warn("PAIRING_DISCIPLINE_MISMATCH", BLOCK, "组合所属分项与规则要求不一致", {
            entry_id: entry.entry_id,
            pairing_id: pairing.pairing_id,
            expected: rule.required_pairing_discipline,
            actual: pairing.discipline,
          }));
        }
        if (!pairing.member_ids.includes(entry.athlete_id)) {
          warnings.push(warn("PAIRING_MEMBER_MISMATCH", BLOCK, "报名运动员不属于所引用的组合", {
            entry_id: entry.entry_id,
            pairing_id: pairing.pairing_id,
            athlete_id: entry.athlete_id,
          }));
        }
        if (competition && toTime(pairing.formed_at) >= toTime(competition.start_at)) {
          warnings.push(warn("PAIRING_NOT_FORMED", BLOCK, "组合在比赛开始时尚未组建", {
            entry_id: entry.entry_id,
            pairing_id: pairing.pairing_id,
            formed_at: pairing.formed_at,
          }));
        }
        if (pairing.dissolved_at && competition && toTime(pairing.dissolved_at) <= toTime(competition.start_at)) {
          warnings.push(warn("PAIRING_DISSOLVED", BLOCK, "组合在比赛开始前已解散", {
            entry_id: entry.entry_id,
            pairing_id: pairing.pairing_id,
            dissolved_at: pairing.dissolved_at,
          }));
        }
      }
    }

    const bucket = slotsByEvent.get(entry.event_code) ?? { individuals: [], pairings: new Map(), substitutes: [] };
    if (entry.role === "substitute") bucket.substitutes.push(entry);
    else if (entry.role === "pair_member" && entry.pairing_id) bucket.pairings.set(entry.pairing_id, entry);
    else bucket.individuals.push(entry);
    slotsByEvent.set(entry.event_code, bucket);
  }

  if (rules) {
    for (const [eventCode, bucket] of slotsByEvent) {
      const rule = rules.get(eventCode);
      const slotCount = bucket.individuals.length + bucket.pairings.size;
      if (rule.max_entries_per_noc !== null && slotCount > rule.max_entries_per_noc) {
        warnings.push(warn("OVER_ENTRY_NOC", BLOCK, `小项报名 ${slotCount} 个席位，超过协会上限 ${rule.max_entries_per_noc}`, {
          event_code: eventCode,
          slots: slotCount,
          max_entries_per_noc: rule.max_entries_per_noc,
        }));
      }
    }

    // 每名运动员在本比赛的小项数限制 + 小项兼容矩阵（如举重新级别不可兼项）
    const eventsByAthlete = new Map();
    for (const entry of entries) {
      if (entry.role === "substitute") continue;
      const list = eventsByAthlete.get(entry.athlete_id) ?? [];
      list.push(entry);
      eventsByAthlete.set(entry.athlete_id, list);
    }
    for (const [athleteId, athleteEntries] of eventsByAthlete) {
      const codes = [...new Set(athleteEntries.map((entry) => entry.event_code))];
      // 每名运动员在本比赛的小项数上限：取其所报小项中最严的限制，只告警一次
      const athleteLimit = codes.reduce(
        (limit, code) => {
          const value = rules.get(code)?.max_entries_per_athlete ?? null;
          return value === null ? limit : Math.min(limit, value);
        },
        Infinity,
      );
      if (Number.isFinite(athleteLimit) && codes.length > athleteLimit) {
        warnings.push(warn("OVER_ENTRY_ATHLETE", BLOCK, `运动员报名 ${codes.length} 个小项，超过每人上限 ${athleteLimit}`, {
          athlete_id: athleteId,
          event_codes: codes,
          max_entries_per_athlete: athleteLimit,
        }));
      }
      for (let i = 0; i < codes.length; i += 1) {
        for (let j = i + 1; j < codes.length; j += 1) {
          const ruleA = rules.get(codes[i]);
          if (ruleA && ruleA.compatible_with.size > 0 && !ruleA.compatible_with.has(codes[j])) {
            warnings.push(warn("EVENT_INCOMPATIBLE", BLOCK, "同一运动员兼报的两个小项在规则上不兼容", {
              athlete_id: athleteId,
              event_codes: [codes[i], codes[j]],
              rule_version: pinned.version,
            }));
          }
        }
      }
    }
  }

  // 4) 席位持有情况：出场席位应有对应资格（临时/确认均可，已退回不计）
  if (rules) {
    for (const entry of entries) {
      if (entry.role === "substitute") continue;
      const holderRef = entry.role === "pair_member" ? entry.pairing_id : entry.athlete_id;
      const holderType = entry.role === "pair_member" ? "pairing" : "athlete";
      const covered = [...state.quotas.values()].some(
        (quota) =>
          quota.sport === roster.sport &&
          quota.event_code === entry.event_code &&
          quota.status !== "returned" &&
          quota.holder_type === holderType &&
          quota.holder_ref === holderRef,
      );
      if (!covered) {
        warnings.push(warn("QUOTA_MISSING", CAUTION, "出场报名缺少持有的奥运/选拔资格席位", {
          entry_id: entry.entry_id,
          athlete_id: entry.athlete_id,
          event_code: entry.event_code,
        }));
      }
    }
  }

  // 5) 时间冲突 & 6) 连续作战：按（运动员，对手比赛）去重，多报名条目不重复告警
  if (competition) {
    const scheduleSeen = new Set();
    for (const entry of entries) {
      const athleteCompetitions = collectAthleteCompetitions(state, entry.athlete_id);
      for (const other of athleteCompetitions) {
        if (other.competition_id === competition.competition_id) continue;
        const dedupeKey = `${entry.athlete_id}|${other.competition_id}`;
        if (scheduleSeen.has(dedupeKey)) continue;
        scheduleSeen.add(dedupeKey);
        if (intervalsOverlap(competition.start_at, competition.end_at, other.start_at, other.end_at)) {
          warnings.push(warn("TIME_CONFLICT", BLOCK, "与运动员另一场报名比赛的赛期重叠", {
            athlete_id: entry.athlete_id,
            competition_id: competition.competition_id,
            overlapping_competition_id: other.competition_id,
            overlapping_competition_name: other.name,
          }));
        } else {
          const gap = gapBetween(competition, other);
          if (gap >= 0 && gap <= gapMs) {
            const load = loadInWindow(
              state,
              entry.athlete_id,
              new Date(toTime(competition.start_at) - gapMs).toISOString(),
              competition.start_at,
            );
            warnings.push(warn("CONSECUTIVE_COMPETITION", CAUTION, "与上/下一场比赛间隔过短，存在连续作战风险", {
              athlete_id: entry.athlete_id,
              competition_id: competition.competition_id,
              other_competition_id: other.competition_id,
              other_competition_name: other.name,
              gap_days: Math.round(gap / (24 * 60 * 60 * 1000)),
              recent_training_load: load.training_load,
            }));
          }
        }
      }
    }
  }

  const severityRank = { [BLOCK]: 0, [CAUTION]: 1 };
  warnings.sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || a.code.localeCompare(b.code));

  const counts = { block: 0, caution: 0, by_code: {} };
  for (const warning of warnings) {
    counts[warning.severity] += 1;
    counts.by_code[warning.code] = (counts.by_code[warning.code] ?? 0) + 1;
  }

  return {
    roster_id: rosterId,
    as_of: asOf,
    pinned_rule: pinned
      ? { rule_set_id: pinned.rule_set_id, sport: pinned.sport, version: pinned.version, effective_from: pinned.effective_from }
      : null,
    competition: competition ?? null,
    active_entry_count: entries.length,
    warnings,
    counts,
    latest_decision: roster.decisions.length > 0 ? roster.decisions[roster.decisions.length - 1] : null,
  };
}

function gapBetween(a, b) {
  const aStart = toTime(a.start_at);
  const bStart = toTime(b.start_at);
  if (aStart > bStart) {
    return aStart - toTime(b.end_at);
  }
  return bStart - toTime(a.end_at);
}

/** 运动员在所有草案中（当前仍有效报名）参加的比赛。 */
function collectAthleteCompetitions(state, athleteId) {
  const found = new Map();
  for (const roster of state.rosters.values()) {
    for (const entry of roster.entries.values()) {
      if (entry.athlete_id !== athleteId || entry.removed_at !== null) continue;
      const competition = state.competitions.get(roster.competition_id);
      if (competition) found.set(competition.competition_id, competition);
    }
  }
  return [...found.values()];
}

/** 同一比赛下多份方案的对比。 */
export function compareRosters(state, competitionId, options = {}) {
  const competition = state.competitions.get(competitionId);
  if (!competition) return null;
  const rows = [];
  for (const roster of state.rosters.values()) {
    if (roster.competition_id !== competitionId) continue;
    const report = validateRoster(state, roster.roster_id, options);
    const entries = [...roster.entries.values()];
    const activeEntriesNow = entries.filter((entry) => entry.removed_at === null);
    const athletes = new Set(activeEntriesNow.map((entry) => entry.athlete_id));
    const youthCount = roster.selection_bases.filter((basis) => basis.basis_type === "youth_development").length;
    rows.push({
      roster_id: roster.roster_id,
      label: roster.label,
      created_at: roster.created_at,
      submitted_at: roster.submitted_at,
      athlete_count: athletes.size,
      entry_count: activeEntriesNow.length,
      events: [...new Set(activeEntriesNow.map((entry) => entry.event_code))].sort(),
      block_count: report.counts.block,
      caution_count: report.counts.caution,
      warning_codes: report.counts.by_code,
      youth_selection_count: youthCount,
      latest_decision: report.latest_decision,
    });
  }
  rows.sort((a, b) => toTime(a.created_at) - toTime(b.created_at));
  return { competition_id: competitionId, competition_name: competition.name, options: rows };
}

/** 一名运动员从入选、替换到负荷变化的完整轨迹。 */
export function athleteTimeline(state, athleteId) {
  const athlete = state.athletes.get(athleteId);
  if (!athlete) return null;

  const timeline = [];
  for (const declaration of state.availabilities.get(athleteId) ?? []) {
    timeline.push({ at: declaration.valid_from, kind: "availability", detail: declaration });
  }
  for (const load of state.loads.get(athleteId) ?? []) {
    timeline.push({ at: load.period_start, kind: "load", detail: load });
  }

  const rosterHistory = [];
  for (const roster of state.rosters.values()) {
    const competition = state.competitions.get(roster.competition_id);
    for (const entry of roster.entries.values()) {
      if (entry.athlete_id !== athleteId) continue;
      const bases = roster.selection_bases.filter(
        (basis) => basis.athlete_id === athleteId && (!basis.entry_id || basis.entry_id === entry.entry_id),
      );
      const relatedDecisions = roster.decisions.filter(
        (decision) =>
          (decision.action === "substitute" &&
            (decision.out_entry_id === entry.entry_id || decision.in_entry_id === entry.entry_id)) ||
          (decision.action !== "substitute"),
      );
      const record = {
        roster_id: roster.roster_id,
        label: roster.label,
        competition_id: roster.competition_id,
        competition_name: competition?.name ?? null,
        entry_id: entry.entry_id,
        event_code: entry.event_code,
        role: entry.role,
        pairing_id: entry.pairing_id,
        added_at: entry.added_at,
        removed_at: entry.removed_at,
        removed_reason: entry.removed_reason,
        selection_bases: bases,
        decisions: relatedDecisions,
      };
      rosterHistory.push(record);
      timeline.push({
        at: entry.added_at,
        kind: "entry_added",
        detail: record,
      });
      if (entry.removed_at) {
        timeline.push({
          at: entry.removed_at,
          kind: "entry_removed",
          detail: record,
        });
      }
    }
  }
  rosterHistory.sort((a, b) => toTime(a.added_at) - toTime(b.added_at));

  const pairingHistory = [...state.pairings.values()]
    .filter((pairing) => pairing.member_ids.includes(athleteId))
    .map((pairing) => ({ ...pairing }));

  const quotas = [...state.quotas.values()].filter(
    (quota) => quota.holder_type === "athlete" && quota.holder_ref === athleteId,
  );

  const results = state.results.filter((result) => result.athlete_id === athleteId);
  for (const result of results) {
    timeline.push({ at: result.recorded_at, kind: "result", detail: result });
  }

  timeline.sort((a, b) => toTime(a.at) - toTime(b.at));

  return {
    athlete,
    pairings: pairingHistory,
    quotas,
    roster_history: rosterHistory,
    results,
    timeline,
  };
}

/**
 * 组合视角：新配对的共同参赛记录独立于队员个人历史单独积累。
 * 包括共同报名的比赛与共同取得的结果。
 */
export function pairingProfile(state, pairingId) {
  const pairing = state.pairings.get(pairingId);
  if (!pairing) return null;

  const jointEntries = [];
  for (const roster of state.rosters.values()) {
    const competition = state.competitions.get(roster.competition_id);
    for (const entry of roster.entries.values()) {
      if (entry.pairing_id !== pairingId) continue;
      jointEntries.push({
        roster_id: roster.roster_id,
        label: roster.label,
        competition_id: roster.competition_id,
        competition_name: competition?.name ?? null,
        competition_start: competition?.start_at ?? null,
        entry_id: entry.entry_id,
        athlete_id: entry.athlete_id,
        event_code: entry.event_code,
        role: entry.role,
        removed_at: entry.removed_at,
      });
    }
  }
  jointEntries.sort((a, b) => toTime(a.competition_start ?? 0) - toTime(b.competition_start ?? 0));

  const jointResults = state.results.filter((result) => result.pairing_id === pairingId);
  const competitionsTogether = new Set(
    jointEntries.filter((entry) => entry.removed_at === null).map((entry) => entry.competition_id),
  );

  return {
    pairing,
    member_profiles: pairing.member_ids.map((id) => state.athletes.get(id) ?? { athlete_id: id, pseudonym: null }),
    joint_competition_count: competitionsTogether.size,
    joint_entries: jointEntries,
    joint_results: jointResults,
  };
}

/** 赛事结果按三类效果拆分：奖牌、奥运资格、阶段性训练验证。 */
export function competitionResults(state, competitionId) {
  const rows = state.results.filter((result) => result.competition_id === competitionId);
  const medalOrder = { gold: 0, silver: 1, bronze: 2 };
  const medals = rows
    .filter((result) => result.medal)
    .sort((a, b) => medalOrder[a.medal] - medalOrder[b.medal]);
  const olympicQualifications = rows.filter((result) => result.olympic_qualification && result.olympic_qualification !== "none");
  const trainingValidations = rows.filter((result) => result.training_validation);
  return {
    competition_id: competitionId,
    medals,
    olympic_qualifications: olympicQualifications,
    training_validations: trainingValidations,
    raw_result_count: rows.length,
  };
}
