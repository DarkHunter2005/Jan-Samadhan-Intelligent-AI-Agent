import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { Alert, ComplaintTable, Loading, Pagination } from '../components/common.jsx';

export default function MyComplaints() {
  const [data, setData] = useState(null);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setData(null);
    api.mine({ page, pageSize: 10, status: status || undefined })
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [page, status]);

  return (
    <div className="container">
      <h1 className="page-title">My Complaints</h1>
      <p className="subtitle">Every grievance you have filed, with its current status.</p>

      <Alert kind="error" onClose={() => setError('')}>{error}</Alert>

      <div className="card">
        <div className="toolbar">
          <div className="field">
            <label htmlFor="st">Filter by status</label>
            <select id="st" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
              <option value="">All</option>
              <option value="submitted">Submitted</option>
              <option value="routed">Routed</option>
              <option value="in_progress">In progress</option>
              <option value="resolved">Resolved</option>
              <option value="duplicate">Duplicate</option>
              <option value="rejected">Rejected</option>
            </select>
          </div>
          <Link to="/" style={{ marginLeft: 'auto' }}>
            <button className="btn-primary">+ File a new complaint</button>
          </Link>
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
