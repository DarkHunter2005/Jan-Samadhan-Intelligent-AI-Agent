/**
 * Persistence layer.
 *
 * Every SQL statement in the application lives in this module. Routes and services
 * only ever call the exported repository functions, so migrating to PostgreSQL or
 * MongoDB is a matter of reimplementing this single file against the same contract.
 *
 * SQLite is used here because it needs no external daemon, making the whole stack
 * runnable with `npm start`.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config.js';

fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });

export const db = new Database(config.dbFile);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// --------------------------------------------------------------------------
// Schema
// --------------------------------------------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  phone         TEXT,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('citizen','officer','admin')),
  department    TEXT,                       -- department code for officers
  locality      TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS departments (
  code            TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  category_key    TEXT NOT NULL,
  sla_hours       INTEGER NOT NULL,
  escalation_json TEXT NOT NULL             -- JSON array: authority ladder
);

CREATE TABLE IF NOT EXISTS complaints (
  id                TEXT PRIMARY KEY,       -- human-readable tracking id
  user_id           TEXT REFERENCES users(id),
  citizen_name      TEXT,
  citizen_phone     TEXT,
  text              TEXT NOT NULL,
  language          TEXT,
  locality          TEXT,
  address           TEXT,

  -- ML output
  category          TEXT,
  category_label    TEXT,
  confidence        REAL,
  department_code   TEXT,
  department_name   TEXT,
  priority          TEXT,
  priority_score    REAL,
  urgency           TEXT,
  severity_score    REAL,
  sla_hours         INTEGER,
  ml_json           TEXT,                   -- full prediction payload for audit
  needs_review      INTEGER NOT NULL DEFAULT 0,

  -- duplicate handling
  duplicate_of      TEXT REFERENCES complaints(id),
  duplicate_score   REAL,
  repeat_count      INTEGER NOT NULL DEFAULT 0,

  -- workflow
  status            TEXT NOT NULL DEFAULT 'submitted'
                    CHECK (status IN ('submitted','routed','in_progress','resolved','rejected','duplicate','reopened')),
  assigned_to       TEXT REFERENCES users(id),
  escalation_level  INTEGER NOT NULL DEFAULT 0,
  escalated_at      TEXT,
  due_at            TEXT,
  resolved_at       TEXT,
  resolution_note   TEXT,
  citizen_rating    INTEGER,

  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS status_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  complaint_id TEXT NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status   TEXT NOT NULL,
  note        TEXT,
  actor_id    TEXT REFERENCES users(id),
  actor_role  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_complaints_status     ON complaints(status);
CREATE INDEX IF NOT EXISTS idx_complaints_dept       ON complaints(department_code);
CREATE INDEX IF NOT EXISTS idx_complaints_user       ON complaints(user_id);
CREATE INDEX IF NOT EXISTS idx_complaints_locality   ON complaints(locality);
CREATE INDEX IF NOT EXISTS idx_complaints_due        ON complaints(due_at);
CREATE INDEX IF NOT EXISTS idx_history_complaint     ON status_history(complaint_id);
`);

// --------------------------------------------------------------------------
// Users
// --------------------------------------------------------------------------
export const users = {
  create: (u) =>
    db
      .prepare(
        `INSERT INTO users (id,name,email,phone,password_hash,role,department,locality)
         VALUES (@id,@name,@email,@phone,@password_hash,@role,@department,@locality)`
      )
      .run(u),

  byEmail: (email) =>
    db.prepare('SELECT * FROM users WHERE email = ?').get(String(email).toLowerCase()),

  byId: (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id),

  listOfficers: (departmentCode) =>
    db
      .prepare(
        `SELECT id,name,email,department FROM users
         WHERE role = 'officer' AND (@dept IS NULL OR department = @dept)`
      )
      .all({ dept: departmentCode ?? null }),

  /** Officer in a department with the fewest active complaints (load balancing). */
  leastLoadedOfficer: (departmentCode) =>
    db
      .prepare(
        `SELECT u.id, u.name,
                (SELECT COUNT(*) FROM complaints c
                  WHERE c.assigned_to = u.id
                    AND c.status IN ('routed','in_progress','reopened')) AS load
           FROM users u
          WHERE u.role = 'officer' AND u.department = ?
          ORDER BY load ASC, u.created_at ASC
          LIMIT 1`
      )
      .get(departmentCode),
};

