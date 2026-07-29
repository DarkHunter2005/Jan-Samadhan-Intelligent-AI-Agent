# Jan Samadhan — Intelligent AI Agent for Government Grievance Services

A full-stack grievance management system. Citizens submit complaints in plain language; the
system classifies them, scores urgency, detects duplicates, routes them to the right
department, and escalates them up the authority ladder when SLAs are breached.

```
React (Vite)  ──▶  Node.js / Express  ──▶  Python FastAPI (scikit-learn)
   :5173             :4000  ──▶ SQLite        :8000  /predict /duplicates
```

---

## Quick start

**Requirements:** Node.js 18+, Python 3.9+

```bash
cd grievance-ai
./scripts/start-all.sh --seed
```

That single command trains the models (first run only), starts all three services, seeds demo
data, and waits until everything is healthy. Then open **http://localhost:5173**.

To stop everything:

```bash
./scripts/stop-all.sh
```

### Demo accounts

Password for all: `password123`

| Role | Email | What you see |
|---|---|---|
| Citizen | `ravi@example.com` | File complaints, track status, rate resolutions |
| Officer | `kseb@gov.in` | Only Electricity Board complaints, status updates |
| Officer | `kwa@gov.in` | Only Water Authority complaints |
| Admin | `admin@gov.in` | All departments, analytics, re-routing, escalation |

You can also file and track a complaint **without logging in** — tracking IDs work anonymously.

---

## Manual start (three terminals)

If you prefer to run each service yourself:

```bash
# Terminal 1 — ML service
cd ml-service
pip install -r requirements.txt
python train.py                 # writes models/*.joblib (~12s)
uvicorn app.main:app --port 8000

# Terminal 2 — backend
cd backend
npm install
npm run seed                    # optional demo data
npm start                       # http://localhost:4000

# Terminal 3 —  
cd frontend
npm install
npm run dev                     # http://localhost:5173
```

Start order matters only for seeding: the ML service should be up before `npm run seed`, so
seeded complaints get real predictions.

---

## Try it out

1. Go to http://localhost:5173 and paste:
   > *"URGENT! A live electric wire has fallen near the school and a child was injured. Please act immediately!"*

   It is classified as **Electricity → State Electricity Board**, priority **critical**, with a
   4-hour SLA and a plain-English explanation of why.

2. Submit a near-identical complaint. It is detected as a **duplicate**, linked to the original,
   and the parent's repeat counter goes up instead of creating a second ticket.

3. Copy the tracking ID → **Track** page (no login) → see the progress timeline.

4. Sign in as `admin@gov.in` → **Dashboard** → charts, SLA breaches, and a
   **Run SLA escalation** button that walks overdue complaints up the authority ladder.

---

## Running the tests

```bash
# ML service — 33 tests
cd ml-service && python -m pytest tests/ -q

# Backend — 26 tests
cd backend && npm test

# Full-stack end-to-end — 61 checks (services must be running)
SUBMIT_RATE_LIMIT=500 ./scripts/start-all.sh --seed
python3 scripts/e2e_test.py
```

> The e2e suite submits many complaints quickly, so raise `SUBMIT_RATE_LIMIT` — the production
> default of 20 posts / 15 min per IP is an anti-spam measure and will otherwise return HTTP 429.

---

## How the ML works

**Category classification** — TF-IDF (word 1–2 grams + character 3–5 grams, so typos and
transliteration still match) → Logistic Regression. Character n-grams are what let
*"vellam varunnilla"* and *"paani nahi aa raha"* route to the Water Authority.

| Metric | Score |
|---|---|
| Category accuracy (held-out) | **97.4%** |
| Category macro-F1 | **0.974** |
| 3-fold CV accuracy | **97.8% ± 0.2%** |
| Priority ROC-AUC | **0.968** |

Swap the classifier with `python train.py --model rf` (Random Forest) or `--model svm`.

**Priority scoring** is deliberately *not* a black box. It blends a learned model (35%) with an
explainable structured index (65%):

```
score = 0.40·severity + 0.25·urgency + 0.20·frequency + 0.15·risk
```

…plus hard safety overrides (life-threatening language can never be triaged below *high*) and a
per-category floor (a bribery allegation never lands in *low* just because it is worded calmly).
Every score ships with human-readable reasons, which is what the citizen and the officer see.

**Duplicate detection** combines character/word cosine, Jaccard, and an overlap coefficient
(so a short "no water ward 7" matches a long detailed report of the same outage), then multiplies
by category and locality agreement. A **place-conflict gate** stops the classic false positive
where *"road damaged at Poonjar"* matches *"road damaged at Vaikom"*.

Calibrated on a labelled pair set: **7/7 recall, 0 false positives**, with positives ≥ 0.573 and
negatives ≤ 0.332 — a wide margin around the 0.50 threshold.

---

## Design decisions worth knowing

**The ML service can never lose a complaint.** If `/predict` times out or crashes, the backend
falls back to a keyword classifier, still stores and routes the complaint, and flags it
`needs_human_review`. Submission never fails because a model is down.

