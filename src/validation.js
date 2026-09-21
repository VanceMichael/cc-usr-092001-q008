import { availabilityAt } from "./facts.js";

// ---------------------------------------------------------------------------
// 草案自动校验：时间冲突 / 连续作战风险 / 超额报名 / 规则不兼容
// 纯函数：输入"按位点归约的模型 + 冻结规则快照 + 草案条目"，输出 findings。
// severity：block 必须处理或走 override 留理由；warn 提示风险。
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULTS = {
  consecutive: { min_gap_days: 3, load_window_days: 7, load_avg_threshold: 80 },
  max_events_per_athlete: null, // 规则体可覆盖，如 { table_tennis: 3 }
};

function ruleBodyFor(model, snap) {
  if (!snap) return null;
  const hit = model.rules.find((r) => r.rule_id === snap.rule_id && r.version === snap.version);
  return hit ? hit.body : null;
}

// 为草案涉及的每个小项冻结当时适用规则版本
export function buildRulesSnapshot(model, entries, asOf) {
  const snapshot = {};
  for (const e of entries) {
    const key = `${e.discipline}|${e.event_code}`;
    if (snapshot[key]) continue;
    const rule = pickRule(model, e.discipline, e.event_code, asOf);
    if (rule) {
      snapshot[key] = {
        rule_id: rule.rule_id,
        version: rule.version,
        discipline: rule.discipline,
        event_code: rule.event_code,
        effective_from: rule.effective_from,
      };
    } else {
      snapshot[key] = null; // 当时无适用规则
    }
  }
  return snapshot;
}

function pickRule(model, discipline, eventCode, asOf) {
  const t = Date.parse(asOf);
  const candidates = model.rules
    .filter(
      (r) =>
        r.discipline === discipline &&
        Date.parse(r.effective_from) <= t &&
        (r.event_code === eventCode || r.event_code == null)
    )
    .sort((a, b) => {
      const byTime = Date.parse(b.effective_from) - Date.parse(a.effective_from);
      if (byTime !== 0) return byTime;
      return (a.event_code === eventCode ? 0 : 1) - (b.event_code === eventCode ? 0 : 1);
    });
  return candidates[0] ?? null;
}

function membersOf(model, entry) {
  if (entry.entry_kind === "pair") {
    const pairing = model.pairings.get(entry.subject_ref);
    if (pairing) return pairing.members.slice();
    // 对不上已知组合时，规则不兼容检查会报，这里退化为空
    return [];
  }
  return [entry.subject_ref];
}

function finding(code, severity, subjectRef, eventCode, message, detail = {}) {
  return { code, severity, subject_ref: subjectRef, event_code: eventCode, message, detail };
}

// 规则体支持两种写法：全局 {size,genders}，或按小项映射 {TT_XD:{size,genders}}
function compositionFor(body, eventCode) {
  const pc = body.pair_composition;
  if (!pc) return null;
  if (pc.genders || pc.size) return pc;
  return pc[eventCode] ?? null;
}

// 1) 时间冲突：同一自然人在同一赛事内上场时段交叠
function checkTimeConflicts(model, competition, entries) {
  const out = [];
  // 自然人 -> 其出现的场次
  const personSlots = new Map();
  for (const entry of entries) {
    if (entry.role !== "competitor") continue;
    const session = model.competitionEvents.get(`${competition.competition_id}|${entry.event_code}`);
    if (!session) {
      out.push(
        finding(
          "time_conflict",
          "warn",
          entry.subject_ref,
          entry.event_code,
          `缺少场次 ${entry.event_code} 的时段数据，无法判定冲突`,
          { missing_session: true }
        )
      );
      continue;
    }
    for (const person of membersOf(model, entry)) {
      const list = personSlots.get(person) ?? [];
      list.push({ event_code: entry.event_code, ...session });
      personSlots.set(person, list);
    }
  }
  for (const [person, slots] of personSlots) {
    for (let i = 0; i < slots.length; i++) {
      for (let j = i + 1; j < slots.length; j++) {
        const a = slots[i];
        const b = slots[j];
        if (
          Date.parse(a.session_starts_at) < Date.parse(b.session_ends_at) &&
          Date.parse(b.session_starts_at) < Date.parse(a.session_ends_at)
        ) {
          out.push(
            finding(
              "time_conflict",
              "block",
              person,
              `${a.event_code}/${b.event_code}`,
              `${person} 在 ${a.event_code} 与 ${b.event_code} 的上场时段交叠，无法兼项`,
              {
                sessions: [
                  { event_code: a.event_code, starts_at: a.session_starts_at, ends_at: a.session_ends_at },
                  { event_code: b.event_code, starts_at: b.session_starts_at, ends_at: b.session_ends_at },
                ],
              }
            )
          );
        }
      }
    }
  }
  return out;
}

