import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, formatDate, timeUntil } from '../lib/api.js';
import { Alert, PriorityBadge, Spinner, StatusPill } from '../components/common.jsx';

const STEPS = ['submitted', 'routed', 'in_progress', 'resolved'];
const STEP_LABELS = {
  submitted: 'Received', routed: 'Sent to department',
  in_progress: 'Being worked on', resolved: 'Resolved',
};

export default function TrackComplaint() {
  const [params, setParams] = useSearchParams();
  const [id, setId] = useState(params.get('id') || '');
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function lookup(trackingId) {
    const q = (trackingId ?? id).trim().toUpperCase();
    if (!q) return;
    setBusy(true);
    setError('');
    setData(null);
    try {
      setData(await api.track(q));
      setParams({ id: q });
    } catch (err) {
      setError(err.status === 404
        ? `No complaint found with ID "${q}". Please check the tracking ID.`
        : err.message);
    } finally {
      setBusy(false);
    }
  }

  // Deep link support: /track?id=GRV-2026-XXXXXX
  useEffect(() => {
    const initial = params.get('id');
    if (initial) lookup(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const c = data?.complaint;
  const stepIndex = c ? STEPS.indexOf(c.status === 'reopened' ? 'in_progress' : c.status) : -1;

  return (
    <div className="container narrow">
      <h1 className="page-title">Track Your Complaint</h1>
      <p className="subtitle">
        Enter the tracking ID from your acknowledgement. No login required.
      </p>

      <div className="card">
        <form onSubmit={(e) => { e.preventDefault(); lookup(); }}>
          <label htmlFor="tid">Tracking ID</label>
          <div style={{ display: 'flex', gap: 10 }}>
            <input
              id="tid"
              className="mono"
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder="GRV-2026-XXXXXX"
              style={{ textTransform: 'uppercase' }}
            />
            <button className="btn-primary" type="submit" disabled={busy || !id.trim()}>
              {busy ? <Spinner /> : 'Track'}
            </button>
          </div>
        </form>
        <Alert kind="error">{error}</Alert>
      </div>

      {c && (
        <>
          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between',
                          alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
              <div>
                <h2 className="mono">{c.id}</h2>
                <StatusPill status={c.status} /> <PriorityBadge level={c.priority} />
              </div>
              {c.is_overdue && (
                <span className="overdue-flag">
                  ⚠ Past its deadline — escalated to a higher authority
                </span>
              )}
            </div>

            <p style={{ marginTop: 14 }}>{c.text}</p>

            {/* progress bar */}
            {c.status !== 'duplicate' && c.status !== 'rejected' && (
              <div style={{ margin: '22px 0' }}>
                <div className="progress">
                  <div
                    style={{
                      width: `${Math.max(8, ((stepIndex + 1) / STEPS.length) * 100)}%`,
                      background: c.status === 'resolved' ? 'var(--green)' : 'var(--navy)',
                    }}
                  />
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 7 }}>
                  {STEPS.map((s, i) => (
                    <span
                      key={s}
                      className="muted"
                      style={{
                        fontSize: 12,
                        fontWeight: i <= stepIndex ? 700 : 400,
                        color: i <= stepIndex ? 'var(--navy)' : undefined,
                        textAlign: 'center', flex: 1,
                      }}
                    >
                      {STEP_LABELS[s]}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {c.duplicate_of && (
              <Alert kind="info">
                This report was linked to an earlier complaint about the same issue
                (<span className="mono">{c.duplicate_of}</span>). Both are tracked together.
              </Alert>
            )}
            {c.repeat_count > 0 && (
              <Alert kind="info">
                {c.repeat_count + 1} citizens have reported this issue. The department has been
                notified of the higher impact.
              </Alert>
            )}

            <dl className="kv" style={{ marginTop: 18 }}>
              <dt>Category</dt><dd>{c.category_label || '—'}</dd>
              <dt>Department</dt><dd>{c.department_name || '—'}</dd>
              <dt>Currently with</dt><dd>{c.current_authority || '—'}</dd>
              <dt>Location</dt><dd>{c.locality || '—'}</dd>
              <dt>Filed on</dt><dd>{formatDate(c.created_at)}</dd>
              {c.due_at && !['resolved', 'rejected'].includes(c.status) && (
                <>
                  <dt>Response due</dt>
                  <dd className={c.is_overdue ? 'overdue-flag' : ''}>
                    {formatDate(c.due_at)} ({timeUntil(c.due_at)})
                  </dd>
                </>
              )}
              {c.escalation_level > 0 && (
                <>
                  <dt>Escalation</dt>
                  <dd>Level {c.escalation_level} — raised to a senior officer</dd>
                </>
              )}
              {c.resolved_at && (<><dt>Resolved on</dt><dd>{formatDate(c.resolved_at)}</dd></>)}
            </dl>

            {c.resolution_note && (
              <Alert kind="success">
                <strong>Resolution:</strong> {c.resolution_note}
              </Alert>
            )}
          </div>

          <div className="card">
            <h3>Progress history</h3>
            <ul className="timeline">
              {data.history.map((h, i) => (
                <li key={i} className={h.by === 'system' ? 'system' : ''}>
                  <strong>{STEP_LABELS[h.to_status] || h.to_status}</strong>
                  <span className="muted"> — {formatDate(h.at)}</span>
                  {h.note && <div className="muted">{h.note}</div>}
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}
