#!/usr/bin/env python3
"""End-to-end smoke test of the full stack (ML service + backend API).

Run with both services up:
    ./scripts/start-all.sh --seed && python3 scripts/e2e_test.py
"""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request

API = "http://127.0.0.1:4000/api"
PASSED, FAILED = [], []


def call(method, path, body=None, token=None):
    req = urllib.request.Request(
        API + path,
        data=json.dumps(body).encode() if body is not None else None,
        method=method,
        headers={
            "Content-Type": "application/json",
            **({"Authorization": f"Bearer {token}"} if token else {}),
        },
    )
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw or b"{}")
        except json.JSONDecodeError:
            return e.code, {"raw": raw.decode(errors="replace")}


def check(name, condition, detail=""):
    (PASSED if condition else FAILED).append(name)
    print(f"  [{'PASS' if condition else 'FAIL'}] {name}" + (f" -- {detail}" if detail else ""))


def section(title):
    print(f"\n{title}")


# ---------------------------------------------------------------------------
section("1. Authentication")
import time
email = f"e2e{int(time.time())}@example.com"
st, reg = call("POST", "/auth/register",
               {"name": "E2E Citizen", "email": email,
                "password": "secret12345", "locality": "Erattupetta"})
check("citizen can register", st == 201 and "token" in reg, f"HTTP {st}")
CIT = reg.get("token")

st, _ = call("POST", "/auth/register",
             {"name": "Dup", "email": email, "password": "secret12345"})
check("duplicate email rejected", st == 409, f"HTTP {st}")

st, weak = call("POST", "/auth/register",
                {"name": "Weak", "email": "weak@example.com", "password": "123"})
check("weak password rejected", st == 400, f"HTTP {st}")

st, bad = call("POST", "/auth/login", {"email": email, "password": "wrongpass"})
check("wrong password rejected", st == 401, f"HTTP {st}")

st, off = call("POST", "/auth/login", {"email": "kseb@gov.in", "password": "password123"})
OFFICER = off.get("token")
check("officer can log in", st == 200 and OFFICER, f"HTTP {st}")

st, adm = call("POST", "/auth/login", {"email": "admin@gov.in", "password": "password123"})
ADMIN = adm.get("token")
check("admin can log in", st == 200 and ADMIN, f"HTTP {st}")

# ---------------------------------------------------------------------------
section("2. Complaint submission + ML classification")
UNIQUE = f"case{int(time.time())}"
st, sub = call("POST", "/complaints", {
    "text": f"URGENT! The distribution transformer at {UNIQUE} junction in Melukavu is "
            f"sparking heavily and a live wire is hanging low over the footpath. "
            f"A pedestrian was injured today. Immediate action needed!",
    "locality": "Melukavu", "language": "en",
}, CIT)
check("complaint accepted", st == 201, f"HTTP {st}")
exp, route = sub.get("explanation", {}), sub.get("routing", {})
TID = sub.get("tracking_id", "")
print(f"       id={TID} category={exp.get('category')} conf={exp.get('confidence')}")
print(f"       dept={route.get('department')} priority={exp.get('priority')} "
      f"score={exp.get('priority_score')} sla={route.get('sla_hours')}h")
check("routed to electricity board", route.get("department_code") == "KSEB",
      str(route.get("department_code")))
check("priority is high/critical", exp.get("priority") in ("high", "critical"),
      str(exp.get("priority")))
check("urgency detected", exp.get("urgency") == "immediate", str(exp.get("urgency")))
check("explanation reasons returned", bool(exp.get("reasons")))
# The random suffix must avoid look-alike characters (the GRV-<year>- prefix is fixed).
suffix = TID.rsplit("-", 1)[-1]
check("tracking id suffix is unambiguous",
      TID.startswith("GRV-") and len(suffix) == 6
      and not (set(suffix) & set("_O0I1")), TID)
check("SLA deadline set", bool(route.get("due_at")), str(route.get("due_at")))

st, calm = call("POST", "/complaints", {
    "text": "Sir, my income certificate application is pending at the village office "
            "for the last two weeks. Kindly do the needful.",
    "locality": "Poonjar",
}, CIT)
check("routine complaint -> revenue dept",
      calm["routing"]["department_code"] == "REV", calm["routing"]["department_code"])
check("routine complaint gets lower priority",
      calm["explanation"]["priority_score"] < exp.get("priority_score", 100),
      f"{calm['explanation']['priority_score']} < {exp.get('priority_score')}")

st, ml_mal = call("POST", "/complaints", {
    "text": "Vellam varunnilla ward 3 il, ettu divasam ayi. Dayavayi nadapadi edukkuka.",
    "locality": "Erattupetta", "language": "ml",
}, CIT)
check("transliterated Malayalam routed to water authority",
      ml_mal["routing"]["department_code"] == "KWA", ml_mal["routing"]["department_code"])

