"""FastAPI grievance intelligence service.

Endpoints
    GET  /health        liveness + model metadata
    GET  /taxonomy      category -> department routing table
    POST /predict       category + department + priority + urgency (+ duplicates)
    POST /duplicates    standalone near-duplicate check
    POST /batch         bulk scoring for backfills / analytics

The service is stateless. The Node backend owns all persistence and sends the
duplicate-candidate set with each request.
"""

from __future__ import annotations

import json
import pathlib
import time
from contextlib import asynccontextmanager
from typing import Any

import joblib
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .duplicates import Candidate, find_duplicates
from .features import priority_score, signal_breakdown
from .taxonomy import CATEGORIES, PRIORITY_LEVELS, department_for

ROOT = pathlib.Path(__file__).resolve().parents[1]
MODEL_DIR = ROOT / "models"

STATE: dict[str, Any] = {"category": None, "priority": None, "metrics": {}, "loaded_at": None}


def _load_models() -> None:
    cat_path = MODEL_DIR / "category_model.joblib"
    pri_path = MODEL_DIR / "priority_model.joblib"
    met_path = MODEL_DIR / "metrics.json"

    if not cat_path.exists():
        raise RuntimeError(
            f"category model missing at {cat_path}. Run `python train.py` in ml-service/ first."
        )

    STATE["category"] = joblib.load(cat_path)
    STATE["priority"] = joblib.load(pri_path) if pri_path.exists() else None
    STATE["metrics"] = json.loads(met_path.read_text()) if met_path.exists() else {}
    STATE["loaded_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


@asynccontextmanager
async def lifespan(app: FastAPI):
    _load_models()
    yield
    STATE.clear()


app = FastAPI(
    title="Grievance Intelligence Service",
    description="Category classification, priority scoring and duplicate detection "
                "for the citizen grievance portal.",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------
class CandidateIn(BaseModel):
    id: str
    text: str
    category: str | None = None
    locality: str | None = None
    status: str | None = None


class PredictIn(BaseModel):
    text: str = Field(..., min_length=3, max_length=8000,
                      description="Raw complaint text as typed by the citizen.")
    locality: str | None = Field(None, description="Ward / village / town of the issue.")
    language: str | None = Field(None, description="BCP-47 hint, e.g. 'ml', 'hi', 'en'.")
    candidates: list[CandidateIn] = Field(
        default_factory=list,
        description="Recent open complaints to check for duplication.",
    )
    top_k: int = Field(3, ge=1, le=12, description="How many category guesses to return.")


class BatchIn(BaseModel):
    items: list[PredictIn]


class DuplicatesIn(BaseModel):
    text: str
    category: str | None = None
    locality: str | None = None
    candidates: list[CandidateIn]
    threshold: float = 0.50


# ---------------------------------------------------------------------------
# Core inference
# ---------------------------------------------------------------------------
def _predict_category(text: str, top_k: int) -> tuple[str, float, list[dict]]:
    bundle = STATE["category"]
    if bundle is None:
        raise HTTPException(503, "category model not loaded")
    pipe = bundle["pipeline"]
    probs = pipe.predict_proba([text])[0]
    classes = list(pipe.classes_)
    ranked = sorted(zip(classes, probs), key=lambda kv: -kv[1])
    alts = [
        {
            "category": c,
            "label": CATEGORIES.get(c, {}).get("label", c),
            "confidence": round(float(p), 4),
        }
        for c, p in ranked[:top_k]
    ]
    return ranked[0][0], float(ranked[0][1]), alts


def _priority_probability(text: str) -> float | None:
    bundle = STATE["priority"]
    if bundle is None:
        return None
    return float(bundle["pipeline"].predict_proba([text])[0][1])


def _urgency_band(signals: dict) -> str:
    u = signals["urgency"]
    if u >= 0.85:
        return "immediate"
    if u >= 0.55:
        return "soon"
    if u >= 0.25:
        return "routine"
    return "none_stated"


def _sla_hours(category: str, level: str) -> int:
    """Priority compresses the category's base SLA."""
    base = department_for(category)["sla_hours"]
    factor = {"critical": 0.15, "high": 0.4, "medium": 1.0, "low": 1.6}[level]
    return max(2, int(round(base * factor)))


def run_prediction(payload: PredictIn) -> dict:
    started = time.perf_counter()
    text = payload.text.strip()

    category, confidence, alternatives = _predict_category(text, payload.top_k)
    meta = department_for(category)
    signals = signal_breakdown(text)

    dup = find_duplicates(
        text,
        [Candidate(**c.model_dump()) for c in payload.candidates],
        category=category,
        locality=payload.locality,
    )

    prio = priority_score(
        text,
        category,
        repeat_count=dup.get("repeat_count", 0),
        model_probability=_priority_probability(text),
    )

    # Low model confidence => flag for human triage rather than silent misrouting.
    needs_review = confidence < 0.45 or (
        len(alternatives) > 1 and confidence - alternatives[1]["confidence"] < 0.12
    )

    return {
        "category": category,
        "category_label": meta["label"],
        "confidence": round(confidence, 4),
        "alternatives": alternatives,
        "department": meta["department"],
        "department_code": meta["department_code"],
        "escalation_chain": meta["escalation_chain"],
        "priority": prio["level"],
        "priority_score": prio["score"],
        "priority_components": prio["components"],
        "priority_reasons": prio["reasons"],
        "urgency": _urgency_band(signals),
        "urgency_score": signals["urgency"],
        "severity_score": signals["severity"],
        "risk_score": signals["risk"],
        "signals": signals,
        "sla_hours": _sla_hours(category, prio["level"]),
        "duplicate": dup,
        "needs_human_review": bool(needs_review),
        "language_hint": payload.language,
        "model_version": STATE["metrics"].get("trained_at", "unknown"),
        "latency_ms": round((time.perf_counter() - started) * 1000, 2),
    }


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@app.get("/health")
def health() -> dict:
    return {
        "status": "ok" if STATE.get("category") else "degraded",
        "models_loaded": {
            "category": STATE.get("category") is not None,
            "priority": STATE.get("priority") is not None,
        },
        "loaded_at": STATE.get("loaded_at"),
        "metrics": {
            "category_accuracy": STATE["metrics"].get("category_model", {}).get("accuracy"),
            "category_macro_f1": STATE["metrics"].get("category_model", {}).get("macro_f1"),
            "priority_roc_auc": STATE["metrics"].get("priority_model", {}).get("roc_auc"),
            "trained_at": STATE["metrics"].get("trained_at"),
            "corpus_size": STATE["metrics"].get("corpus_size"),
        },
    }


@app.get("/taxonomy")
def taxonomy() -> dict:
    return {
        "categories": [
            {"key": k, **{kk: vv for kk, vv in v.items()}} for k, v in CATEGORIES.items()
        ],
        "priority_levels": PRIORITY_LEVELS,
    }


@app.post("/predict")
def predict(payload: PredictIn) -> dict:
    return run_prediction(payload)


@app.post("/duplicates")
def duplicates(payload: DuplicatesIn) -> dict:
    return find_duplicates(
        payload.text,
        [Candidate(**c.model_dump()) for c in payload.candidates],
        category=payload.category,
        locality=payload.locality,
        threshold=payload.threshold,
    )


@app.post("/batch")
def batch(payload: BatchIn) -> dict:
    if len(payload.items) > 200:
        raise HTTPException(413, "batch limited to 200 items")
    return {"results": [run_prediction(item) for item in payload.items]}


@app.post("/reload")
def reload_models() -> dict:
    _load_models()
    return {"reloaded": True, "loaded_at": STATE["loaded_at"]}
