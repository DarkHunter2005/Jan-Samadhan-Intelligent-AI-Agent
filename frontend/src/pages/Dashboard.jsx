import { useCallback, useEffect, useState } from 'react';
import {
  Bar, BarChart, CartesianGrid, Cell, Line, LineChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { PRIORITY_COLORS, api } from '../lib/api.js';
import { Alert, ComplaintTable, Loading, Pagination, Spinner } from '../components/common.jsx';

export default function Dashboard({ user }) {
  const [stats, setStats] = useState(null);
  const [data, setData] = useState(null);
  const [filters, setFilters] = useState({
    status: '', priority: '', department: '', overdue: '', needsReview: '', q: '',
  });
  const [page, setPage] = useState(1);
  const [departments, setDepartments] = useState([]);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [escalating, setEscalating] = useState(false);

  const isAdmin = user.role === 'admin';

  const loadStats = useCallback(() => {
    api.stats().then(setStats).catch((e) => setError(e.message));
  }, []);

  const loadList = useCallback(() => {
    setData(null);
    api.list({
      page, pageSize: 15, sort: 'priority_score', order: 'DESC',
      status: filters.status || undefined,
      priority: filters.priority || undefined,
      department: isAdmin ? (filters.department || undefined) : undefined,
      overdue: filters.overdue || undefined,
      needsReview: filters.needsReview || undefined,
      q: filters.q || undefined,
    }).then(setData).catch((e) => setError(e.message));
  }, [page, filters, isAdmin]);

  useEffect(() => { loadStats(); }, [loadStats]);
  useEffect(() => { loadList(); }, [loadList]);
  useEffect(() => {
    if (isAdmin) api.departments().then((d) => setDepartments(d.departments)).catch(() => {});
  }, [isAdmin]);

  const set = (k) => (e) => { setFilters({ ...filters, [k]: e.target.value }); setPage(1); };

  async function runEscalation() {
    setEscalating(true);
    setError('');
    try {
      const res = await api.escalate();
      setMsg(res.escalated_count
        ? `Escalated ${res.escalated_count} overdue complaint(s) to the next authority.`
        : 'No complaints are past their SLA deadline right now.');
      loadStats();
      loadList();
    } catch (e) {
      setError(e.message);
    } finally {
      setEscalating(false);
    }
  }

  const t = stats?.totals ?? {};
  const priorityData = (stats?.byPriority ?? []).map((p) => ({
    name: p.priority, value: p.n, fill: PRIORITY_COLORS[p.priority] || '#888',
  }));
  const trendData = (stats?.trend ?? []).map((d) => ({
    day: d.day?.slice(5) ?? '', complaints: d.n,
  }));

  return (
    <div className="container">
      <h1 className="page-title">
        {isAdmin ? 'Administrator Dashboard' : `${user.department} Department Dashboard`}
      </h1>
      <p className="subtitle">
        {isAdmin
          ? 'All departments, SLA breaches and routing corrections.'
          : 'Complaints routed to your department, highest priority first.'}
      </p>

      <Alert kind="error" onClose={() => setError('')}>{error}</Alert>
      <Alert kind="success" onClose={() => setMsg('')}>{msg}</Alert>

      {!stats ? <Loading text="Loading statistics…" /> : (
        <>
          <div className="stat-grid">
            <div className="stat"><div className="value">{t.total ?? 0}</div><div className="label">Total complaints</div></div>
            <div className="stat"><div className="value" style={{ color: 'var(--green)' }}>{t.resolved ?? 0}</div><div className="label">Resolved</div></div>
            <div className="stat"><div className="value" style={{ color: 'var(--red)' }}>{t.overdue ?? 0}</div><div className="label">SLA breached</div></div>
            <div className="stat"><div className="value" style={{ color: 'var(--saffron)' }}>{t.escalated ?? 0}</div><div className="label">Escalated</div></div>
            <div className="stat"><div className="value">{t.duplicates ?? 0}</div><div className="label">Duplicates merged</div></div>
            <div className="stat">
              <div className="value">{t.avg_resolution_hours != null ? `${t.avg_resolution_hours}h` : '—'}</div>
              <div className="label">Avg resolution time</div>
            </div>
          </div>

          <div className="grid-2">
            <div className="card">
              <h3>Complaints by priority</h3>
              <ResponsiveContainer width="100%" height={210}>
                <BarChart data={priorityData}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="name" fontSize={12} />
                  <YAxis allowDecimals={false} fontSize={12} />
                  <Tooltip />
                  <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                    {priorityData.map((e, i) => <Cell key={i} fill={e.fill} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>

            <div className="card">
              <h3>Complaints filed (last 14 days)</h3>
              <ResponsiveContainer width="100%" height={210}>
                <LineChart data={trendData}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="day" fontSize={12} />
                  <YAxis allowDecimals={false} fontSize={12} />
                  <Tooltip />
                  <Line type="monotone" dataKey="complaints" stroke="var(--navy)" strokeWidth={2} dot={{ r: 3 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          {isAdmin && stats.byDepartment?.length > 0 && (
            <div className="card">
              <h3>Department workload</h3>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>Department</th><th>Total</th><th>Resolved</th><th>Overdue</th><th>Resolution rate</th></tr>
                  </thead>
                  <tbody>
                    {stats.byDepartment.map((d) => {
                      const rate = d.n ? Math.round((d.resolved / d.n) * 100) : 0;
                      return (
                        <tr key={d.code}>
                          <td>{d.name} <span className="muted">({d.code})</span></td>
                          <td>{d.n}</td>
                          <td>{d.resolved}</td>
                          <td className={d.overdue > 0 ? 'overdue-flag' : ''}>{d.overdue}</td>
                          <td>
                            <div className="progress" style={{ width: 110 }}>
                              <div style={{ width: `${rate}%`, background: rate > 60 ? 'var(--green)' : 'var(--amber)' }} />
                            </div>
                            <span className="muted">{rate}%</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      <div className="card">
        <div className="toolbar">
          <div className="field">
            <label htmlFor="f-q">Search</label>
            <input id="f-q" value={filters.q} onChange={set('q')} placeholder="text or ID" />
          </div>
          <div className="field">
            <label htmlFor="f-status">Status</label>
            <select id="f-status" value={filters.status} onChange={set('status')}>
              <option value="">All</option>
              <option value="submitted">Submitted</option>
              <option value="routed">Routed</option>
              <option value="in_progress">In progress</option>
              <option value="resolved">Resolved</option>
              <option value="duplicate">Duplicate</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="f-pri">Priority</label>
            <select id="f-pri" value={filters.priority} onChange={set('priority')}>
              <option value="">All</option>
              <option value="critical">Critical</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
          </div>
          {isAdmin && (
            <div className="field">
              <label htmlFor="f-dept">Department</label>
              <select id="f-dept" value={filters.department} onChange={set('department')}>
                <option value="">All</option>
                {departments.map((d) => <option key={d.code} value={d.code}>{d.code} — {d.name}</option>)}
              </select>
            </div>
          )}
          <div className="field">
            <label htmlFor="f-over">SLA</label>
            <select id="f-over" value={filters.overdue} onChange={set('overdue')}>
              <option value="">All</option>
              <option value="1">Overdue only</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="f-rev">Triage</label>
            <select id="f-rev" value={filters.needsReview} onChange={set('needsReview')}>
              <option value="">All</option>
              <option value="1">Needs human review</option>
            </select>
          </div>
          {isAdmin && (
            <button className="btn-secondary" onClick={runEscalation} disabled={escalating}>
              {escalating ? <Spinner dark /> : 'Run SLA escalation'}
            </button>
          )}
        </div>

        {!data ? <Loading /> : (
          <>
            <ComplaintTable complaints={data.complaints} />
            <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onChange={setPage} />
          </>
        )}
      </div>
    </div>
  );
}
