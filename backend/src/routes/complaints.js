/**
 * Complaint lifecycle routes.
 *
 * Submission flow (the pipeline described in the project brief):
 *   React form -> POST /api/complaints
 *     -> gather duplicate candidates from the DB
 *     -> call the Python ML service (/predict)
 *     -> persist complaint + full prediction payload
 *     -> route to department, assign officer, set SLA deadline
 *     -> return tracking id + explanation to the citizen
 */
import express from 'express';
import { customAlphabet, nanoid } from 'nanoid';
import { config } from '../config.js';
import { complaints, departments, history, users } from '../db/index.js';
import { assertDepartmentAccess, authenticate, requireRole } from '../middleware/auth.js';
import { schemas, validate } from '../middleware/validate.js';
import * as ml from '../services/mlClient.js';
import {
  absorbIntoParent,
  currentAuthority,
  resolveDuplicate,
  routeComplaint,
  slaHoursFor,
  computeDueAt,
} from '../services/routing.js';

const router = express.Router();

/**
 * Citizen-friendly tracking id, e.g. GRV-2026-4F7K2P.
 * The alphabet excludes 0/O/1/I and punctuation so the code can be read aloud
 * over the phone or copied from a printed acknowledgement without ambiguity.
 */
const trackingCode = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 6);

function trackingId() {
  return `GRV-${new Date().getFullYear()}-${trackingCode()}`;
}

/** Shapes a DB row for API responses (parses the stored ML payload). */
function present(row, { includeMl = false } = {}) {
  if (!row) return null;
  const { ml_json, ...rest } = row;
  const out = {
    ...rest,
    needs_review: Boolean(row.needs_review),
    current_authority: currentAuthority(row),
    is_overdue:
      row.due_at != null &&
      !['resolved', 'rejected', 'duplicate'].includes(row.status) &&
      new Date(row.due_at.replace(' ', 'T') + 'Z') < new Date(),
  };
  if (includeMl && ml_json) {
    try { out.ml = JSON.parse(ml_json); } catch { /* ignore malformed payload */ }
  }
  return out;
}

