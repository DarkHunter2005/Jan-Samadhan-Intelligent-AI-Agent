/**
 * Unit tests for the routing / SLA / escalation engine.
 * Run with: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Point the DB at a throwaway file BEFORE importing anything that opens it.
process.env.DB_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'grv-')), 'test.db');
process.env.ESCALATION_INTERVAL_MS = '0';

const { complaints, departments, history, users, db } = await import('../src/db/index.js');
const {
  PRIORITY_RANK, absorbIntoParent, computeDueAt, currentAuthority,
  resolveDuplicate, routeComplaint, runEscalationSweep, slaHoursFor,
} = await import('../src/services/routing.js');
const { fallbackPredict } = await import('../src/services/mlClient.js');

departments.upsert({
  code: 'KWA', name: 'Kerala Water Authority', category_key: 'water_supply', sla_hours: 48,
  escalation_json: JSON.stringify(['Ward Officer', 'Assistant Engineer', 'Executive Engineer', 'District Collector']),
});
departments.upsert({
  code: 'KSEB', name: 'State Electricity Board', category_key: 'electricity', sla_hours: 24,
  escalation_json: JSON.stringify(['Section Officer', 'Assistant Engineer', 'Executive Engineer']),
});

users.create({
  id: 'USR-OFF1', name: 'Officer One', email: 'off1@gov.in', phone: null,
  password_hash: 'x', role: 'officer', department: 'KWA', locality: 'Erattupetta',
});

let seq = 0;
/**
 * Insert a complaint for testing.
 * `escalation_level` is not an insert column (new complaints always start at 0),
 * so it is applied afterwards via update to simulate an already-escalated ticket.
 */
const makeComplaint = (over = {}) => {
  const id = over.id ?? `GRV-T-${++seq}`;
  const { escalation_level, ...insertable } = over;
  complaints.insert({
    id, user_id: null, citizen_name: 'C', citizen_phone: '9', text: 'test complaint text',
    language: 'en', locality: 'Erattupetta', address: null,
    category: 'water_supply', category_label: 'Water Supply', confidence: 0.9,
    department_code: 'KWA', department_name: 'Kerala Water Authority',
    priority: 'medium', priority_score: 40, urgency: 'routine', severity_score: 0.2,
    sla_hours: 48, ml_json: '{}', needs_review: 0,
    duplicate_of: null, duplicate_score: 0, repeat_count: 0,
    status: 'routed', assigned_to: null, due_at: computeDueAt(48),
    ...insertable,
  });
  if (escalation_level !== undefined) complaints.update(id, { escalation_level });
  return complaints.byId(id);
};

// ---------------------------------------------------------------------------
test('SLA compresses with higher priority', () => {
  const critical = slaHoursFor('KWA', 'critical', null);
  const high = slaHoursFor('KWA', 'high', null);
  const medium = slaHoursFor('KWA', 'medium', null);
  const low = slaHoursFor('KWA', 'low', null);
  assert.ok(critical < high, 'critical must be tighter than high');
  assert.ok(high < medium, 'high must be tighter than medium');
  assert.ok(medium < low, 'low priority gets the most slack');
  assert.ok(critical >= 2, 'never below the 2h floor');
});

test('SLA falls back to a sane default for unknown departments', () => {
  assert.ok(slaHoursFor('NOPE', 'medium', null) > 0);
});

test('explicit ML SLA suggestion wins', () => {
  assert.equal(slaHoursFor('KWA', 'medium', 7), 7);
});

test('routeComplaint assigns an officer for confident predictions', () => {
  const r = routeComplaint({
    department_code: 'KWA', priority: 'high', sla_hours: 20,
    needs_human_review: false, escalation_chain: [],
  });
  assert.equal(r.department_code, 'KWA');
  assert.equal(r.status, 'routed');
  assert.equal(r.assigned_to, 'USR-OFF1');
  assert.ok(r.due_at);
});

test('low-confidence predictions are held for human triage, not auto-assigned', () => {
  const r = routeComplaint({
    department_code: 'KWA', priority: 'medium', needs_human_review: true, escalation_chain: [],
  });
  assert.equal(r.status, 'submitted');
  assert.equal(r.assigned_to, null, 'must not burn an officer SLA on a guess');
});

test('unknown department falls back to local self government', () => {
  const r = routeComplaint({ department_code: null, priority: 'low', needs_human_review: false });
  assert.equal(r.department_code, 'LSG');
});

// ---------------------------------------------------------------------------
test('resolveDuplicate ignores weak similarity', () => {
  const r = resolveDuplicate({ duplicate: { is_duplicate: false, best_score: 0.2, matches: [] } });
  assert.equal(r.duplicate_of, null);
  assert.equal(r.merge, false);
});

test('resolveDuplicate links but does not auto-merge borderline matches', () => {
  const r = resolveDuplicate({
    duplicate: { is_duplicate: true, best_score: 0.6, repeat_count: 1,
                 matches: [{ id: 'GRV-X', score: 0.6 }] },
  });
  assert.equal(r.duplicate_of, 'GRV-X');
  assert.equal(r.merge, false, 'a citizen must not lose their ticket to a borderline match');
});

test('resolveDuplicate auto-merges very high similarity', () => {
  const r = resolveDuplicate({
    duplicate: { is_duplicate: true, best_score: 0.95, repeat_count: 2,
                 matches: [{ id: 'GRV-Y', score: 0.95 }] },
  });
  assert.equal(r.merge, true);
  assert.equal(r.repeat_count, 2);
});

