/** Thin API client. Attaches the JWT and normalises errors into thrown Error objects. */

const BASE = import.meta.env.VITE_API_URL || '/api';
const TOKEN_KEY = 'grievance_token';
const USER_KEY = 'grievance_user';

export const auth = {
  token: () => localStorage.getItem(TOKEN_KEY),
  user: () => {
    try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); }
    catch { return null; }
  },
  save: (token, user) => {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  },
  clear: () => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  },
};

async function request(path, { method = 'GET', body, authed = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const token = auth.token();
  if (authed && token) headers.Authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error('Cannot reach the server. Please check your connection.');
  }

  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }

  if (!res.ok) {
    // Session expired: clear it so the UI can bounce the user to login.
    if (res.status === 401 && authed && token) auth.clear();

    const details = Array.isArray(data.details)
      ? ' ' + data.details.map((d) => `${d.field}: ${d.message}`).join('; ')
      : '';
    const err = new Error((data.error || `Request failed (${res.status})`) + details);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

const qs = (params) => {
  const clean = Object.fromEntries(
    Object.entries(params || {}).filter(([, v]) => v !== '' && v != null)
  );
  const s = new URLSearchParams(clean).toString();
  return s ? `?${s}` : '';
};

export const api = {
  // auth
  register: (b) => request('/auth/register', { method: 'POST', body: b, authed: false }),
  login: (b) => request('/auth/login', { method: 'POST', body: b, authed: false }),
  me: () => request('/auth/me'),

  // complaints
  submit: (b) => request('/complaints', { method: 'POST', body: b }),
  track: (id) => request(`/complaints/track/${encodeURIComponent(id)}`, { authed: false }),
  mine: (p) => request(`/complaints/mine${qs(p)}`),
  list: (p) => request(`/complaints${qs(p)}`),
  detail: (id) => request(`/complaints/${encodeURIComponent(id)}`),
  setStatus: (id, b) => request(`/complaints/${encodeURIComponent(id)}/status`, { method: 'PATCH', body: b }),
  assign: (id, b) => request(`/complaints/${encodeURIComponent(id)}/assign`, { method: 'PATCH', body: b }),
  feedback: (id, b) => request(`/complaints/${encodeURIComponent(id)}/feedback`, { method: 'POST', body: b }),

  // admin
  stats: () => request('/admin/stats'),
  departments: () => request('/admin/departments', { authed: false }),
  officers: (department) => request(`/admin/officers${qs({ department })}`),
  escalate: () => request('/admin/escalate', { method: 'POST' }),
  mlHealth: () => request('/admin/ml-health'),
};

// --------------------------------------------------------------------------
// Display helpers
// --------------------------------------------------------------------------
export const PRIORITY_COLORS = {
  critical: '#b3001b',
  high: '#e05200',
  medium: '#b58500',
  low: '#0b6b3a',
};

export const STATUS_LABELS = {
  submitted: 'Submitted',
  routed: 'Routed to department',
  in_progress: 'Work in progress',
  resolved: 'Resolved',
  rejected: 'Rejected',
  duplicate: 'Duplicate',
  reopened: 'Reopened',
};

/** SQLite timestamps are UTC without a zone marker — parse them explicitly. */
export function parseTs(ts) {
  if (!ts) return null;
  return new Date(ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z');
}

export function formatDate(ts) {
  const d = parseTs(ts);
  if (!d || Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export function timeUntil(ts) {
  const d = parseTs(ts);
  if (!d) return '—';
  const diffMs = d.getTime() - Date.now();
  const overdue = diffMs < 0;
  const hours = Math.floor(Math.abs(diffMs) / 3_600_000);
  const days = Math.floor(hours / 24);
  const label = days >= 1 ? `${days}d ${hours % 24}h` : `${hours}h`;
  return overdue ? `${label} overdue` : `${label} left`;
}
