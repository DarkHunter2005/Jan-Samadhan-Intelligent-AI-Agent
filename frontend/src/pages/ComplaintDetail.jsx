import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, formatDate, timeUntil } from '../lib/api.js';
import { Alert, Loading, PriorityBadge, Spinner, StatusPill } from '../components/common.jsx';

const NEXT_STATUS = {
  submitted: ['routed', 'in_progress', 'rejected'],
  routed: ['in_progress', 'resolved', 'rejected'],
  in_progress: ['resolved', 'rejected', 'routed'],
  reopened: ['in_progress', 'resolved', 'rejected'],
  resolved: ['reopened'],
  rejected: ['reopened'],
  duplicate: ['routed'],
};

export default function ComplaintDetail({ user }) {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const [status, setStatus] = useState('');
  const [note, setNote] = useState('');
  const [dept, setDept] = useState('');
  const [priority, setPriority] = useState('');
  const [departments, setDepartments] = useState([]);
  const [rating, setRating] = useState(5);

  const isStaff = user.role === 'officer' || user.role === 'admin';
  const isAdmin = user.role === 'admin';

  const load = useCallback(() => {
    api.detail(id)
      .then((d) => {
        setData(d);
        setStatus('');
        setNote('');
        setDept(d.complaint.department_code || '');
        setPriority(d.complaint.priority || '');
      })
      .catch((e) => setError(e.message));
  }, [id]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (isAdmin) api.departments().then((d) => setDepartments(d.departments)).catch(() => {});
  }, [isAdmin]);

  async function changeStatus(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.setStatus(id, { status, note: note.trim() || undefined });
      setMsg(`Status updated to "${status}".`);
      load();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  async function reassign(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const body = {};
      if (dept && dept !== c.department_code) body.department_code = dept;
      if (priority && priority !== c.priority) body.priority = priority;
      if (note.trim()) body.note = note.trim();
      if (!Object.keys(body).length) { setError('Change the department or priority first.'); return; }
      await api.assign(id, body);
      setMsg('Routing corrected. The AI model can be retrained on this correction.');
      load();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  async function sendFeedback(e) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.feedback(id, { rating: Number(rating) });
      setMsg('Thank you for your feedback.');
      load();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  if (error && !data) return <div className="container narrow"><Alert kind="error">{error}</Alert></div>;
  if (!data) return <div className="container"><Loading /></div>;

  const c = data.complaint;
  const ml = c.ml;
  const canOwn = c.user_id === user.id;

  return (
    <div className="container">
      <p className="muted">
        <Link to={isStaff ? '/dashboard' : '/my-complaints'}>← Back to list</Link>
      </p>

      <Alert kind="error" onClose={() => setError('')}>{error}</Alert>
      <Alert kind="success" onClose={() => setMsg('')}>{msg}</Alert>

      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <h2 className="mono">{c.id}</h2>
            <StatusPill status={c.status} /> <PriorityBadge level={c.priority} />
            {c.needs_review && <span className="pill">needs human review</span>}
            {c.is_overdue && <span className="overdue-flag"> ⚠ SLA breached</span>}
          </div>
          <div style={{ textAlign: 'right' }} className="muted">
            Filed {formatDate(c.created_at)}
            {c.due_at && !['resolved', 'rejected', 'duplicate'].includes(c.status) && (
              <div className={c.is_overdue ? 'overdue-flag' : ''}>Due {timeUntil(c.due_at)}</div>
            )}
          </div>
        </div>

        <p style={{ fontSize: 16, marginTop: 14 }}>{c.text}</p>

        <dl className="kv">
          <dt>Category</dt>
          <dd>{c.category_label} <span className="muted">({Math.round((c.confidence || 0) * 100)}% confidence)</span></dd>
          <dt>Department</dt><dd>{c.department_name} ({c.department_code})</dd>
          <dt>Current authority</dt><dd>{c.current_authority || '—'}</dd>
          <dt>Escalation level</dt><dd>{c.escalation_level || 0}</dd>
          <dt>Priority score</dt><dd>{c.priority_score}/100 · urgency: {c.urgency}</dd>
          <dt>Location</dt><dd>{c.locality || '—'}{c.address ? ` · ${c.address}` : ''}</dd>
          {isStaff && (<><dt>Complainant</dt><dd>{c.citizen_name || '—'} · {c.citizen_phone || '—'}</dd></>)}
          {c.duplicate_of && (
            <>
              <dt>Duplicate of</dt>
              <dd><Link className="mono" to={`/complaint/${c.duplicate_of}`}>{c.duplicate_of}</Link>{' '}
                <span className="muted">({Math.round((c.duplicate_score || 0) * 100)}% similar)</span></dd>
            </>
          )}
          {c.repeat_count > 0 && (<><dt>Repeat reports</dt><dd>{c.repeat_count + 1} citizens affected</dd></>)}
          {c.citizen_rating && (<><dt>Citizen rating</dt><dd>{'★'.repeat(c.citizen_rating)}{'☆'.repeat(5 - c.citizen_rating)}</dd></>)}
        </dl>

        {c.resolution_note && <Alert kind="success"><strong>Resolution:</strong> {c.resolution_note}</Alert>}
      </div>

      {/* --- AI explanation --- */}
      {isStaff && ml && (
        <div className="card">
          <h3>AI analysis</h3>
          {ml.degraded && <Alert kind="warn">Produced by the keyword fallback — the ML service was unavailable.</Alert>}
          {ml.priority_reasons?.length > 0 && (
            <>
              <strong style={{ fontSize: 14 }}>Why this priority</strong>
              <ul className="muted" style={{ marginTop: 4 }}>
                {ml.priority_reasons.map((r, i) => <li key={i}>{r}</li>)}
              </ul>
            </>
          )}
          {ml.alternatives?.length > 0 && (
            <>
              <strong style={{ fontSize: 14 }}>Category confidence</strong>
              <div className="chips" style={{ marginTop: 6 }}>
                {ml.alternatives.map((a) => (
                  <span key={a.category} className="pill">{a.label}: {Math.round(a.confidence * 100)}%</span>
                ))}
              </div>
            </>
          )}
          {ml.priority_components && (
            <>
              <strong style={{ fontSize: 14, display: 'block', marginTop: 12 }}>Signal breakdown</strong>
              <div className="chips" style={{ marginTop: 6 }}>
                {['severity', 'urgency', 'frequency', 'risk'].map((k) => (
                  <span key={k} className="pill">
                    {k}: {Math.round((ml.priority_components[k] || 0) * 100)}%
                  </span>
                ))}
              </div>
            </>
          )}
          {ml.duplicate?.matches?.length > 0 && (
            <>
              <strong style={{ fontSize: 14, display: 'block', marginTop: 12 }}>Similar complaints</strong>
              <ul className="muted" style={{ marginTop: 4 }}>
                {ml.duplicate.matches.slice(0, 3).map((m) => (
                  <li key={m.id}>
                    <Link className="mono" to={`/complaint/${m.id}`}>{m.id}</Link>{' '}
                    — {Math.round(m.score * 100)}% similar: {m.text_preview}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {/* --- staff actions --- */}
      {isStaff && (
        <div className="grid-2">
          <div className="card">
            <h3>Update status</h3>
            <form onSubmit={changeStatus}>
              <div className="field">
                <label htmlFor="st">New status</label>
                <select id="st" value={status} onChange={(e) => setStatus(e.target.value)} required>
                  <option value="">Choose…</option>
                  {(NEXT_STATUS[c.status] || []).map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor="nt">Note {['resolved', 'rejected'].includes(status) && '(required)'}</label>
                <textarea id="nt" value={note} onChange={(e) => setNote(e.target.value)}
                          style={{ minHeight: 80 }} placeholder="What action was taken?" />
              </div>
              <button className="btn-primary" disabled={busy || !status}>
                {busy ? <Spinner /> : 'Update status'}
              </button>
            </form>
          </div>

          {isAdmin && (
            <div className="card">
              <h3>Correct routing</h3>
              <p className="muted" style={{ marginTop: 0 }}>
                Use this when the automatic classification was wrong.
              </p>
              <form onSubmit={reassign}>
                <div className="field">
                  <label htmlFor="dp">Department</label>
                  <select id="dp" value={dept} onChange={(e) => setDept(e.target.value)}>
                    {departments.map((d) => <option key={d.code} value={d.code}>{d.code} — {d.name}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="pr">Priority</label>
                  <select id="pr" value={priority} onChange={(e) => setPriority(e.target.value)}>
                    <option value="low">low</option>
                    <option value="medium">medium</option>
                    <option value="high">high</option>
                    <option value="critical">critical</option>
                  </select>
                </div>
                <button className="btn-secondary" disabled={busy}>
                  {busy ? <Spinner dark /> : 'Save correction'}
                </button>
              </form>
            </div>
          )}
        </div>
      )}

      {/* --- citizen feedback --- */}
      {canOwn && c.status === 'resolved' && !c.citizen_rating && (
        <div className="card">
          <h3>Rate this resolution</h3>
          <form onSubmit={sendFeedback} style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
            <div className="field" style={{ marginBottom: 0, maxWidth: 150 }}>
              <label htmlFor="rt">Rating</label>
              <select id="rt" value={rating} onChange={(e) => setRating(e.target.value)}>
                {[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{n} ★</option>)}
              </select>
            </div>
            <button className="btn-primary" disabled={busy}>Submit rating</button>
          </form>
        </div>
      )}

      <div className="card">
        <h3>Audit trail</h3>
        <ul className="timeline">
          {data.history.map((h) => (
            <li key={h.id} className={h.actor_role === 'system' ? 'system' : ''}>
              <strong>{(h.to_status || '').replace('_', ' ')}</strong>
              <span className="muted"> — {formatDate(h.created_at)} by {h.actor_role || 'system'}</span>
              {h.note && <div className="muted">{h.note}</div>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
