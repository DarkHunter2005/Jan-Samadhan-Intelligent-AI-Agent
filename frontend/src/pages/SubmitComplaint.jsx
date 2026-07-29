import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, auth } from '../lib/api.js';
import { Alert, PriorityBadge, Spinner } from '../components/common.jsx';

const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'ml', label: 'മലയാളം / Malayalam' },
  { code: 'hi', label: 'हिन्दी / Hindi' },
  { code: 'ta', label: 'தமிழ் / Tamil' },
];

// Plain-language prompts so citizens know what to write. The classifier works on
// free text, so these are guidance only, never required structure.
const EXAMPLES = [
  'No water supply in our ward for the last 10 days',
  'Street light near the school is not working',
  'Garbage has not been collected for two weeks',
  'Pension has not been credited for three months',
];

export default function SubmitComplaint() {
  const user = auth.user();
  const [form, setForm] = useState({
    text: '', locality: user?.locality || '', address: '', language: 'en',
    citizen_name: user?.name || '', citizen_phone: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  async function onSubmit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const payload = { text: form.text.trim(), language: form.language };
      if (form.locality.trim()) payload.locality = form.locality.trim();
      if (form.address.trim()) payload.address = form.address.trim();
      if (!user) {
        payload.citizen_name = form.citizen_name.trim();
        payload.citizen_phone = form.citizen_phone.trim();
      }
      const res = await api.submit(payload);
      setResult(res);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  // ----- acknowledgement screen -----
  if (result) {
    const { explanation: ex, routing: rt, duplicate: dup } = result;
    return (
      <div className="container narrow">
        <div className="card">
          <Alert kind="success">
            Your complaint has been registered and routed automatically.
          </Alert>

          <h2>Tracking ID</h2>
          <p className="mono" style={{ fontSize: 25, fontWeight: 700, margin: '4px 0 6px' }}>
            {result.tracking_id}
          </p>
          <p className="muted">
            Save this ID. You can check progress any time on the{' '}
            <Link to="/track">Track Complaint</Link> page without logging in.
          </p>

          {dup?.merged && (
            <Alert kind="warn">
              We found an existing complaint about the same issue
              (<span className="mono">{dup.parent_id}</span>). Yours has been linked to it so
              the department sees it is affecting multiple citizens — this raises its priority
              rather than creating a duplicate queue.
            </Alert>
          )}

          {ex.degraded && (
            <Alert kind="warn">
              Our AI service was temporarily unavailable, so this complaint was classified by
              keyword rules and will be reviewed manually by staff.
            </Alert>
          )}

          <h3 style={{ marginTop: 22 }}>How your complaint was processed</h3>
          <dl className="kv">
            <dt>Category</dt>
            <dd>
              {ex.category}{' '}
              <span className="muted">({Math.round(ex.confidence * 100)}% confidence)</span>
            </dd>
            <dt>Department</dt>
            <dd>{rt.department}</dd>
            <dt>First authority</dt>
            <dd>{rt.authority || '—'}</dd>
            <dt>Priority</dt>
            <dd>
              <PriorityBadge level={ex.priority} />{' '}
              <span className="muted">score {Math.round(ex.priority_score)}/100</span>
            </dd>
            <dt>Urgency</dt>
            <dd>{ex.urgency.replace('_', ' ')}</dd>
            <dt>Response due</dt>
            <dd>within {rt.sla_hours} hours</dd>
          </dl>

          {ex.reasons?.length > 0 && (
            <>
              <h3 style={{ marginTop: 20 }}>Why this priority?</h3>
              <ul className="muted" style={{ marginTop: 0, paddingLeft: 20 }}>
                {ex.reasons.map((r, i) => <li key={i}>{r}</li>)}
              </ul>
            </>
          )}

          {ex.alternatives?.length > 1 && (
            <p className="muted">
              Other possible categories considered:{' '}
              {ex.alternatives.slice(1).map((a) => `${a.label} (${Math.round(a.confidence * 100)}%)`).join(', ')}.
              An officer can re-route it if the automatic choice is wrong.
            </p>
          )}

          <div style={{ display: 'flex', gap: 10, marginTop: 22, flexWrap: 'wrap' }}>
            <Link to={`/track?id=${result.tracking_id}`}>
              <button className="btn-primary">Track this complaint</button>
            </Link>
            <button
              className="btn-secondary"
              onClick={() => {
                setResult(null);
                setForm({ ...form, text: '', address: '' });
              }}
            >
              Submit another
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ----- form -----
  return (
    <div className="container narrow">
      <h1 className="page-title">File a Grievance</h1>
      <p className="subtitle">
        Describe your problem in your own words. The system automatically identifies the right
        department, decides how urgent it is, and sends it to the responsible officer.
      </p>

      <form className="card" onSubmit={onSubmit}>
        <Alert kind="error" onClose={() => setError('')}>{error}</Alert>

        {!user && (
          <Alert kind="info">
            You are not logged in. You can still file a complaint — just give a name and phone
            number so the department can reach you. <Link to="/login">Log in</Link> to see all
            your complaints in one place.
          </Alert>
        )}

        <div className="field">
          <label htmlFor="text">What is the problem? *</label>
          <textarea
            id="text"
            value={form.text}
            onChange={set('text')}
            required
            minLength={10}
            maxLength={5000}
            placeholder="Example: No water supply in ward 7 for the last 10 days. We have complained twice already and there has been no response."
          />
          <div className="hint">
            {form.text.length}/5000 characters. Write in English, Malayalam or Hindi — including
            transliterated text like “vellam varunnilla”. Mention how long it has been happening
            and whether anyone is at risk.
          </div>
        </div>

        <div className="field">
          <div className="hint" style={{ marginBottom: 6 }}>Need help starting? Tap an example:</div>
          <div className="chips">
            {EXAMPLES.map((ex) => (
              <button
                type="button"
                key={ex}
                className="chip"
                onClick={() => setForm({ ...form, text: ex })}
              >
                {ex}
              </button>
            ))}
          </div>
        </div>

        <div className="row">
          <div className="field">
            <label htmlFor="locality">Ward / Village / Town</label>
            <input id="locality" value={form.locality} onChange={set('locality')}
                   placeholder="e.g. Erattupetta" maxLength={120} />
            <div className="hint">Helps us spot repeated reports of the same issue.</div>
          </div>
          <div className="field">
            <label htmlFor="language">Language</label>
            <select id="language" value={form.language} onChange={set('language')}>
              {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
            </select>
          </div>
        </div>

        <div className="field">
          <label htmlFor="address">Exact location / landmark (optional)</label>
          <input id="address" value={form.address} onChange={set('address')}
                 placeholder="e.g. Near the government school, MG Road" maxLength={300} />
        </div>

        {!user && (
          <div className="row">
            <div className="field">
              <label htmlFor="cname">Your name *</label>
              <input id="cname" value={form.citizen_name} onChange={set('citizen_name')}
                     required maxLength={120} />
            </div>
            <div className="field">
              <label htmlFor="cphone">Phone number *</label>
              <input id="cphone" value={form.citizen_phone} onChange={set('citizen_phone')}
                     required maxLength={20} placeholder="10-digit mobile" />
            </div>
          </div>
        )}

        <button className="btn-primary" type="submit" disabled={busy || form.text.trim().length < 10}>
          {busy ? <><Spinner /> Analysing your complaint…</> : 'Submit complaint'}
        </button>
      </form>
    </div>
  );
}