// ---------------------------------------------------------------------------
// POST /api/complaints  - submit a complaint (auth optional: walk-in support)
// ---------------------------------------------------------------------------
router.post(
  '/',
  authenticate(false),
  validate(schemas.createComplaint),
  async (req, res, next) => {
    try {
      const { text, locality, address, language, citizen_name, citizen_phone } = req.body;

      // Anonymous submissions must carry a callback name/phone so the department
      // can actually reach the complainant.
      if (!req.user && !citizen_phone && !citizen_name) {
        return res.status(400).json({
          error: 'provide citizen_name and citizen_phone, or log in before submitting',
        });
      }

      const submitter = req.user ? users.byId(req.user.id) : null;
      const effectiveLocality = locality || submitter?.locality || null;

      // 1. Candidate pool for duplicate detection: recent open complaints nearby.
      const candidates = complaints.duplicateCandidates({
        locality: effectiveLocality,
        limit: config.ml.duplicateCandidateLimit,
      });

      // 2. Ask the ML service for category, priority and duplicates.
      const prediction = await ml.predict({
        text,
        locality: effectiveLocality,
        language,
        candidates: candidates.map((c) => ({
          id: c.id, text: c.text, category: c.category,
          locality: c.locality, status: c.status,
        })),
      });

      // 3. Duplicate decision + routing decision.
      const dup = resolveDuplicate(prediction);
      const route = routeComplaint(prediction);

      const id = trackingId();
      const isMerged = dup.merge && dup.duplicate_of;

      complaints.insert({
        id,
        user_id: submitter?.id ?? null,
        citizen_name: citizen_name || submitter?.name || null,
        citizen_phone: citizen_phone || submitter?.phone || null,
        text,
        language: language ?? null,
        locality: effectiveLocality,
        address: address ?? null,

        category: prediction.category,
        category_label: prediction.category_label,
        confidence: prediction.confidence,
        department_code: route.department_code,
        department_name: route.department_name,
        priority: prediction.priority,
        priority_score: prediction.priority_score,
        urgency: prediction.urgency,
        severity_score: prediction.severity_score ?? null,
        sla_hours: route.sla_hours,
        ml_json: JSON.stringify(prediction),
        needs_review: prediction.needs_human_review ? 1 : 0,

        duplicate_of: dup.duplicate_of,
        duplicate_score: dup.duplicate_score,
        repeat_count: dup.repeat_count,

        // A merged duplicate is parked as 'duplicate'; it is still tracked and
        // visible to the citizen, but the parent ticket carries the work.
        status: isMerged ? 'duplicate' : route.status,
        assigned_to: isMerged ? null : route.assigned_to,
        due_at: isMerged ? null : route.due_at,
      });

      history.add({
        complaint_id: id,
        from_status: null,
        to_status: isMerged ? 'duplicate' : route.status,
        note: isMerged
          ? `Detected as a duplicate of ${dup.duplicate_of} (similarity ${(dup.duplicate_score * 100).toFixed(0)}%).`
          : `Auto-classified as "${prediction.category_label}" (${(prediction.confidence * 100).toFixed(0)}% confidence) ` +
            `and routed to ${route.department_name}. Priority: ${prediction.priority}.` +
            (prediction.needs_human_review ? ' Flagged for human triage.' : ''),
        actor_id: submitter?.id ?? null,
        actor_role: 'system',
      });

      let parentUpdate = null;
      if (isMerged) parentUpdate = absorbIntoParent(dup.duplicate_of, prediction.priority, submitter?.id);

      const saved = complaints.byId(id);
      return res.status(201).json({
        complaint: present(saved, { includeMl: true }),
        tracking_id: id,
        duplicate: {
          merged: Boolean(isMerged),
          parent_id: dup.duplicate_of,
          score: dup.duplicate_score,
          parent_update: parentUpdate,
          related: prediction.duplicate?.matches?.slice(0, 3) ?? [],
        },
        routing: {
          department: route.department_name,
          department_code: route.department_code,
          authority: route.escalation_chain?.[0] ?? null,
          sla_hours: route.sla_hours,
          due_at: saved.due_at,
        },
        explanation: {
          category: prediction.category_label,
          confidence: prediction.confidence,
          alternatives: prediction.alternatives ?? [],
          priority: prediction.priority,
          priority_score: prediction.priority_score,
          reasons: prediction.priority_reasons ?? [],
          urgency: prediction.urgency,
          degraded: Boolean(prediction.degraded),
        },
      });
    } catch (err) {
      return next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/complaints/track/:id  - public status lookup by tracking id
// ---------------------------------------------------------------------------
router.get('/track/:id', (req, res) => {
  const row = complaints.byId(req.params.id);
  if (!row) return res.status(404).json({ error: 'no complaint found with that tracking id' });

  // Public endpoint: expose progress, never personal contact details.
  const c = present(row);
  return res.json({
    complaint: {
      id: c.id, text: c.text, status: c.status, priority: c.priority,
      category_label: c.category_label, department_name: c.department_name,
      locality: c.locality, created_at: c.created_at, updated_at: c.updated_at,
      due_at: c.due_at, resolved_at: c.resolved_at, resolution_note: c.resolution_note,
      escalation_level: c.escalation_level, current_authority: c.current_authority,
      is_overdue: c.is_overdue, duplicate_of: c.duplicate_of, repeat_count: c.repeat_count,
    },
    history: history.forComplaint(c.id).map((h) => ({
      to_status: h.to_status, note: h.note, at: h.created_at, by: h.actor_role,
    })),
  });
});

// ---------------------------------------------------------------------------
// GET /api/complaints/mine  - the logged-in citizen's complaints
// ---------------------------------------------------------------------------
router.get('/mine', authenticate(), validate(schemas.listQuery, 'query'), (req, res) => {
  const q = req.validatedQuery;
  const { rows, total } = complaints.search({
    userId: req.user.id,
    status: q.status ?? null,
    limit: q.pageSize,
    offset: (q.page - 1) * q.pageSize,
    sort: q.sort,
    order: q.order,
  });
  return res.json({
    complaints: rows.map((r) => present(r)),
    page: q.page, pageSize: q.pageSize, total,
  });
});

// ---------------------------------------------------------------------------
// GET /api/complaints  - dashboard listing (officer/admin)
// ---------------------------------------------------------------------------
router.get(
  '/',
  authenticate(),
  requireRole('officer', 'admin'),
  validate(schemas.listQuery, 'query'),
  (req, res) => {
    const q = req.validatedQuery;
    // Officers are hard-scoped to their own department regardless of the filter sent.
    const department = req.user.role === 'officer' ? req.user.department : (q.department ?? null);

    const { rows, total } = complaints.search({
      status: q.status ?? null,
      department,
      priority: q.priority ?? null,
      category: q.category ?? null,
      locality: q.locality ?? null,
      assignedTo: q.assignedTo ?? null,
      needsReview: q.needsReview ?? null,
      overdueOnly: q.overdue === '1',
      q: q.q ?? null,
      limit: q.pageSize,
      offset: (q.page - 1) * q.pageSize,
      sort: q.sort,
      order: q.order,
    });

    return res.json({
      complaints: rows.map((r) => present(r)),
      page: q.page, pageSize: q.pageSize, total,
      scoped_department: department,
    });
  }
);

// ---------------------------------------------------------------------------
// GET /api/complaints/:id  - full detail (owner, dept officer, or admin)
// ---------------------------------------------------------------------------
router.get('/:id', authenticate(), (req, res) => {
  const row = complaints.byId(req.params.id);
  if (!row) return res.status(404).json({ error: 'complaint not found' });
  if (!assertDepartmentAccess(req.user, row)) {
    return res.status(403).json({ error: 'you do not have access to this complaint' });
  }
  return res.json({
    complaint: present(row, { includeMl: true }),
    history: history.forComplaint(row.id),
    officers: req.user.role === 'admin' || req.user.role === 'officer'
      ? users.listOfficers(row.department_code)
      : undefined,
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/complaints/:id/status  - officer/admin status transitions
// ---------------------------------------------------------------------------
const ALLOWED_TRANSITIONS = {
  submitted:   ['routed', 'in_progress', 'rejected', 'duplicate'],
  routed:      ['in_progress', 'resolved', 'rejected', 'duplicate'],
  in_progress: ['resolved', 'rejected', 'routed'],
  reopened:    ['in_progress', 'resolved', 'rejected'],
  resolved:    ['reopened'],
  rejected:    ['reopened'],
  duplicate:   ['routed', 'reopened'],
};

router.patch(
  '/:id/status',
  authenticate(),
  requireRole('officer', 'admin'),
  validate(schemas.updateStatus),
  (req, res) => {
    const row = complaints.byId(req.params.id);
    if (!row) return res.status(404).json({ error: 'complaint not found' });
    if (!assertDepartmentAccess(req.user, row)) {
      return res.status(403).json({ error: 'this complaint belongs to another department' });
    }

    const { status, note } = req.body;
    const allowed = ALLOWED_TRANSITIONS[row.status] ?? [];
    if (status !== row.status && !allowed.includes(status)) {
      return res.status(409).json({
        error: `cannot move a complaint from "${row.status}" to "${status}"`,
        allowed_transitions: allowed,
      });
    }
    // Closing a ticket must be accountable: an explanation is mandatory.
    if (['resolved', 'rejected'].includes(status) && !note) {
      return res.status(400).json({ error: `a note is required when marking a complaint ${status}` });
    }

    const fields = { status };
    if (status === 'resolved') {
      fields.resolved_at = new Date().toISOString().replace('T', ' ').slice(0, 19);
      fields.resolution_note = note;
    }
    if (status === 'reopened') {
      // Reopening restarts the SLA clock at the current priority.
      const hours = slaHoursFor(row.department_code, row.priority, null);
      fields.resolved_at = null;
      fields.due_at = computeDueAt(hours);
      fields.sla_hours = hours;
    }
    complaints.update(row.id, fields);

    history.add({
      complaint_id: row.id,
      from_status: row.status,
      to_status: status,
      note: note ?? null,
      actor_id: req.user.id,
      actor_role: req.user.role,
    });

    return res.json({ complaint: present(complaints.byId(row.id)) });
  }
);

// ---------------------------------------------------------------------------
// PATCH /api/complaints/:id/assign  - correct the ML routing (admin only)
// ---------------------------------------------------------------------------
router.patch(
  '/:id/assign',
  authenticate(),
  requireRole('admin'),
  validate(schemas.reassign),
  (req, res) => {
    const row = complaints.byId(req.params.id);
    if (!row) return res.status(404).json({ error: 'complaint not found' });

    const { department_code, assigned_to, priority, note } = req.body;
    const fields = {};
    const changes = [];

    if (department_code && department_code !== row.department_code) {
      const dept = departments.byCode(department_code);
      if (!dept) return res.status(400).json({ error: `unknown department: ${department_code}` });
      fields.department_code = dept.code;
      fields.department_name = dept.name;
      fields.assigned_to = null;              // previous officer no longer owns it
      fields.escalation_level = 0;            // new ladder, restart escalation
      changes.push(`department -> ${dept.name}`);
    }

    if (assigned_to !== undefined) {
      if (assigned_to) {
        const officer = users.byId(assigned_to);
        const targetDept = fields.department_code || row.department_code;
        if (!officer || officer.role !== 'officer') {
          return res.status(400).json({ error: 'assigned_to must be a valid officer id' });
        }
        if (officer.department !== targetDept) {
          return res.status(400).json({
            error: `officer ${officer.name} belongs to ${officer.department}, not ${targetDept}`,
          });
        }
        changes.push(`assigned to ${officer.name}`);
      }
      fields.assigned_to = assigned_to;
    }

    if (priority && priority !== row.priority) {
      const hours = slaHoursFor(fields.department_code || row.department_code, priority, null);
      fields.priority = priority;
      fields.sla_hours = hours;
      fields.due_at = computeDueAt(hours);
      changes.push(`priority -> ${priority}`);
    }

    if (!Object.keys(fields).length) {
      return res.status(400).json({ error: 'nothing to update' });
    }

    // A manual correction means a human has now verified the routing.
    fields.needs_review = 0;
    if (row.status === 'submitted') fields.status = 'routed';

    complaints.update(row.id, fields);
    history.add({
      complaint_id: row.id,
      from_status: row.status,
      to_status: fields.status ?? row.status,
      note: `Manual correction by ${req.user.name}: ${changes.join(', ')}.` + (note ? ` ${note}` : ''),
      actor_id: req.user.id,
      actor_role: req.user.role,
    });

    return res.json({ complaint: present(complaints.byId(row.id)) });
  }
);

// ---------------------------------------------------------------------------
// POST /api/complaints/:id/feedback  - citizen rates the resolution
// ---------------------------------------------------------------------------
router.post('/:id/feedback', authenticate(), validate(schemas.feedback), (req, res) => {
  const row = complaints.byId(req.params.id);
  if (!row) return res.status(404).json({ error: 'complaint not found' });
  if (row.user_id !== req.user.id) {
    return res.status(403).json({ error: 'only the complainant can rate this complaint' });
  }
  if (row.status !== 'resolved') {
    return res.status(409).json({ error: 'feedback can only be given once the complaint is resolved' });
  }

  complaints.update(row.id, { citizen_rating: req.body.rating });
  history.add({
    complaint_id: row.id,
    from_status: row.status,
    to_status: row.status,
    note: `Citizen rated the resolution ${req.body.rating}/5.` + (req.body.note ? ` "${req.body.note}"` : ''),
    actor_id: req.user.id,
    actor_role: 'citizen',
  });

  return res.json({ complaint: present(complaints.byId(row.id)) });
});

export default router;
