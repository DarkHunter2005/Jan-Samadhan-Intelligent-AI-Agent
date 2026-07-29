/**
 * Client for the Python ML service.
 *
 * Two guarantees matter here:
 *  1. A citizen's complaint is NEVER lost because the ML service is down.
 *     If prediction fails we fall back to a keyword classifier and flag the
 *     complaint for human triage.
 *  2. Calls are bounded: timeout + limited retries with backoff.
 */
import { config } from '../config.js';

/** Minimal keyword fallback used only when the ML service is unreachable. */
const FALLBACK_RULES = [
  ['water_supply',        'Water Supply',            'KWA',  ['water', 'tap', 'pipe', 'vellam', 'paani', 'drinking']],
  ['electricity',         'Electricity',             'KSEB', ['power', 'current', 'electric', 'transformer', 'street light', 'bijli', 'voltage']],
  ['roads_transport',     'Roads & Transport',       'PWD',  ['road', 'pothole', 'kuzhi', 'bridge', 'footpath', 'tar']],
  ['sanitation_waste',    'Sanitation & Waste',      'MHW',  ['garbage', 'waste', 'drain', 'sewage', 'mosquito', 'toilet', 'kachra']],
  ['health_medical',      'Health & Medical',        'DHS',  ['hospital', 'doctor', 'medicine', 'ambulance', 'phc', 'fever', 'dengue']],
  ['police_safety',       'Police & Public Safety',  'POL',  ['police', 'fir', 'theft', 'threat', 'harass', 'assault', 'crime']],
  ['education',           'Education',               'EDU',  ['school', 'teacher', 'student', 'midday', 'scholarship', 'anganwadi']],
  ['revenue_certificates','Revenue & Certificates',  'REV',  ['certificate', 'village office', 'land', 'tax', 'survey', 'ration card']],
  ['welfare_pension',     'Welfare & Pension',       'SJD',  ['pension', 'welfare', 'widow', 'disability', 'scheme', 'beneficiary']],
  ['corruption_bribery',  'Corruption & Bribery',    'VACB', ['bribe', 'corruption', 'kaikkooli', 'rishwat', 'commission', 'misuse']],
  ['transport_rto',       'Motor Vehicles & RTO',    'MVD',  ['licence', 'license', 'rto', 'bus', 'auto', 'vehicle', 'registration']],
  ['municipal_admin',     'Municipal Administration','LSG',  ['municipality', 'panchayat', 'building permit', 'stray dog', 'encroach']],
];

const URGENT_WORDS = ['urgent', 'emergency', 'immediately', 'critical', 'danger', 'injured',
                      'death', 'fire', 'accident', 'turant', 'adiyanthiram'];

export function fallbackPredict(text, locality) {
  const lower = String(text || '').toLowerCase();

  let best = { key: 'municipal_admin', label: 'Municipal Administration', code: 'LSG', hits: 0 };
  for (const [key, label, code, words] of FALLBACK_RULES) {
    const hits = words.reduce((n, w) => n + (lower.includes(w) ? 1 : 0), 0);
    if (hits > best.hits) best = { key, label, code, hits };
  }

  const urgentHits = URGENT_WORDS.filter((w) => lower.includes(w)).length;
  const priority = urgentHits >= 2 ? 'high' : urgentHits === 1 ? 'medium' : 'medium';

  return {
    category: best.key,
    category_label: best.label,
    confidence: best.hits ? Math.min(0.4, 0.15 * best.hits) : 0.1,
    alternatives: [],
    department: best.label,
    department_code: best.code,
    escalation_chain: [],
    priority,
    priority_score: urgentHits ? 55 : 40,
    priority_reasons: ['ML service unavailable - keyword fallback used'],
    urgency: urgentHits ? 'soon' : 'none_stated',
    urgency_score: urgentHits ? 0.5 : 0,
    severity_score: 0,
    sla_hours: 72,
    duplicate: { is_duplicate: false, matches: [], duplicate_ids: [], repeat_count: 0, best_score: 0 },
    needs_human_review: true,       // always route fallback results to a human
    degraded: true,
    locality,
  };
}

async function postJson(path, body, { timeoutMs, retries }) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${config.ml.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`ML service responded ${res.status}: ${await res.text()}`);
      return await res.json();
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 150 * 2 ** attempt)); // 150ms, 300ms
      }
    }
  }
  throw lastError;
}

/**
 * Predict category/priority/duplicates for a complaint.
 * Never throws: on failure it returns the degraded keyword-based prediction.
 */
export async function predict({ text, locality, language, candidates = [] }) {
  try {
    const result = await postJson(
      '/predict',
      { text, locality, language, candidates, top_k: 3 },
      { timeoutMs: config.ml.timeoutMs, retries: config.ml.retries }
    );
    return { ...result, degraded: false };
  } catch (err) {
    console.error('[mlClient] prediction failed, using fallback:', err.message);
    return fallbackPredict(text, locality);
  }
}

export async function health() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    const res = await fetch(`${config.ml.baseUrl}/health`, { signal: controller.signal });
    clearTimeout(timer);
    return { reachable: res.ok, ...(res.ok ? await res.json() : {}) };
  } catch (err) {
    return { reachable: false, error: err.message };
  }
}