**Duplicates are linked, not silently closed.** Only very high similarity (≥ 0.72) auto-merges.
Anything below is recorded as a related link. A citizen must not lose their ticket to a false
positive — and the parent's priority can only ever go *up* when duplicates arrive, never down.

**Low-confidence predictions are not auto-assigned.** If the model is unsure, the complaint waits
in triage rather than burning an officer's SLA clock on a wrong guess.

**Officers are hard-scoped to their department** at the query layer — a KSEB officer cannot read
or modify a PWD complaint even by passing a different `?department=` filter.

**Closing a ticket requires a note.** `resolved` and `rejected` are rejected without an
explanation, so every closure is accountable and appears in the audit trail.

**Escalation grants a fresh, shorter deadline** at each rung rather than leaving the ticket
permanently overdue, and stops cleanly at the top of the ladder.

---

## Project layout

```
grievance-ai/
├── ml-service/              Python FastAPI + scikit-learn
│   ├── app/
│   │   ├── taxonomy.py      12 categories → departments, SLAs, escalation chains
│   │   ├── dataset.py       synthetic corpus (typos, code-mixing, ambiguous cases)
│   │   ├── features.py      lexicon features + explainable priority index
│   │   ├── duplicates.py    near-duplicate detection
│   │   └── main.py          /predict /duplicates /batch /taxonomy /health
│   ├── train.py             trains + evaluates, writes models/ and metrics.json
│   └── tests/               33 pytest tests
├── backend/                 Node.js + Express
│   ├── src/
│   │   ├── db/index.js      all SQL lives here (swap this file for Postgres/Mongo)
│   │   ├── services/
│   │   │   ├── mlClient.js  retries, timeout, keyword fallback
│   │   │   └── routing.js   routing, SLA, escalation, duplicate merge rules
│   │   ├── routes/          auth, complaints, admin
│   │   └── middleware/      JWT auth, role guards, zod validation
│   └── tests/               26 node:test tests
├── frontend/                React 18 + Vite + Recharts
│   └── src/pages/           Submit, Track, Login, MyComplaints, Dashboard, Detail
└── scripts/
    ├── start-all.sh         one-command startup
    ├── stop-all.sh
    └── e2e_test.py          61 full-stack checks
```

---

## API reference

| Method | Endpoint | Auth | Purpose |
|---|---|---|---|
| POST | `/api/auth/register` | — | Citizen self-registration |
| POST | `/api/auth/login` | — | Returns JWT |
| POST | `/api/complaints` | optional | Submit (anonymous allowed with name + phone) |
| GET | `/api/complaints/track/:id` | — | Public status lookup, hides personal data |
| GET | `/api/complaints/mine` | citizen | Own complaints |
| GET | `/api/complaints` | staff | Dashboard listing, filters + pagination |
| GET | `/api/complaints/:id` | owner/staff | Full detail incl. stored ML payload |
| PATCH | `/api/complaints/:id/status` | staff | Status transition (validated state machine) |
| PATCH | `/api/complaints/:id/assign` | admin | Correct department / priority |
| POST | `/api/complaints/:id/feedback` | owner | Rate a resolved complaint |
| GET | `/api/admin/stats` | staff | Analytics |
| POST | `/api/admin/escalate` | admin | Run the SLA sweep manually |

Interactive ML API docs: **http://localhost:8000/docs**

---

## Configuration

Copy `backend/.env.example` to `backend/.env`. Key settings:

| Variable | Default | Notes |
|---|---|---|
| `JWT_SECRET` | dev placeholder | **Required in production** — the app refuses to boot otherwise |
| `DB_FILE` | `./data/grievance.db` | SQLite path |
| `ML_URL` | `http://127.0.0.1:8000` | ML service base URL |
| `ML_TIMEOUT_MS` / `ML_RETRIES` | 6000 / 2 | Bounded calls with backoff |
| `ESCALATION_INTERVAL_MS` | 60000 | Background SLA sweep; `0` disables |
| `SUBMIT_RATE_LIMIT` | 20 | POSTs per IP per 15 min |

---

## Notes and limitations

- **The training corpus is synthetic.** Templates were built to mirror real Kerala-portal
  phrasing (code-mixing, typos, terse mobile input, genuinely ambiguous cross-department cases),
  but the reported accuracy reflects that generated distribution — not live CPGRAMS traffic.
  Retrain on real exports before drawing conclusions about production performance.
- **SQLite is used for zero-setup runnability.** Every SQL statement is confined to
  `backend/src/db/index.js`, so moving to PostgreSQL or MongoDB means reimplementing that one
  module against the same repository contract.
- **Multilingual support is transliteration-based.** Romanised Malayalam/Hindi is handled well
  because of character n-grams; native Devanagari/Malayalam script would need either a
  transliteration step or a multilingual embedding model (e.g. IndicBERT).
- Admin-corrected routings are stored in the audit trail and are the natural training signal for
  a future retraining loop — that loop is not implemented yet.


## Add screen recording demo
  https://drive.google.com/file/d/1fzp1M6VXBB2kfFSfd0XBe-Z_izyje_i0/view?usp=sharing
