import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, auth } from '../lib/api.js';
import { Alert, Spinner } from '../components/common.jsx';

const DEMO = [
  ['Citizen', 'ravi@example.com'],
  ['Officer (Electricity)', 'kseb@gov.in'],
  ['Officer (Water)', 'kwa@gov.in'],
  ['Admin', 'admin@gov.in'],
];

export default function Login({ onAuth }) {
  const nav = useNavigate();
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ name: '', email: '', password: '', phone: '', locality: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = mode === 'login'
        ? await api.login({ email: form.email.trim(), password: form.password })
        : await api.register({
            name: form.name.trim(),
            email: form.email.trim(),
            password: form.password,
            ...(form.phone.trim() ? { phone: form.phone.trim() } : {}),
            ...(form.locality.trim() ? { locality: form.locality.trim() } : {}),
          });
      auth.save(res.token, res.user);
      onAuth?.(res.user);
      nav(res.user.role === 'citizen' ? '/my-complaints' : '/dashboard');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="container narrow" style={{ maxWidth: 470 }}>
      <h1 className="page-title">{mode === 'login' ? 'Sign in' : 'Create an account'}</h1>
      <p className="subtitle">
        {mode === 'login'
          ? 'Citizens, department officers and administrators sign in here.'
          : 'Register as a citizen to file and follow up on complaints.'}
      </p>

      <form className="card" onSubmit={submit}>
        <Alert kind="error" onClose={() => setError('')}>{error}</Alert>

        {mode === 'register' && (
          <div className="field">
            <label htmlFor="name">Full name</label>
            <input id="name" value={form.name} onChange={set('name')} required minLength={2} />
          </div>
        )}

        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" type="email" value={form.email} onChange={set('email')}
                 required autoComplete="username" />
        </div>

        <div className="field">
          <label htmlFor="password">Password</label>
          <input id="password" type="password" value={form.password} onChange={set('password')}
                 required minLength={mode === 'register' ? 8 : 1}
                 autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
          {mode === 'register' && <div className="hint">At least 8 characters.</div>}
        </div>

        {mode === 'register' && (
          <div className="row">
            <div className="field">
              <label htmlFor="phone">Phone (optional)</label>
              <input id="phone" value={form.phone} onChange={set('phone')} />
            </div>
            <div className="field">
              <label htmlFor="locality">Ward / Town (optional)</label>
              <input id="locality" value={form.locality} onChange={set('locality')} />
            </div>
          </div>
        )}

        <button className="btn-primary" type="submit" disabled={busy} style={{ width: '100%' }}>
          {busy ? <Spinner /> : mode === 'login' ? 'Sign in' : 'Create account'}
        </button>

        <p className="muted" style={{ textAlign: 'center', marginBottom: 0, marginTop: 14 }}>
          {mode === 'login' ? (
            <>New here? <button type="button" className="btn-secondary btn-sm"
              onClick={() => { setMode('register'); setError(''); }}>Create an account</button></>
          ) : (
            <>Already registered? <button type="button" className="btn-secondary btn-sm"
              onClick={() => { setMode('login'); setError(''); }}>Sign in</button></>
          )}
        </p>
      </form>

      {mode === 'login' && (
        <div className="card">
          <h3>Demo accounts</h3>
          <p className="muted" style={{ marginTop: 0 }}>
            Password for all demo accounts: <span className="mono">password123</span>
          </p>
          <div className="chips">
            {DEMO.map(([label, email]) => (
              <button key={email} type="button" className="chip"
                      onClick={() => setForm({ ...form, email, password: 'password123' })}>
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      <p className="muted" style={{ textAlign: 'center' }}>
        You can also <Link to="/">file a complaint</Link> or{' '}
        <Link to="/track">track one</Link> without an account.
      </p>
    </div>
  );
}