// 2) 连续作战风险：近期有其它赛事出场记录且间隔不足；叠加高负荷升级
function recentAppearances(model, person, currentCompetition, minGapDays) {
  const current = model.competitions.get(currentCompetition.competition_id);
  const currentStart = Date.parse(current.starts_at);
  const hits = [];
  for (const r of model.results) {
    if (r.competition_id === currentCompetition.competition_id) continue;
    if (!r.members.includes(person)) continue;
    const comp = model.competitions.get(r.competition_id);
    if (!comp) continue;
    const gapDays = (currentStart - Date.parse(comp.ends_at)) / DAY_MS;
    if (gapDays >= 0 && gapDays < minGapDays) {
      hits.push({ competition_id: comp.competition_id, name: comp.name, ends_at: comp.ends_at, gap_days: Number(gapDays.toFixed(2)) });
    }
  }
  return hits;
}

function recentLoadAvg(model, person, startIso, windowDays) {
  const list = model.loads.get(person);
  if (!list || list.length === 0) return null;
  const start = Date.parse(startIso);
  const from = start - windowDays * DAY_MS;
  const vals = list
    .filter((l) => {
      const t = Date.parse(l.metric_date);
      return t >= from && t <= start;
    })
    .map((l) => l.load_value);
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function checkConsecutiveRisk(model, competition, entries, rulesByKey) {
  const out = [];
  const seen = new Set();
  for (const entry of entries) {
    if (entry.role !== "competitor") continue;
    // 每个条目从默认值出发，套用该小项规则覆盖，避免配置跨条目累积
    const cfg = { ...DEFAULTS.consecutive };
    const body = ruleBodyFor(model, rulesByKey[`${entry.discipline}|${entry.event_code}`]);
    if (body?.consecutive) Object.assign(cfg, body.consecutive);
    for (const person of membersOf(model, entry)) {
      if (seen.has(person)) continue;
      seen.add(person);
      const hits = recentAppearances(model, person, competition, cfg.min_gap_days);
      if (hits.length === 0) continue;
      const avg = recentLoadAvg(model, person, competition.starts_at, cfg.load_window_days);
      const highLoad = avg != null && avg >= cfg.load_avg_threshold;
      out.push(
        finding(
          "consecutive_risk",
          highLoad ? "block" : "warn",
          person,
          null,
          highLoad
            ? `${person} 赛前 ${cfg.min_gap_days} 天内连续出场且近 ${cfg.load_window_days} 天负荷均值 ${avg.toFixed(1)} 偏高，连续作战风险高`
            : `${person} 赛前 ${cfg.min_gap_days} 天内有连续出场，需关注恢复`,
          {
            prior_appearances: hits,
            load_window_days: cfg.load_window_days,
            recent_load_avg: avg == null ? null : Number(avg.toFixed(2)),
            load_avg_threshold: cfg.load_avg_threshold,
          }
        )
      );
    }
  }
  return out;
}

// 3) 超额报名：超出资格席位剩余名额；以及规则限定的兼项数
function checkQuota(model, competition, entries, rulesByKey) {
  const out = [];
  const competitors = entries.filter((e) => e.role === "competitor");
  const groups = new Map();
  for (const e of competitors) {
    const key = `${e.discipline}|${e.event_code}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  for (const [key, count] of groups) {
    const [discipline, eventCode] = key.split("|");
    const slots = [...model.quotas.values()].filter(
      (q) =>
        q.discipline === discipline &&
        q.event_code === eventCode &&
        (q.competition_id == null || q.competition_id === competition.competition_id)
    );
    if (slots.length === 0) {
      out.push(
        finding("over_quota", "warn", null, eventCode, `小项 ${eventCode} 无资格席位记录，名额无法核对`, {
          discipline,
          entries: count,
        })
      );
      continue;
    }
    const capacity = slots.reduce((sum, q) => sum + Math.max(0, q.max_entries - q.entries_used), 0);
    if (count > capacity) {
      out.push(
        finding("over_quota", "block", null, eventCode, `小项 ${eventCode} 报名 ${count} 人，超过剩余席位 ${capacity} 个`, {
          discipline,
          entries: count,
          remaining_capacity: capacity,
          slots: slots.map((s) => ({ slot_id: s.slot_id, max_entries: s.max_entries, entries_used: s.entries_used, status: s.status })),
        })
      );
    }
  }
  // 兼项数限制（按项目规则体 max_events_per_athlete）
  const personEvents = new Map();
  for (const e of competitors) {
    for (const person of membersOf(model, e)) {
      const byDisc = personEvents.get(person) ?? new Map();
      const bag = byDisc.get(e.discipline) ?? new Set();
      bag.add(e.event_code);
      byDisc.set(e.discipline, bag);
      personEvents.set(person, byDisc);
    }
  }
  for (const [person, byDisc] of personEvents) {
    for (const [discipline, events] of byDisc) {
      const bodies = [...events]
        .map((ev) => ruleBodyFor(model, rulesByKey[`${discipline}|${ev}`]))
        .filter(Boolean);
      const limit = bodies.map((b) => b.max_events_per_athlete).find(Number.isInteger);
      if (Number.isInteger(limit) && events.size > limit) {
        out.push(
          finding("over_quota", "block", person, null, `${person} 在 ${discipline} 兼项 ${events.size} 个，超过规则上限 ${limit}`, {
            discipline,
            events: [...events],
            limit,
          })
        );
      }
    }
  }
  return out;
}

// 4) 规则不兼容：资格、级别存续、配对构成、伤病可用性
function checkRuleCompatibility(model, competition, entries, rulesByKey, asOf) {
  const out = [];
  for (const entry of entries) {
    const key = `${entry.discipline}|${entry.event_code}`;
    const snap = rulesByKey[key];
    const body = ruleBodyFor(model, snap);
    if (!snap || !body) {
      out.push(
        finding("rule_incompatible", "block", entry.subject_ref, entry.event_code,
          `时点 ${asOf} 前 ${entry.discipline}/${entry.event_code} 无生效规则版本，无法按规则报名`, { missing_rule: true })
      );
      continue;
    }

    // 小项在该规则版本中是否仍存在（举重新级别 / 乒乓球调整）
    const categories = body.event_codes ?? body.categories ?? body.weight_classes ?? null;
    if (Array.isArray(categories) && !categories.includes(entry.event_code)) {
      out.push(
        finding("rule_incompatible", "block", entry.subject_ref, entry.event_code,
          `${entry.event_code} 不在规则版本 ${snap.version} 的设项列表中（级别/项目调整后不兼容）`, {
            rule_id: snap.rule_id, version: snap.version, allowed: categories,
          })
      );
    }

    if (entry.entry_kind === "pair") {
      const pairing = model.pairings.get(entry.subject_ref);
      if (!pairing) {
        out.push(finding("rule_incompatible", "block", entry.subject_ref, entry.event_code,
          `组合 ${entry.subject_ref} 在事实记录中不存在`, { unknown_pairing: true }));
      } else {
        if (pairing.dissolved_at && Date.parse(pairing.dissolved_at) <= Date.parse(asOf)) {
          out.push(finding("rule_incompatible", "block", entry.subject_ref, entry.event_code,
            `组合 ${entry.subject_ref} 已于 ${pairing.dissolved_at} 解散`, { dissolved_at: pairing.dissolved_at }));
        }
        // 混双等性别/人数构成约束
        const composition = compositionFor(body, entry.event_code);
        if (composition && Array.isArray(composition.genders)) {
          const actual = pairing.members.map((m) => model.athletes.get(m)?.gender ?? null);
          const expected = composition.genders.slice().sort();
          const got = actual.slice().sort();
          if (expected.length !== got.length || expected.some((g, i) => g !== got[i])) {
            out.push(finding("rule_incompatible", "block", entry.subject_ref, entry.event_code,
              `${entry.event_code} 要求组合构成为 ${expected.join("+")}，实际 ${got.join("+")}`, {
                expected_genders: expected, actual_genders: actual,
              }));
          }
        }
        if (composition && Number.isInteger(composition.size) && pairing.members.length !== composition.size) {
          out.push(finding("rule_incompatible", "block", entry.subject_ref, entry.event_code,
            `${entry.event_code} 组合人数应为 ${composition.size}，实际 ${pairing.members.length}`, {
              expected_size: composition.size, actual_size: pairing.members.length,
            }));
        }
        if (pairing.is_new) {
          out.push(finding("rule_incompatible", "warn", entry.subject_ref, entry.event_code,
            `新组合 ${entry.subject_ref} 共同参赛记录将单独积累（不并入个人履历）`, { new_pairing: true }));
        }
      }
    }

    for (const person of membersOf(model, entry)) {
      const athlete = model.athletes.get(person);
      if (!athlete) {
        out.push(finding("rule_incompatible", "block", person, entry.event_code, `运动员 ${person} 无资格登记`, { unknown_athlete: true }));
        continue;
      }
      if (athlete.eligibility !== "eligible") {
        out.push(finding("rule_incompatible", "block", person, entry.event_code,
          `${person} 当前资格状态为 ${athlete.eligibility}，不具报名资格`, { eligibility: athlete.eligibility }));
      } else if (Array.isArray(athlete.eligible_for) && athlete.eligible_for.length > 0 && !athlete.eligible_for.includes(entry.event_code)) {
        out.push(finding("rule_incompatible", "block", person, entry.event_code,
          `${person} 的可报项目不含 ${entry.event_code}`, { eligible_for: athlete.eligible_for }));
      }
      const av = availabilityAt(model, person, asOf);
      if (av.status === "injured") {
        out.push(finding("rule_incompatible", "block", person, entry.event_code,
          `${person} 在评估时点处于伤停状态`, { availability: av.status, note_ref: av.window?.note_ref ?? null }));
      } else if (av.status === "restricted") {
        out.push(finding("rule_incompatible", "warn", person, entry.event_code,
          `${person} 在评估时点为限制参赛状态`, { availability: av.status, note_ref: av.window?.note_ref ?? null }));
      }
    }
  }
  return out;
}

export function validatePlan(model, { competition, entries, rules_snapshot, as_of }) {
  const findings = [];
  findings.push(...checkTimeConflicts(model, competition, entries));
  findings.push(...checkConsecutiveRisk(model, competition, entries, rules_snapshot));
  findings.push(...checkQuota(model, competition, entries, rules_snapshot));
  findings.push(...checkRuleCompatibility(model, competition, entries, rules_snapshot, as_of));
  const blocks = findings.filter((f) => f.severity === "block");
  return {
    as_of,
    rules_snapshot,
    findings,
    summary: {
      block_count: blocks.length,
      warn_count: findings.length - blocks.length,
      pass: blocks.length === 0,
    },
  };
}
