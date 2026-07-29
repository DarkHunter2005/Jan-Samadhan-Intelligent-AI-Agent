/**
 * Routing, SLA and escalation engine.
 *
 * Responsibilities:
 *  - turn an ML prediction into a concrete department + assigned officer
 *  - compute the SLA deadline from priority
 *  - decide whether a complaint is a duplicate of an existing one
 *  - sweep overdue complaints and walk them up the escalation ladder
 */
import { complaints, departments, history, users } from '../db/index.js';

/** Priority ordering used for comparisons and merges. */
export const PRIORITY_RANK = { low: 0, medium: 1, high: 2, critical: 3 };

/** SLA multiplier per priority level, applied to the department's base SLA. */
const SLA_FACTOR = { critical: 0.15, high: 0.4, medium: 1.0, low: 1.6 };

/** A duplicate is auto-merged only above this confidence; below it we just link. */
export const AUTO_MERGE_THRESHOLD = 0.72;

export function computeDueAt(slaHours, from = new Date()) {
  return new Date(from.getTime() + slaHours * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

export function slaHoursFor(departmentCode, priority, mlSuggestion) {
  if (Number.isFinite(mlSuggestion) && mlSuggestion > 0) return Math.round(mlSuggestion);
  const dept = departments.byCode(departmentCode);
  const base = dept?.sla_hours ?? 72;
  return Math.max(2, Math.round(base * (SLA_FACTOR[priority] ?? 1)));
}

/**
 * Decide the destination for a complaint from an ML prediction.
 * Returns department, officer assignment and the SLA deadline.
 */
export function routeComplaint(prediction) {
  const code = prediction.department_code || 'LSG';
  const dept = departments.byCode(code);
  const priority = prediction.priority || 'medium';
  const slaHours = slaHoursFor(code, priority, prediction.sla_hours);

  // Low-confidence predictions are not auto-assigned: a human triages them first,
  // otherwise a wrong guess silently consumes an officer's SLA clock.
  const assignee = prediction.needs_human_review ? null : users.leastLoadedOfficer(code);

  return {
    department_code: code,
    department_name: dept?.name || prediction.department || 'Local Self Government',
    assigned_to: assignee?.id ?? null,
    status: prediction.needs_human_review ? 'submitted' : 'routed',
    sla_hours: slaHours,
    due_at: computeDueAt(slaHours),
    escalation_chain: dept ? JSON.parse(dept.escalation_json) : (prediction.escalation_chain || []),
  };
}

/**
 * Evaluate the ML duplicate result against business rules.
 *
 * We deliberately do NOT auto-close a merely "similar" complaint: citizens must not
 * lose their ticket to a false positive. Only very high confidence auto-merges;
 * everything else is recorded as a related link plus repeat pressure.
 */
export function resolveDuplicate(prediction) {
  const dup = prediction.duplicate || {};
  const best = dup.matches?.[0];
  if (!best || !dup.is_duplicate) {
    return { duplicate_of: null, duplicate_score: dup.best_score ?? 0, merge: false,
             repeat_count: dup.repeat_count ?? 0 };
  }
  const merge = best.score >= AUTO_MERGE_THRESHOLD;
  return {
    duplicate_of: best.id,
    duplicate_score: best.score,
    merge,
    repeat_count: dup.repeat_count ?? 0,
  };
}

/**
 * When a duplicate is merged into a parent, the parent inherits the pressure:
 * its repeat counter grows and its priority can only ever go up, never down.
 */
export function absorbIntoParent(parentId, childPriority, actorId) {
  const parent = complaints.byId(parentId);
  if (!parent) return null;

  const newRepeat = (parent.repeat_count || 0) + 1;
  const shouldEscalate =
    (PRIORITY_RANK[childPriority] ?? 1) > (PRIORITY_RANK[parent.priority] ?? 1);
  const newPriority = shouldEscalate ? childPriority : parent.priority;

  const fields = { repeat_count: newRepeat };
  if (shouldEscalate) {
    fields.priority = newPriority;
    const hours = slaHoursFor(parent.department_code, newPriority);
    fields.sla_hours = hours;
    fields.due_at = computeDueAt(hours, new Date(parent.created_at.replace(' ', 'T') + 'Z'));
  }
  complaints.update(parentId, fields);

  history.add({
    complaint_id: parentId,
    from_status: parent.status,
    to_status: parent.status,
    note: `Another citizen reported the same issue (total reports: ${newRepeat + 1})` +
          (shouldEscalate ? `. Priority raised to ${newPriority}.` : '.'),
    actor_id: actorId ?? null,
    actor_role: 'system',
  });

  return { repeat_count: newRepeat, priority: newPriority, escalated: shouldEscalate };
}

/**
 * SLA sweeper: escalate every overdue complaint one rung up its department ladder.
 * Returns the list of complaints that were escalated.
 */
export function runEscalationSweep() {
  const overdue = complaints.overdue();
  const escalated = [];

  for (const c of overdue) {
    const dept = departments.byCode(c.department_code);
    const chain = dept ? JSON.parse(dept.escalation_json) : [];
    const nextLevel = (c.escalation_level || 0) + 1;

    // Already at the top of the ladder: keep it flagged but stop climbing.
    if (nextLevel >= chain.length) {
      if (c.escalation_level < chain.length) {
        complaints.update(c.id, { escalation_level: chain.length });
      }
      continue;
    }

    // Each escalation also buys a fresh, shorter SLA window at the higher authority.
    const extraHours = Math.max(4, Math.round((c.sla_hours || 48) * 0.5));
    complaints.update(c.id, {
      escalation_level: nextLevel,
      escalated_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
      due_at: computeDueAt(extraHours),
      priority: PRIORITY_RANK[c.priority] >= PRIORITY_RANK.high ? c.priority
               : nextLevel >= 2 ? 'high' : c.priority,
    });

    history.add({
      complaint_id: c.id,
      from_status: c.status,
      to_status: c.status,
      note: `SLA breached. Escalated to ${chain[nextLevel]} (level ${nextLevel}).`,
      actor_id: null,
      actor_role: 'system',
    });

    escalated.push({ id: c.id, level: nextLevel, authority: chain[nextLevel] });
  }

  return escalated;
}

/** Human-readable current authority for a complaint. */
export function currentAuthority(complaint) {
  const dept = departments.byCode(complaint.department_code);
  if (!dept) return null;
  const chain = JSON.parse(dept.escalation_json);
  return chain[Math.min(complaint.escalation_level || 0, chain.length - 1)] ?? null;
}
