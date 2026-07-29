"""Lexicon feature extraction + structured priority scoring.

Two things live here:

1. `LexiconFeatures` - a scikit-learn transformer that turns raw complaint text into
   dense signals (urgency / severity / frequency / risk / length). It is unioned with
   TF-IDF so the priority model sees both vocabulary and hand-crafted risk signals.

2. `priority_score` - the explainable structured score used by the API. Research
   prototypes in grievance routing typically combine severity, urgency, frequency and
   risk into a weighted index; we do the same and blend it with the learned model.
"""

from __future__ import annotations

import math
import re

import numpy as np
from sklearn.base import BaseEstimator, TransformerMixin

from .taxonomy import (
    FREQUENCY_TERMS,
    PRIORITY_LEVELS,
    RISK_TERMS,
    SEVERITY_TERMS,
    URGENCY_TERMS,
    department_for,
)

_WS = re.compile(r"\s+")
_NON_WORD = re.compile(r"[^a-z0-9\s]")


def normalize(text: str) -> str:
    """Lowercase, strip punctuation and collapse whitespace."""
    return _WS.sub(" ", _NON_WORD.sub(" ", (text or "").lower())).strip()


_WORD_NUMBERS = {
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7,
    "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12, "fifteen": 15,
    "twenty": 20, "thirty": 30, "forty": 40, "fifty": 50, "couple": 2, "few": 3,
    "several": 4, "many": 6, "a": 1, "an": 1, "last": 1, "past": 1,
}

_UNIT_DAYS = {"day": 1, "days": 1, "week": 7, "weeks": 7, "month": 30,
              "months": 30, "year": 365, "years": 365}

_DURATION_RE = re.compile(
    r"(\d+|" + "|".join(_WORD_NUMBERS) + r")\s+(day|days|week|weeks|month|months|year|years)"
)


def _duration_days(norm_text: str) -> int:
    """Largest duration mentioned in the text, expressed in days (0 if none).

    Handles both digits ("10 days") and spelled-out numbers ("three months"),
    which citizens use interchangeably.
    """
    best = 0
    for qty_raw, unit in _DURATION_RE.findall(norm_text):
        qty = int(qty_raw) if qty_raw.isdigit() else _WORD_NUMBERS.get(qty_raw, 1)
        best = max(best, qty * _UNIT_DAYS[unit])
    if "more than a year" in norm_text or "over a year" in norm_text:
        best = max(best, 365)
    return best


def _lexicon_hits(norm_text: str, lexicon: dict[str, float]) -> tuple[float, list[str]]:
    """Return (saturating score in 0-1, matched terms) for one lexicon."""
    hits: list[tuple[str, float]] = []
    for term, weight in lexicon.items():
        if term in norm_text:
            hits.append((term, weight))
    if not hits:
        return 0.0, []
    hits.sort(key=lambda kv: -kv[1])
    # Strongest term dominates; extra matches add with diminishing returns.
    score = hits[0][1]
    for _, w in hits[1:4]:
        score += w * 0.18
    return min(score, 1.0), [t for t, _ in hits[:6]]


def signal_breakdown(text: str) -> dict:
    """Compute the four structured signals plus supporting evidence."""
    norm = normalize(text)
    urgency, u_terms = _lexicon_hits(norm, URGENCY_TERMS)
    severity, s_terms = _lexicon_hits(norm, SEVERITY_TERMS)
    frequency, f_terms = _lexicon_hits(norm, FREQUENCY_TERMS)
    risk, r_terms = _lexicon_hits(norm, RISK_TERMS)

    # Exclamation marks and ALL-CAPS shouting are weak urgency proxies.
    raw = text or ""
    if raw.count("!") >= 2:
        urgency = min(1.0, urgency + 0.15)
    letters = [c for c in raw if c.isalpha()]
    if len(letters) > 20 and sum(c.isupper() for c in letters) / len(letters) > 0.6:
        urgency = min(1.0, urgency + 0.15)

    # Explicit duration phrases ("10 days", "three months") raise the neglect signal.
    days = _duration_days(norm)
    if days:
        frequency = min(1.0, max(frequency, math.log1p(days) / math.log1p(365)))

    return {
        "urgency": round(urgency, 4),
        "severity": round(severity, 4),
        "frequency": round(frequency, 4),
        "risk": round(risk, 4),
        "evidence": {
            "urgency_terms": u_terms,
            "severity_terms": s_terms,
            "frequency_terms": f_terms,
            "risk_terms": r_terms,
        },
    }


