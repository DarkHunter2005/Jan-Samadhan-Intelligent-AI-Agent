"""Behavioural tests for the grievance ML service."""

from __future__ import annotations

import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app.duplicates import Candidate, find_duplicates, overlap  # noqa: E402
from app.features import normalize, priority_score, signal_breakdown  # noqa: E402
from app.taxonomy import CATEGORIES, department_for  # noqa: E402


# --------------------------------------------------------------------------- #
# text normalisation & signals
# --------------------------------------------------------------------------- #
def test_normalize_strips_punctuation_and_case():
    assert normalize("URGENT!!  No Water, please help.") == "urgent no water please help"


def test_urgency_detected_from_keywords():
    assert signal_breakdown("Please act immediately, this is an emergency")["urgency"] >= 0.9


def test_urgency_detected_from_transliteration():
    assert signal_breakdown("adiyanthiramayi nadapadi venam")["urgency"] >= 0.9


def test_severity_detected_for_life_threatening_text():
    assert signal_breakdown("live wire fell, person electrocuted")["severity"] >= 0.9


def test_frequency_from_spelled_out_duration():
    assert signal_breakdown("pending for three months")["frequency"] > 0.5


def test_frequency_from_numeric_duration():
    assert signal_breakdown("no water for 10 days")["frequency"] > 0.3


def test_shouting_raises_urgency():
    calm = signal_breakdown("the street light is not working near my house here")["urgency"]
    loud = signal_breakdown("THE STREET LIGHT IS NOT WORKING NEAR MY HOUSE HERE")["urgency"]
    assert loud > calm


# --------------------------------------------------------------------------- #
# priority scoring
# --------------------------------------------------------------------------- #
def test_life_threatening_beats_routine_complaint():
    danger = priority_score(
        "URGENT! Live electric wire fell on the road, a child was injured", "electricity"
    )
    routine = priority_score("Street light not working near my house", "electricity")
    assert danger["score"] > routine["score"]
    assert danger["level"] in ("high", "critical")


def test_severity_and_urgency_force_critical():
    r = priority_score("Emergency! Gas leak and fire, people injured, act immediately",
                       "police_safety")
    assert r["level"] == "critical"


def test_category_floor_prevents_low_for_corruption():
    r = priority_score("Officer asked money to move my file", "corruption_bribery")
    assert r["level"] != "low"


def test_repeat_count_increases_score():
    text = "No water supply in our ward"
    assert priority_score(text, "water_supply", repeat_count=4)["score"] > \
           priority_score(text, "water_supply", repeat_count=0)["score"]


def test_score_bounded_and_reasons_present():
    r = priority_score("x" * 500, "municipal_admin")
    assert 0 <= r["score"] <= 100
    assert r["reasons"]


def test_model_probability_blends_in():
    text = "Road is damaged near the school"
    low = priority_score(text, "roads_transport", model_probability=0.0)["score"]
    high = priority_score(text, "roads_transport", model_probability=1.0)["score"]
    assert high > low


@pytest.mark.parametrize("category", list(CATEGORIES))
def test_every_category_scores_and_routes(category):
    r = priority_score("There is a problem in our ward that needs attention", category)
    assert r["level"] in ("low", "medium", "high", "critical")
    meta = department_for(category)
    assert meta["department"] and meta["escalation_chain"]


# --------------------------------------------------------------------------- #
# duplicate detection
# --------------------------------------------------------------------------- #
CANDS = [
    Candidate("A", "No water supply in ward 7 Erattupetta for the last 10 days, tap is dry",
              "water_supply", "Erattupetta", "open"),
    Candidate("B", "Pothole on main road near market junction causing accidents",
              "roads_transport", "Erattupetta", "open"),
]


def test_detects_reworded_duplicate():
    r = find_duplicates("Ward 7 has had no water supply for over a week, taps totally dry",
                        CANDS, category="water_supply", locality="Erattupetta")
    assert r["is_duplicate"] and "A" in r["duplicate_ids"]


def test_short_containment_is_duplicate():
    r = find_duplicates("no water ward 7", CANDS,
                        category="water_supply", locality="Erattupetta")
    assert r["is_duplicate"]


def test_different_issue_same_ward_is_not_duplicate():
    r = find_duplicates("Garbage not collected in ward 7 for two weeks", CANDS,
                        category="sanitation_waste", locality="Erattupetta")
    assert not r["is_duplicate"]


def test_same_issue_different_place_is_not_duplicate():
    cands = [Candidate("C", "Road at Vaikom completely damaged after rain, not motorable",
                       "roads_transport", "Vaikom", "open")]
    r = find_duplicates("Road damaged after rain at Poonjar", cands,
                        category="roads_transport", locality="Poonjar")
    assert not r["is_duplicate"]


def test_synonyms_match_across_vocabulary():
    cands = [Candidate("D", "Waste not collected in our area for 14 days now",
                       "sanitation_waste", "Palai", "open")]
    r = find_duplicates("Garbage has not been collected from our street for two weeks",
                        cands, category="sanitation_waste", locality="Palai")
    assert r["is_duplicate"]


def test_empty_candidates_is_safe():
    r = find_duplicates("anything at all", [], category="water_supply")
    assert r["is_duplicate"] is False and r["matches"] == []


def test_overlap_handles_containment():
    assert overlap("no water ward seven", "there is no water in ward seven today") == 1.0


# --------------------------------------------------------------------------- #
# API surface (skipped when the model artefacts are absent)
# --------------------------------------------------------------------------- #
MODELS_READY = (
    pathlib.Path(__file__).resolve().parents[1] / "models" / "category_model.joblib"
).exists()


@pytest.mark.skipif(not MODELS_READY, reason="models not trained yet")
def test_predict_endpoint_end_to_end():
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as client:
        assert client.get("/health").json()["status"] == "ok"

        r = client.post("/predict", json={
            "text": "URGENT! Live electric wire has fallen near the school, child injured",
            "locality": "Erattupetta",
        }).json()
        assert r["category"] == "electricity"
        assert r["department_code"] == "KSEB"
        assert r["priority"] in ("high", "critical")
        assert r["sla_hours"] > 0

        t = client.get("/taxonomy").json()
        assert len(t["categories"]) == len(CATEGORIES)
