"""Category -> department taxonomy and shared vocabulary for the grievance ML service.

Keeping this in one module means the trainer, the API and the backend seed data all
agree on the same label space.
"""

from __future__ import annotations

# ---------------------------------------------------------------------------
# Category -> routing metadata
# ---------------------------------------------------------------------------
# sla_hours       : resolution SLA for a *medium* priority ticket in that category
# base_severity   : 0-1 prior on how damaging a typical complaint here is
# escalation_chain: ordered authority ladder used by the backend escalation job
CATEGORIES: dict[str, dict] = {
    "water_supply": {
        "label": "Water Supply",
        "department": "Kerala Water Authority",
        "department_code": "KWA",
        "sla_hours": 48,
        "base_severity": 0.55,
        "escalation_chain": ["Ward Officer", "Assistant Engineer", "Executive Engineer", "District Collector"],
    },
    "electricity": {
        "label": "Electricity",
        "department": "State Electricity Board",
        "department_code": "KSEB",
        "sla_hours": 24,
        "base_severity": 0.6,
        "escalation_chain": ["Section Officer", "Assistant Engineer", "Executive Engineer", "Chief Engineer"],
    },
    "roads_transport": {
        "label": "Roads & Transport",
        "department": "Public Works Department",
        "department_code": "PWD",
        "sla_hours": 120,
        "base_severity": 0.5,
        "escalation_chain": ["Overseer", "Assistant Engineer", "Executive Engineer", "Superintending Engineer"],
    },
    "sanitation_waste": {
        "label": "Sanitation & Waste",
        "department": "Municipal Health Wing",
        "department_code": "MHW",
        "sla_hours": 72,
        "base_severity": 0.5,
        "escalation_chain": ["Sanitation Supervisor", "Health Inspector", "Health Officer", "Municipal Secretary"],
    },
    "health_medical": {
        "label": "Health & Medical",
        "department": "Department of Health Services",
        "department_code": "DHS",
        "sla_hours": 24,
        "base_severity": 0.75,
        "escalation_chain": ["Hospital Superintendent", "District Medical Officer", "Director of Health Services"],
    },
    "police_safety": {
        "label": "Police & Public Safety",
        "department": "State Police",
        "department_code": "POL",
        "sla_hours": 12,
        "base_severity": 0.8,
        "escalation_chain": ["Station House Officer", "Circle Inspector", "Superintendent of Police", "DIG"],
    },
    "education": {
        "label": "Education",
        "department": "Department of General Education",
        "department_code": "EDU",
        "sla_hours": 120,
        "base_severity": 0.4,
        "escalation_chain": ["Headmaster", "Assistant Educational Officer", "District Educational Officer"],
    },
    "revenue_certificates": {
        "label": "Revenue & Certificates",
        "department": "Revenue Department",
        "department_code": "REV",
        "sla_hours": 96,
        "base_severity": 0.4,
        "escalation_chain": ["Village Officer", "Tahsildar", "Sub Collector", "District Collector"],
    },
    "welfare_pension": {
        "label": "Welfare & Pension",
        "department": "Social Justice Department",
        "department_code": "SJD",
        "sla_hours": 168,
        "base_severity": 0.45,
        "escalation_chain": ["Panchayat Secretary", "Welfare Officer", "District Social Justice Officer"],
    },
    "municipal_admin": {
        "label": "Municipal Administration",
        "department": "Local Self Government",
        "department_code": "LSG",
        "sla_hours": 120,
        "base_severity": 0.35,
        "escalation_chain": ["Junior Superintendent", "Municipal Secretary", "Regional Joint Director"],
    },
    "corruption_bribery": {
        "label": "Corruption & Bribery",
        "department": "Vigilance & Anti-Corruption Bureau",
        "department_code": "VACB",
        "sla_hours": 48,
        "base_severity": 0.85,
        "escalation_chain": ["Vigilance Inspector", "Vigilance DySP", "Vigilance SP", "Director VACB"],
    },
    "transport_rto": {
        "label": "Motor Vehicles & RTO",
        "department": "Motor Vehicles Department",
        "department_code": "MVD",
        "sla_hours": 96,
        "base_severity": 0.4,
        "escalation_chain": ["Assistant MVI", "Motor Vehicle Inspector", "RTO", "Transport Commissioner"],
    },
}