// ---------------------------------------------------------------------------
test('absorbIntoParent raises repeat count and never lowers priority', () => {
  const parent = makeComplaint({ priority: 'high', priority_score: 65 });
  const first = absorbIntoParent(parent.id, 'low', null);
  assert.equal(first.repeat_count, 1);
  assert.equal(first.priority, 'high', 'a low-priority duplicate must not downgrade the parent');

  const second = absorbIntoParent(parent.id, 'critical', null);
  assert.equal(second.repeat_count, 2);
  assert.equal(second.priority, 'critical', 'a more severe duplicate escalates the parent');
  assert.equal(complaints.byId(parent.id).priority, 'critical');
});

test('absorbIntoParent records an audit entry', () => {
  const parent = makeComplaint();
  const before = history.forComplaint(parent.id).length;
  absorbIntoParent(parent.id, 'medium', null);
  assert.equal(history.forComplaint(parent.id).length, before + 1);
});

test('absorbIntoParent tolerates a missing parent', () => {
  assert.equal(absorbIntoParent('GRV-DOES-NOT-EXIST', 'high', null), null);
});

// ---------------------------------------------------------------------------
test('escalation sweep promotes overdue complaints one rung at a time', () => {
  const c = makeComplaint({ due_at: '2020-01-01 00:00:00', escalation_level: 0 });
  const escalated = runEscalationSweep();
  const mine = escalated.find((e) => e.id === c.id);
  assert.ok(mine, 'overdue complaint should escalate');
  assert.equal(mine.level, 1);
  assert.equal(mine.authority, 'Assistant Engineer');

  const after = complaints.byId(c.id);
  assert.equal(after.escalation_level, 1);
  assert.ok(after.escalated_at);
  assert.ok(after.due_at > '2020-01-01', 'escalation grants a fresh deadline');
});

test('escalation stops at the top of the ladder', () => {
  const c = makeComplaint({ due_at: '2020-01-01 00:00:00', escalation_level: 3 });
  runEscalationSweep();
  const after = complaints.byId(c.id);
  assert.equal(after.escalation_level, 4, 'capped at chain length, not beyond');
  const again = runEscalationSweep();
  assert.ok(!again.find((e) => e.id === c.id), 'no further escalation once at the top');
});

test('resolved complaints are never escalated', () => {
  const c = makeComplaint({ due_at: '2020-01-01 00:00:00', status: 'resolved' });
  const escalated = runEscalationSweep();
  assert.ok(!escalated.find((e) => e.id === c.id));
});

test('complaints inside their SLA window are not escalated', () => {
  const c = makeComplaint({ due_at: computeDueAt(72) });
  const escalated = runEscalationSweep();
  assert.ok(!escalated.find((e) => e.id === c.id));
});

test('repeated escalation raises priority to high', () => {
  const c = makeComplaint({ due_at: '2020-01-01 00:00:00', priority: 'low', escalation_level: 1 });
  runEscalationSweep();
  assert.equal(complaints.byId(c.id).priority, 'high');
});

test('currentAuthority reflects the escalation level', () => {
  const c = makeComplaint({ escalation_level: 2 });
  assert.equal(currentAuthority(complaints.byId(c.id)), 'Executive Engineer');
});

// ---------------------------------------------------------------------------
test('officer load balancing picks the least busy officer', () => {
  users.create({
    id: 'USR-OFF2', name: 'Officer Two', email: 'off2@gov.in', phone: null,
    password_hash: 'x', role: 'officer', department: 'KWA', locality: 'Erattupetta',
  });
  // Give officer one a heavy open workload.
  for (let i = 0; i < 3; i += 1) makeComplaint({ assigned_to: 'USR-OFF1', status: 'in_progress' });
  assert.equal(users.leastLoadedOfficer('KWA').id, 'USR-OFF2');
});

// ---------------------------------------------------------------------------
test('fallback classifier keeps working when the ML service is down', () => {
  const r = fallbackPredict('No water supply in our ward for 10 days', 'Erattupetta');
  assert.equal(r.category, 'water_supply');
  assert.equal(r.department_code, 'KWA');
  assert.equal(r.needs_human_review, true, 'degraded results must be human-checked');
  assert.equal(r.degraded, true);
});

test('fallback classifier detects urgency keywords', () => {
  const urgent = fallbackPredict('URGENT emergency fire, people injured immediately', 'X');
  assert.equal(urgent.priority, 'high');
});

test('fallback classifier degrades gracefully on unknown text', () => {
  const r = fallbackPredict('asdf qwerty zxcv', 'X');
  assert.ok(r.category, 'must still return a routable category');
  assert.equal(r.needs_human_review, true);
});

// ---------------------------------------------------------------------------
test('stats aggregate correctly', () => {
  const s = complaints.stats();
  assert.ok(s.totals.total > 0);
  assert.ok(Array.isArray(s.byStatus));
  assert.ok(Array.isArray(s.byDepartment));
  assert.ok(Array.isArray(s.trend));
});

test('search filters and paginates', () => {
  const { rows, total } = complaints.search({ department: 'KWA', limit: 2, offset: 0 });
  assert.ok(rows.length <= 2);
  assert.ok(total >= rows.length);
  assert.ok(rows.every((r) => r.department_code === 'KWA'));
});

test('duplicate candidate pool excludes closed complaints', () => {
  makeComplaint({ id: 'GRV-CLOSED', status: 'resolved' });
  const pool = complaints.duplicateCandidates({ locality: 'Erattupetta', limit: 50 });
  assert.ok(!pool.find((c) => c.id === 'GRV-CLOSED'));
});

test('PRIORITY_RANK orders levels correctly', () => {
  assert.ok(PRIORITY_RANK.low < PRIORITY_RANK.medium);
  assert.ok(PRIORITY_RANK.medium < PRIORITY_RANK.high);
  assert.ok(PRIORITY_RANK.high < PRIORITY_RANK.critical);
});

test.after(() => db.close());