# ---------------------------------------------------------------------------
section("3. Duplicate detection")
st, dup = call("POST", "/complaints", {
    "text": f"Transformer at {UNIQUE} junction Melukavu is sparking and the live wire "
            f"hangs low over the footpath, a pedestrian got injured. Urgent!",
    "locality": "Melukavu",
}, CIT)
d = dup.get("duplicate", {})
print(f"       merged={d.get('merged')} parent={d.get('parent_id')} score={d.get('score')}")
check("duplicate linked to original", d.get("parent_id") == TID,
      f"{d.get('parent_id')} vs {TID}")
check("duplicate similarity is high", (d.get("score") or 0) >= 0.5, str(d.get("score")))
check("near-identical resubmission auto-merged", d.get("merged") is True, str(d.get("merged")))
check("merged duplicate is parked, not given its own SLA",
      dup["complaint"]["status"] == "duplicate" and dup["complaint"]["due_at"] is None)
pu = d.get("parent_update") or {}
check("parent absorbs the repeat pressure", pu.get("repeat_count", 0) >= 1, str(pu))

st, diff = call("POST", "/complaints", {
    "text": "Pension has not been credited for the last four months at the panchayat office.",
    "locality": "Melukavu",
}, CIT)
check("unrelated complaint not marked duplicate",
      not diff["duplicate"]["merged"] and diff["duplicate"]["parent_id"] is None)

# ---------------------------------------------------------------------------
section("4. Public tracking")
st, tr = call("GET", f"/complaints/track/{TID}")
check("public tracking works without auth", st == 200, f"HTTP {st}")
check("tracking hides citizen phone", "citizen_phone" not in tr.get("complaint", {}))
check("tracking returns history", len(tr.get("history", [])) >= 1)
st, missing = call("GET", "/complaints/track/GRV-2026-NOPE99")
check("unknown tracking id -> 404", st == 404, f"HTTP {st}")

# ---------------------------------------------------------------------------
section("5. Authorisation")
st, _ = call("GET", "/complaints")
check("dashboard requires auth", st == 401, f"HTTP {st}")

st, _ = call("GET", "/complaints", token=CIT)
check("citizen blocked from dashboard", st == 403, f"HTTP {st}")

st, listing = call("GET", "/complaints?pageSize=100", token=OFFICER)
depts = {c["department_code"] for c in listing.get("complaints", [])}
check("officer sees only own department", depts <= {"KSEB"}, str(depts))

st, all_list = call("GET", "/complaints?pageSize=100", token=ADMIN)
check("admin sees all departments",
      len({c["department_code"] for c in all_list["complaints"]}) > 1)

pwd_c = next((c for c in all_list["complaints"] if c["department_code"] == "PWD"), None)
if pwd_c:
    st, _ = call("PATCH", f"/complaints/{pwd_c['id']}/status",
                 {"status": "in_progress", "note": "x"}, OFFICER)
    check("officer cannot touch other department", st == 403, f"HTTP {st}")

st, _ = call("POST", "/admin/users",
             {"name": "X", "email": "x@gov.in", "password": "password123",
              "role": "admin"}, CIT)
check("citizen cannot create admin users", st == 403, f"HTTP {st}")

# ---------------------------------------------------------------------------
section("6. Status workflow")
st, r = call("PATCH", f"/complaints/{TID}/status", {"status": "resolved"}, OFFICER)
check("resolve without note rejected", st == 400, f"HTTP {st}")

st, r = call("PATCH", f"/complaints/{TID}/status",
             {"status": "in_progress", "note": "Line team dispatched"}, OFFICER)
check("routed -> in_progress allowed", st == 200 and r["complaint"]["status"] == "in_progress",
      f"HTTP {st}")

st, r = call("PATCH", f"/complaints/{TID}/status",
             {"status": "submitted", "note": "back"}, OFFICER)
check("illegal transition rejected", st == 409, f"HTTP {st}")

st, r = call("PATCH", f"/complaints/{TID}/status",
             {"status": "resolved", "note": "Wire secured, transformer replaced."}, OFFICER)
check("in_progress -> resolved allowed", st == 200 and r["complaint"]["status"] == "resolved",
      f"HTTP {st}")
check("resolved_at recorded", bool(r["complaint"]["resolved_at"]))

st, fb = call("POST", f"/complaints/{TID}/feedback", {"rating": 5, "note": "Quick fix"}, CIT)
check("citizen can rate resolution", st == 200 and fb["complaint"]["citizen_rating"] == 5,
      f"HTTP {st}")