CATEGORY_KEYS: list[str] = list(CATEGORIES)

# ---------------------------------------------------------------------------
# Priority scoring lexicons (used as engineered features + rule overlay)
# ---------------------------------------------------------------------------
# Words that signal something is happening *now* / cannot wait.
URGENCY_TERMS = {
    "immediately": 1.0, "immediate": 1.0, "urgent": 1.0, "urgently": 1.0, "emergency": 1.0,
    "right now": 1.0, "asap": 0.9, "today": 0.7, "tonight": 0.8, "since morning": 0.6,
    "critical": 1.0, "at once": 0.9, "no time": 0.8, "cannot wait": 0.9,
    # transliterated Hindi / Malayalam
    "turant": 1.0, "jaldi": 0.8, "abhi": 0.7, "atyavashyam": 1.0, "adiyanthiram": 1.0,
    "ippo thanne": 0.9, "udane": 0.9,
}

# Words that signal harm / danger to life, property or health.
SEVERITY_TERMS = {
    "death": 1.0, "died": 1.0, "dead": 1.0, "fatal": 1.0, "life threatening": 1.0,
    "electrocution": 1.0, "electrocuted": 1.0, "fire": 0.95, "explosion": 0.95,
    "collapse": 0.9, "collapsed": 0.9, "accident": 0.85, "injury": 0.85, "injured": 0.85,
    "bleeding": 0.85, "unconscious": 0.9, "outbreak": 0.9, "epidemic": 0.9,
    "contaminated": 0.8, "poisoning": 0.9, "snake": 0.6, "live wire": 0.95,
    "hanging wire": 0.85, "gas leak": 0.95, "flood": 0.8, "drowning": 0.95,
    "assault": 0.9, "threat": 0.85, "harassment": 0.85, "molest": 0.95, "kidnap": 1.0,
    "danger": 0.8, "dangerous": 0.8, "risk": 0.6, "sewage": 0.6, "overflow": 0.6,
    "no water": 0.6, "power cut": 0.5, "pregnant": 0.8, "child": 0.7, "children": 0.7,
    "elderly": 0.7, "patient": 0.8, "hospital": 0.7, "school": 0.6,
    "apakadam": 0.85, "durantham": 0.9, "khatra": 0.85,
}

# Words that signal the issue has repeated / been ignored -> frequency pressure.
FREQUENCY_TERMS = {
    "again": 0.6, "repeatedly": 0.9, "repeated": 0.85, "third time": 0.9, "fourth time": 1.0,
    "many times": 0.9, "several times": 0.85, "every day": 0.9, "daily": 0.8,
    "for months": 0.9, "for weeks": 0.7, "since last": 0.6, "still not": 0.8,
    "no action": 0.9, "no response": 0.85, "ignored": 0.9, "follow up": 0.6,
    "reminder": 0.7, "previous complaint": 0.9, "already complained": 0.9,
    "veendum": 0.8, "phir se": 0.8, "baar baar": 0.9,
}

# Vulnerable-group / public-scale risk multipliers.
RISK_TERMS = {
    "hospital": 0.8, "school": 0.7, "anganwadi": 0.8, "old age home": 0.8,
    "public": 0.5, "entire ward": 0.8, "whole colony": 0.8, "hundreds": 0.8,
    "many families": 0.7, "village": 0.6, "market": 0.6, "bus stand": 0.6,
    "main road": 0.5, "highway": 0.6, "disabled": 0.8, "bedridden": 0.85,
}

PRIORITY_LEVELS = ["low", "medium", "high", "critical"]


def department_for(category: str) -> dict:
    """Return routing metadata for a category key, falling back to municipal admin."""
    return CATEGORIES.get(category, CATEGORIES["municipal_admin"])
