"""Near-duplicate / repeat-issue detection for grievances.

Two complementary signals are combined:

1. **Lexical similarity** - TF-IDF character+word cosine over the candidate corpus.
   Robust to typos, catches reworded resubmissions of the same issue.
2. **Locality + category agreement** - two complaints are only "the same issue" if
   they concern the same category and the same place; a pothole in Palai is not a
   duplicate of a pothole in Vaikom.

The service is stateless: the backend sends the candidate set (recent open complaints
in the same locality) along with the new text, so no complaint data is stored here.
"""

from __future__ import annotations

import re

from dataclasses import dataclass

from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity

from .features import normalize

# Words too generic to identify a specific issue.
_STOP = {
    "the", "a", "an", "is", "are", "in", "at", "of", "and", "or", "to", "for", "on",
    "please", "sir", "madam", "kindly", "complaint", "not", "no", "we", "our", "my",
    "i", "this", "that", "it", "there", "here", "very", "also", "from", "with",
    "action", "take", "taken", "needful", "thanking", "you", "respected",
    # Grievance *meta* language: describes the act of complaining, not the issue.
    # Leaving these in dilutes similarity between two reports of the same problem.
    "complained", "complaint", "complaints", "complaining", "already", "times",
    "time", "please", "help", "kindly", "request", "requesting", "sir", "madam",
    "since", "still", "yet", "now", "again", "last", "past", "been", "being",
    "have", "has", "had", "will", "would", "should", "can", "cannot", "may",
    "us", "them", "they", "their", "who", "what", "when", "where", "why", "how",
    "area", "here", "there", "near", "nearby", "around", "some", "any", "all",
    "very", "much", "more", "most", "such", "same", "other", "another", "each",
    "authority", "officer", "office", "department", "government", "public",
    "resolve", "resolved", "solution", "issue", "problem", "matter", "regard",
    "attention", "immediate", "immediately", "urgent", "urgently", "earliest",
}


# Domain synonyms collapsed to a canonical token so that "garbage"/"waste"/"kachra"
# or "current"/"power"/"electricity" count as the same concept when comparing texts.
_SYNONYMS = {
    "garbage": "waste", "trash": "waste", "rubbish": "waste", "kachra": "waste",
    "malinyam": "waste", "refuse": "waste",
    "current": "power", "electricity": "power", "bijli": "power", "vaidyuthi": "power",
    "powercut": "power",
    "vellam": "water", "paani": "water", "pani": "water", "tap": "water",
    "kuzhi": "pothole", "potholes": "pothole", "crater": "pothole",
    "sadak": "road", "roads": "road", "street": "road",
    "aashupathri": "hospital", "aspatal": "hospital", "phc": "hospital",
    "chikitsa": "hospital", "clinic": "hospital",
    "kaikkooli": "bribe", "rishwat": "bribe", "bribery": "bribe", "commission": "bribe",
    "lancham": "bribe",
    "pension": "pension", "penshan": "pension",
    "sertificate": "certificate", "certificates": "certificate",
    "drainage": "drain", "sewage": "drain", "sewerage": "drain", "canal": "drain",
    "lights": "light", "streetlight": "light", "lamp": "light",
    "collected": "collect", "collection": "collect", "removed": "collect",
    "working": "work", "functioning": "work", "functional": "work",
    "supply": "supply", "supplied": "supply",
    "days": "day", "weeks": "week", "months": "month", "years": "year",
}


def _canon(word: str) -> str:
    return _SYNONYMS.get(word, word)


def _tokens(text: str) -> set[str]:
    """Content tokens: canonicalised, meta-language removed, ward numbers preserved.

    Ward/house numbers are short but highly identifying ("ward 7"), so they are
    folded into a compound token instead of being dropped by the length filter.
    """
    norm = normalize(text)
    toks = {
        _canon(w) for w in norm.split()
        if w not in _STOP and len(w) > 2 and not w.isdigit()
    }
    # "ward 7" / "ward7" -> "ward7"
    toks |= {f"ward{n}" for n in re.findall(r"ward\s*(\d+)", norm)}
    toks.discard("ward")
    return toks


# Known place names let us detect a locality conflict stated *inside* the text,
# even when the structured locality field is identical or missing.
_PLACE_WORDS = {
    "erattupetta", "poonjar", "teekoy", "kanjirappally", "palai", "ettumanoor",
    "kottayam", "changanassery", "vaikom", "pampady", "melukavu", "bharananganam",
    "ramapuram", "thodupuzha", "muvattupuzha", "adimali", "kattappana", "aluva",
    "perumbavoor", "kalamassery", "thrippunithura", "vyttila", "kakkanad",
}


def _places_in(text: str) -> set[str]:
    """Extract known place names and ward numbers mentioned in the text."""
    norm = normalize(text)
    found = {p for p in _PLACE_WORDS if p in norm}
    found |= {f"ward{m}" for m in re.findall(r"ward\s*(\d+)", norm)}
    return found


def jaccard(a: str, b: str) -> float:
    ta, tb = _tokens(a), _tokens(b)
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / len(ta | tb)