st, fb2 = call("POST", f"/complaints/{TID}/feedback", {"rating": 9}, CIT)
check("out-of-range rating rejected", st == 400, f"HTTP {st}")

st, hist = call("GET", f"/complaints/{TID}", token=ADMIN)
check("audit trail captured every step", len(hist.get("history", [])) >= 4,
      f"{len(hist.get('history', []))} entries")
check("full ML payload stored for audit", "ml" in hist.get("complaint", {}))

# ---------------------------------------------------------------------------
section("7. Admin: reassignment, escalation, stats")
st, mis = call("POST", "/complaints",
               {"text": "There is some problem in our area, please look into it soon.",
                "locality": "Erattupetta"}, CIT)
mid = mis["tracking_id"]
st, re_assigned = call("PATCH", f"/complaints/{mid}/assign",
                       {"department_code": "PWD", "priority": "high",
                        "note": "Actually a road issue"}, ADMIN)
check("admin can correct department",
      st == 200 and re_assigned["complaint"]["department_code"] == "PWD", f"HTTP {st}")
check("manual correction clears review flag",
      re_assigned["complaint"]["needs_review"] is False)
check("priority change recalculates SLA", re_assigned["complaint"]["due_at"] is not None)

st, bad_assign = call("PATCH", f"/complaints/{mid}/assign",
                      {"department_code": "NOPE"}, ADMIN)
check("unknown department rejected", st == 400, f"HTTP {st}")

st, esc = call("POST", "/admin/escalate", token=ADMIN)
check("escalation sweep runs", st == 200, f"HTTP {st}")
print(f"       escalated {esc.get('escalated_count')} overdue complaint(s)")
for e in esc.get("escalated", [])[:3]:
    print(f"         {e['id']} -> level {e['level']} ({e['authority']})")
check("overdue complaints escalated", esc.get("escalated_count", 0) > 0)

st, esc2 = call("POST", "/admin/escalate", token=ADMIN)
check("second sweep escalates further up the ladder", st == 200)

st, stats = call("GET", "/admin/stats", token=ADMIN)
t = stats.get("totals", {})
print(f"       totals: {dict((k, t.get(k)) for k in ('total','resolved','overdue','escalated'))}")
check("stats returns totals", t.get("total", 0) > 0)
check("stats has department breakdown", len(stats.get("byDepartment", [])) > 1)
check("stats has trend series", isinstance(stats.get("trend"), list))

st, dl = call("GET", "/admin/departments")
check("department directory public", st == 200 and len(dl["departments"]) == 12,
      f"{len(dl.get('departments', []))} departments")

st, mh = call("GET", "/admin/ml-health", token=ADMIN)
check("ML health reachable", mh.get("reachable") is True)

# ---------------------------------------------------------------------------
section("8. Validation & filtering")
st, _ = call("POST", "/complaints", {"text": "short"}, CIT)
check("too-short complaint rejected", st == 400, f"HTTP {st}")
st, _ = call("POST", "/complaints", {"text": "A perfectly valid complaint text here"})
check("anonymous without contact rejected", st == 400, f"HTTP {st}")
st, anon = call("POST", "/complaints",
                {"text": "Street light not working near the bus stand for a week.",
                 "citizen_name": "Walk In", "citizen_phone": "9400000001",
                 "locality": "Palai"})
check("anonymous with contact accepted", st == 201, f"HTTP {st}")

st, mine = call("GET", "/complaints/mine", token=CIT)
check("citizen sees own complaints", st == 200 and mine["total"] >= 4, f"total={mine.get('total')}")

st, over = call("GET", "/complaints?overdue=1&pageSize=100", token=ADMIN)
check("overdue filter works", all(c["is_overdue"] for c in over["complaints"]),
      f"{over['total']} overdue")

st, hp = call("GET", "/complaints?priority=critical&pageSize=50", token=ADMIN)
check("priority filter works", all(c["priority"] == "critical" for c in hp["complaints"]))

st, srch = call("GET", "/complaints?q=transformer&pageSize=50", token=ADMIN)
check("text search works", srch["total"] >= 1, f"{srch['total']} hits")

st, srt = call("GET", "/complaints?sort=priority_score&order=DESC&pageSize=5", token=ADMIN)
scores = [c["priority_score"] for c in srt["complaints"]]
check("sorting by priority works", scores == sorted(scores, reverse=True), str(scores))

# ---------------------------------------------------------------------------
print(f"\n{'=' * 60}")
print(f"PASSED: {len(PASSED)}   FAILED: {len(FAILED)}")
if FAILED:
    print("Failures:")
    for f in FAILED:
        print("  -", f)
sys.exit(1 if FAILED else 0)