// --------------------------------------------------------------------------
// Departments
// --------------------------------------------------------------------------
export const departments = {
  upsert: (d) =>
    db
      .prepare(
        `INSERT INTO departments (code,name,category_key,sla_hours,escalation_json)
         VALUES (@code,@name,@category_key,@sla_hours,@escalation_json)
         ON CONFLICT(code) DO UPDATE SET
           name=excluded.name, category_key=excluded.category_key,
           sla_hours=excluded.sla_hours, escalation_json=excluded.escalation_json`
      )
      .run(d),

  all: () => db.prepare('SELECT * FROM departments ORDER BY name').all(),
  byCode: (code) => db.prepare('SELECT * FROM departments WHERE code = ?').get(code),
};

// --------------------------------------------------------------------------
// Complaints
// --------------------------------------------------------------------------
const COMPLAINT_COLUMNS = `
  id,user_id,citizen_name,citizen_phone,text,language,locality,address,
  category,category_label,confidence,department_code,department_name,
  priority,priority_score,urgency,severity_score,sla_hours,ml_json,needs_review,
  duplicate_of,duplicate_score,repeat_count,status,assigned_to,
  escalation_level,escalated_at,due_at,resolved_at,resolution_note,citizen_rating,
  created_at,updated_at`;

export const complaints = {
  insert: (c) =>
    db
      .prepare(
        `INSERT INTO complaints (
           id,user_id,citizen_name,citizen_phone,text,language,locality,address,
           category,category_label,confidence,department_code,department_name,
           priority,priority_score,urgency,severity_score,sla_hours,ml_json,needs_review,
           duplicate_of,duplicate_score,repeat_count,status,assigned_to,due_at
         ) VALUES (
           @id,@user_id,@citizen_name,@citizen_phone,@text,@language,@locality,@address,
           @category,@category_label,@confidence,@department_code,@department_name,
           @priority,@priority_score,@urgency,@severity_score,@sla_hours,@ml_json,@needs_review,
           @duplicate_of,@duplicate_score,@repeat_count,@status,@assigned_to,@due_at
         )`
      )
      .run(c),

  byId: (id) => db.prepare(`SELECT ${COMPLAINT_COLUMNS} FROM complaints WHERE id = ?`).get(id),

  /** Recent open complaints in a locality — the duplicate-candidate pool. */
  duplicateCandidates: ({ locality, limit, excludeId = null }) =>
    db
      .prepare(
        `SELECT id, text, category, locality, status FROM complaints
          WHERE status NOT IN ('resolved','rejected','duplicate')
            AND (@locality IS NULL OR locality = @locality)
            AND (@excludeId IS NULL OR id != @excludeId)
          ORDER BY created_at DESC
          LIMIT @limit`
      )
      .all({ locality: locality ?? null, limit, excludeId }),

  /** Filtered, paginated listing used by the admin/officer dashboards. */
  search: ({
    status = null,
    department = null,
    priority = null,
    category = null,
    locality = null,
    userId = null,
    assignedTo = null,
    needsReview = null,
    overdueOnly = false,
    q = null,
    limit = 25,
    offset = 0,
    sort = 'created_at',
    order = 'DESC',
  }) => {
    const sortable = { created_at: 'created_at', priority_score: 'priority_score', due_at: 'due_at', updated_at: 'updated_at' };
    const sortCol = sortable[sort] || 'created_at';
    const dir = String(order).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const where = `
      WHERE (@status     IS NULL OR status = @status)
        AND (@department IS NULL OR department_code = @department)
        AND (@priority   IS NULL OR priority = @priority)
        AND (@category   IS NULL OR category = @category)
        AND (@locality   IS NULL OR locality = @locality)
        AND (@userId     IS NULL OR user_id = @userId)
        AND (@assignedTo IS NULL OR assigned_to = @assignedTo)
        AND (@needsReview IS NULL OR needs_review = @needsReview)
        AND (@overdue = 0 OR (due_at IS NOT NULL AND due_at < datetime('now')
                              AND status NOT IN ('resolved','rejected','duplicate')))
        AND (@q IS NULL OR text LIKE @qLike OR id LIKE @qLike)`;

    const params = {
      status, department, priority, category, locality, userId, assignedTo,
      needsReview: needsReview === null ? null : Number(needsReview),
      overdue: overdueOnly ? 1 : 0,
      q, qLike: q ? `%${q}%` : null,
      limit, offset,
    };

    const rows = db
      .prepare(`SELECT ${COMPLAINT_COLUMNS} FROM complaints ${where}
                ORDER BY ${sortCol} ${dir} LIMIT @limit OFFSET @offset`)
      .all(params);
    const { total } = db
      .prepare(`SELECT COUNT(*) AS total FROM complaints ${where}`)
      .get(params);

    return { rows, total };
  },

  update: (id, fields) => {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    const setSql = keys.map((k) => `${k} = @${k}`).join(', ');
    db.prepare(`UPDATE complaints SET ${setSql}, updated_at = datetime('now') WHERE id = @id`)
      .run({ ...fields, id });
  },

  /** Open complaints whose SLA deadline has passed — input to the escalation job. */
  overdue: () =>
    db
      .prepare(
        `SELECT ${COMPLAINT_COLUMNS} FROM complaints
          WHERE due_at IS NOT NULL
            AND due_at < datetime('now')
            AND status IN ('submitted','routed','in_progress','reopened')`
      )
      .all(),

  countSimilarOpen: (category, locality) =>
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM complaints
          WHERE category = ? AND locality = ?
            AND status NOT IN ('resolved','rejected','duplicate')`
      )
      .get(category, locality).n,

  stats: () => {
    const byStatus = db
      .prepare('SELECT status, COUNT(*) AS n FROM complaints GROUP BY status')
      .all();
    const byPriority = db
      .prepare('SELECT priority, COUNT(*) AS n FROM complaints WHERE priority IS NOT NULL GROUP BY priority')
      .all();
    const byDepartment = db
      .prepare(
        `SELECT department_code AS code, department_name AS name, COUNT(*) AS n,
                SUM(CASE WHEN status='resolved' THEN 1 ELSE 0 END) AS resolved,
                SUM(CASE WHEN due_at < datetime('now')
                          AND status NOT IN ('resolved','rejected','duplicate')
                         THEN 1 ELSE 0 END) AS overdue
           FROM complaints WHERE department_code IS NOT NULL
          GROUP BY department_code, department_name ORDER BY n DESC`
      )
      .all();
    const byCategory = db
      .prepare('SELECT category_label AS label, COUNT(*) AS n FROM complaints WHERE category IS NOT NULL GROUP BY category_label ORDER BY n DESC')
      .all();
    const totals = db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status='resolved' THEN 1 ELSE 0 END) AS resolved,
                SUM(CASE WHEN status='duplicate' THEN 1 ELSE 0 END) AS duplicates,
                SUM(CASE WHEN needs_review=1 THEN 1 ELSE 0 END) AS needs_review,
                SUM(CASE WHEN escalation_level>0 THEN 1 ELSE 0 END) AS escalated,
                SUM(CASE WHEN due_at < datetime('now')
                          AND status NOT IN ('resolved','rejected','duplicate')
                         THEN 1 ELSE 0 END) AS overdue
           FROM complaints`
      )
      .get();
    const avgResolutionHours = db
      .prepare(
        `SELECT ROUND(AVG((julianday(resolved_at) - julianday(created_at)) * 24), 2) AS h
           FROM complaints WHERE resolved_at IS NOT NULL`
      )
      .get().h;
    const trend = db
      .prepare(
        `SELECT date(created_at) AS day, COUNT(*) AS n
           FROM complaints WHERE created_at >= date('now','-13 days')
          GROUP BY day ORDER BY day`
      )
      .all();

    return { totals: { ...totals, avg_resolution_hours: avgResolutionHours },
             byStatus, byPriority, byDepartment, byCategory, trend };
  },
};

// --------------------------------------------------------------------------
// Status history
// --------------------------------------------------------------------------
export const history = {
  add: (h) =>
    db
      .prepare(
        `INSERT INTO status_history (complaint_id,from_status,to_status,note,actor_id,actor_role)
         VALUES (@complaint_id,@from_status,@to_status,@note,@actor_id,@actor_role)`
      )
      .run(h),

  forComplaint: (id) =>
    db
      .prepare('SELECT * FROM status_history WHERE complaint_id = ? ORDER BY created_at ASC, id ASC')
      .all(id),
};

export default db;