def overlap(a: str, b: str) -> float:
    """Overlap (Szymkiewicz-Simpson) coefficient: intersection / smaller set.

    Jaccard unfairly punishes a short complaint that is fully contained in a longer,
    more detailed one - a very common duplicate pattern ("no water ward 7" vs a
    paragraph describing the same outage). Overlap captures that containment.
    """
    ta, tb = _tokens(a), _tokens(b)
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / min(len(ta), len(tb))


@dataclass
class Candidate:
    """An existing complaint the new one might duplicate."""
    id: str
    text: str
    category: str | None = None
    locality: str | None = None
    status: str | None = None


def _locality_match(a: str | None, b: str | None) -> float:
    """1.0 same locality, 0.0 clearly different, 0.5 unknown."""
    if not a or not b:
        return 0.5
    na, nb = normalize(a), normalize(b)
    if na == nb:
        return 1.0
    ta, tb = set(na.split()), set(nb.split())
    if ta & tb:
        return 0.85
    return 0.0


def find_duplicates(
    text: str,
    candidates: list[Candidate],
    *,
    category: str | None = None,
    locality: str | None = None,
    threshold: float = 0.50,
    top_k: int = 5,
) -> dict:
    """Score `text` against `candidates` and return likely duplicates.

    The combined score is:
        lexical   = 0.45 * max(char_cos, word_cos) + 0.20 * jaccard + 0.35 * overlap
        agreement = 1 + 0.45 * same_category + 0.25 * same_locality
        score     = lexical * agreement
    with a hard gate: an explicitly different locality heavily discounts the score.
    """
    if not candidates:
        return {"is_duplicate": False, "matches": [], "best_score": 0.0}

    corpus = [normalize(t) for t in [text] + [c.text for c in candidates]]
    matches: list[dict] = []

    def _cosines(**kw) -> list[float]:
        try:
            matrix = TfidfVectorizer(min_df=1, sublinear_tf=True, **kw).fit_transform(corpus)
            return cosine_similarity(matrix[0:1], matrix[1:]).ravel().tolist()
        except ValueError:
            return [0.0] * len(candidates)

    # Character n-grams survive typos; word n-grams capture shared subject matter.
    # Short complaint texts produce low raw cosines, so we use the max of the two
    # views rather than a single conservative analyzer.
    char_cos = _cosines(analyzer="char_wb", ngram_range=(3, 5))
    word_cos = _cosines(analyzer="word", ngram_range=(1, 2), stop_words=sorted(_STOP))

    for cand, ccos, wcos in zip(candidates, char_cos, word_cos):
        cos = max(float(ccos), float(wcos))
        jac = jaccard(text, cand.text)
        ovl = overlap(text, cand.text)
        cat_match = 1.0 if (category and cand.category and category == cand.category) else 0.0
        loc = _locality_match(locality, cand.locality)

        # Lexical core: the strongest of the similarity views, reinforced when the
        # other views agree. Same-category + same-locality act as multiplicative
        # confirmation rather than additive padding, so unrelated complaints in the
        # same ward do not drift over the threshold.
        lexical = 0.45 * cos + 0.20 * jac + 0.35 * ovl
        agreement = 1.0 + 0.45 * cat_match + 0.25 * (1.0 if loc >= 0.85 else 0.0)
        score = lexical * agreement

        # Hard gate: known and completely different localities are not duplicates.
        if loc == 0.0:
            score *= 0.45

        # Text-level place conflict: both texts name known places and none overlap
        # (e.g. "road damaged at Poonjar" vs "road damaged at Vaikom"). Same words,
        # different problem - this is the classic dedup false positive.
        pa, pb = _places_in(text), _places_in(cand.text)
        place_conflict = bool(pa and pb and not (pa & pb))
        if place_conflict:
            score *= 0.35
        # Different category with weak text overlap is very unlikely to be a duplicate.
        if category and cand.category and category != cand.category and jac < 0.5:
            score *= 0.6

        matches.append(
            {
                "id": cand.id,
                "score": round(min(score, 1.0), 4),
                "cosine": round(cos, 4),
                "cosine_char": round(float(ccos), 4),
                "cosine_word": round(float(wcos), 4),
                "jaccard": round(jac, 4),
                "overlap": round(ovl, 4),
                "same_category": bool(cat_match),
                "locality_match": loc,
                "place_conflict": place_conflict,
                "status": cand.status,
                "text_preview": cand.text[:160],
            }
        )

    matches.sort(key=lambda m: -m["score"])
    top = matches[:top_k]
    best = top[0]["score"] if top else 0.0
    dupes = [m for m in top if m["score"] >= threshold]

    return {
        "is_duplicate": bool(dupes),
        "best_score": best,
        "threshold": threshold,
        "matches": top,
        "duplicate_ids": [m["id"] for m in dupes],
        # Number of similar-but-not-identical reports => "repeated issue" pressure
        # that the priority engine consumes as repeat_count.
        "repeat_count": sum(1 for m in matches if m["score"] >= threshold * 0.75),
    }