class LexiconFeatures(BaseEstimator, TransformerMixin):
    """Vectorises complaint text into 6 dense lexicon/statistical features."""

    feature_names = ["urgency", "severity", "frequency", "risk", "log_len", "has_digit"]

    def fit(self, X, y=None):  # noqa: N803 - sklearn API
        return self

    def transform(self, X):  # noqa: N803 - sklearn API
        rows = []
        for text in X:
            sig = signal_breakdown(text)
            norm = normalize(text)
            rows.append(
                [
                    sig["urgency"],
                    sig["severity"],
                    sig["frequency"],
                    sig["risk"],
                    math.log1p(len(norm)) / 8.0,
                    1.0 if any(c.isdigit() for c in norm) else 0.0,
                ]
            )
        return np.asarray(rows, dtype=np.float64)

    def get_feature_names_out(self, input_features=None):
        return np.asarray(self.feature_names, dtype=object)


# ---------------------------------------------------------------------------
# Structured priority index
# ---------------------------------------------------------------------------
WEIGHTS = {"severity": 0.40, "urgency": 0.25, "frequency": 0.20, "risk": 0.15}

# Priority band thresholds on the 0-100 score.
BANDS = [(75, "critical"), (55, "high"), (32, "medium"), (0, "low")]


def priority_score(
    text: str,
    category: str,
    *,
    repeat_count: int = 0,
    model_probability: float | None = None,
) -> dict:
    """Blend structured signals, category prior and (optionally) the learned model.

    Args:
        text: raw complaint text.
        category: predicted/known category key, used for its base severity prior.
        repeat_count: how many similar complaints already exist (duplicate pressure).
        model_probability: P(high|critical) from the trained priority model, 0-1.

    Returns a dict with the 0-100 score, band, component contributions and reasons.
    """
    sig = signal_breakdown(text)
    meta = department_for(category)
    base = meta["base_severity"]

    # Category prior lifts severity when the text itself is terse.
    severity = min(1.0, 0.55 * sig["severity"] + 0.45 * base + 0.25 * sig["severity"] * base)

    # Repeated/duplicate complaints add measurable pressure (capped).
    freq = min(1.0, sig["frequency"] + min(repeat_count, 5) * 0.12)

    structured = (
        WEIGHTS["severity"] * severity
        + WEIGHTS["urgency"] * sig["urgency"]
        + WEIGHTS["frequency"] * freq
        + WEIGHTS["risk"] * sig["risk"]
    )

    if model_probability is None:
        blended = structured
    else:
        # 65% structured (explainable, stable) / 35% learned (captures phrasing).
        blended = 0.65 * structured + 0.35 * float(model_probability)

    score = round(min(100.0, max(0.0, blended * 100)), 2)

    # Category baseline floor: some subject matter is inherently non-trivial even
    # when the citizen writes calmly. A bribery allegation or a safety complaint
    # must never be triaged as "low" just because it lacks dramatic wording.
    floor = round(base * 45, 2)
    if score < floor:
        score = floor

    band = "low"
    for threshold, name in BANDS:
        if score >= threshold:
            band = name
            break

    # Hard safety overrides: life-threatening language never lands below high.
    overrides: list[str] = []
    if sig["severity"] >= 0.9 and band in ("low", "medium"):
        band = "high"
        score = max(score, 60.0)
        overrides.append("life-safety keyword override")
    if sig["severity"] >= 0.9 and sig["urgency"] >= 0.9:
        band = "critical"
        score = max(score, 80.0)
        overrides.append("severity+urgency critical override")

    reasons: list[str] = []
    ev = sig["evidence"]
    if ev["severity_terms"]:
        reasons.append("severity indicators: " + ", ".join(ev["severity_terms"][:3]))
    if ev["urgency_terms"]:
        reasons.append("urgency indicators: " + ", ".join(ev["urgency_terms"][:3]))
    if ev["frequency_terms"]:
        reasons.append("repetition indicators: " + ", ".join(ev["frequency_terms"][:3]))
    if ev["risk_terms"]:
        reasons.append("public-risk indicators: " + ", ".join(ev["risk_terms"][:3]))
    if repeat_count:
        reasons.append(f"{repeat_count} similar complaint(s) already on record")
    if abs(score - floor) < 0.01:
        reasons.append(f"minimum priority floor applied for {meta['label']} complaints")
    reasons.extend(overrides)
    if not reasons:
        reasons.append("no strong urgency or severity signals detected in the text")

    return {
        "score": score,
        "level": band,
        "level_index": PRIORITY_LEVELS.index(band),
        "components": {
            "severity": round(severity, 4),
            "urgency": sig["urgency"],
            "frequency": round(freq, 4),
            "risk": sig["risk"],
            "category_prior": base,
            "model_probability": round(float(model_probability), 4) if model_probability is not None else None,
            "structured_index": round(structured, 4),
        },
        "weights": WEIGHTS,
        "reasons": reasons,
    }


def normalize_batch(texts):
    """Module-level (picklable) batch normalizer used inside sklearn pipelines."""
    return [normalize(t) for t in texts]
