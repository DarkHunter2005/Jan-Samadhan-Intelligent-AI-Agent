import express from 'express';
import bcrypt from 'bcryptjs';
import { nanoid } from 'nanoid';
import { complaints, departments, users } from '../db/index.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { runEscalationSweep } from '../services/routing.js';
import * as ml from '../services/mlClient.js';

const router = express.Router();

/** Dashboard analytics. */
router.get('/stats', authenticate(), requireRole('officer', 'admin'), (req, res) => {
  const stats = complaints.stats();
  if (req.user.role === 'officer') {
    // Officers only see their own department's slice.
    stats.byDepartment = stats.byDepartment.filter((d) => d.code === req.user.department);
  }
  return res.json(stats);
});

router.get('/departments', (req, res) => {
  res.json({
    departments: departments.all().map((d) => ({
      code: d.code,
      name: d.name,
      category_key: d.category_key,
      sla_hours: d.sla_hours,
      escalation_chain: JSON.parse(d.escalation_json),
    })),
  });
});

router.get('/officers', authenticate(), requireRole('admin'), (req, res) => {
  res.json({ officers: users.listOfficers(req.query.department ?? null) });
});

/** Create an officer/admin account (admins only — self-registration cannot do this). */
router.post('/users', authenticate(), requireRole('admin'), (req, res) => {
  const { name, email, password, role, department, phone } = req.body ?? {};
  if (!name || !email || !password || !role) {
    return res.status(400).json({ error: 'name, email, password and role are required' });
  }
  if (!['officer', 'admin'].includes(role)) {
    return res.status(400).json({ error: 'role must be "officer" or "admin"' });
  }
  if (role === 'officer' && !departments.byCode(department)) {
    return res.status(400).json({ error: 'officers require a valid department code' });
  }
  if (users.byEmail(email)) return res.status(409).json({ error: 'email already registered' });
  if (String(password).length < 8) {
    return res.status(400).json({ error: 'password must be at least 8 characters' });
  }

  const user = {
    id: `USR-${nanoid(10)}`,
    name,
    email: String(email).toLowerCase(),
    phone: phone ?? null,
    password_hash: bcrypt.hashSync(password, 10),
    role,
    department: role === 'officer' ? department : null,
    locality: null,
  };
  users.create(user);
  return res.status(201).json({
    user: { id: user.id, name, email: user.email, role, department: user.department },
  });
});

/** Manually trigger the SLA escalation sweep (also runs on a timer). */
router.post('/escalate', authenticate(), requireRole('admin'), (req, res) => {
  const escalated = runEscalationSweep();
  res.json({ escalated_count: escalated.length, escalated });
});

/** Health of the ML dependency, surfaced in the admin dashboard. */
router.get('/ml-health', authenticate(), requireRole('officer', 'admin'), async (req, res) => {
  res.json(await ml.health());
});

export default router;
