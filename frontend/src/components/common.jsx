import { Link } from 'react-router-dom';
import { STATUS_LABELS, formatDate, timeUntil } from '../lib/api.js';

export function PriorityBadge({ level }) {
  if (!level) return null;
  return <span className={`badge badge-${level}`}>{level}</span>;
}

export function StatusPill({ status }) {
  return <span className={`status status-${status}`}>{STATUS_LABELS[status] || status}</span>;
}

export function Alert({ kind = 'info', children, onClose }) {
  if (!children) return null;
  return (
    <div className={`alert alert-${kind}`}>
      {children}
      {onClose && (
        <button
          onClick={onClose}
          style={{ float: 'right', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontSize: 16 }}
          aria-label="Dismiss"
        >
          ×
        </button>
      )}
    </div>
  );
}

export function Spinner({ dark = false }) {
  return <span className={`spinner${dark ? ' dark' : ''}`} role="status" aria-label="Loading" />;
}

export function Loading({ text = 'Loading…' }) {
  return (
    <div className="empty">
      <Spinner dark /> <span style={{ marginLeft: 8 }}>{text}</span>
    </div>
  );
}

export function Empty({ children }) {
  return <div className="empty">{children}</div>;
}

/** SLA countdown with overdue highlighting. */
export function SlaCell({ dueAt, status }) {
  if (!dueAt || ['resolved', 'rejected', 'duplicate'].includes(status)) {
    return <span className="muted">—</span>;
  }
  const label = timeUntil(dueAt);
  const overdue = label.includes('overdue');
  return (
    <span className={overdue ? 'overdue-flag' : ''} title={formatDate(dueAt)}>
      {label}
    </span>
  );
}

/** Compact complaint table shared by the citizen and staff dashboards. */
export function ComplaintTable({ complaints, linkBase = '/complaint' }) {
  if (!complaints?.length) return <Empty>No complaints found.</Empty>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Tracking ID</th>
            <th>Complaint</th>
            <th>Category</th>
            <th>Department</th>
            <th>Priority</th>
            <th>Status</th>
            <th>SLA</th>
            <th>Filed</th>
          </tr>
        </thead>
        <tbody>
          {complaints.map((c) => (
            <tr key={c.id}>
              <td className="mono">
                <Link to={`${linkBase}/${c.id}`}>{c.id}</Link>
                {c.escalation_level > 0 && (
                  <div className="muted" title="Escalated up the authority ladder">
                    ↑ level {c.escalation_level}
                  </div>
                )}
              </td>
              <td className="wrap">
                {c.text.length > 110 ? `${c.text.slice(0, 110)}…` : c.text}
                {c.duplicate_of && (
                  <div className="muted">Linked to {c.duplicate_of}</div>
                )}
                {c.repeat_count > 0 && (
                  <div className="muted">Reported by {c.repeat_count + 1} citizens</div>
                )}
              </td>
              <td>{c.category_label || '—'}</td>
              <td>{c.department_name || '—'}</td>
              <td>
                <PriorityBadge level={c.priority} />
                {c.priority_score != null && (
                  <div className="muted">{Math.round(c.priority_score)}/100</div>
                )}
              </td>
              <td>
                <StatusPill status={c.status} />
                {c.needs_review && <div className="muted">needs review</div>}
              </td>
              <td><SlaCell dueAt={c.due_at} status={c.status} /></td>
              <td className="muted">{formatDate(c.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Pagination({ page, pageSize, total, onChange }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  return (
    <div className="pagination">
      <button className="btn-secondary btn-sm" disabled={page <= 1} onClick={() => onChange(page - 1)}>
        ← Previous
      </button>
      <span className="muted">Page {page} of {pages} ({total} total)</span>
      <button className="btn-secondary btn-sm" disabled={page >= pages} onClick={() => onChange(page + 1)}>
        Next →
      </button>
    </div>
  );
}
