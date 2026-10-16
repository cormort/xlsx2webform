"""主管機關 scoping: users see funds/projects under their assigned authority only."""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

import pytest
from fastapi.testclient import TestClient
import backend.main as main
from backend.main import app, sessions, SessionData

main.ADMIN_PASSWORD = "testpw"
c = TestClient(app)
EXEC = ("special", "03")      # 行政院主管 — 行政院國家發展基金
MOI = ("special", "08")       # 內政部主管 — 營建建設基金


@pytest.fixture(autouse=True)
def _isolate(monkeypatch, tmp_path):
    monkeypatch.setattr(main, "DATA_DIR", tmp_path)
    monkeypatch.setattr(main, "PERSIST_FILES", {k: tmp_path / v.name for k, v in main.PERSIST_FILES.items()})
    app.state.limiter.enabled = False
    yield
    for sid in [s for s in sessions if s.startswith("sup")]:
        sessions.pop(sid); main.response_store.pop(sid, None)
    for em in list(main.users):
        if em.startswith("sup_"):
            main.users.pop(em)


def _h(t):
    return {"X-Admin-Token": t}


def _user(atok, email, sup):
    body = {"email": email, "password": "pw"}
    if sup:
        body |= {"supervisor_domain": sup[0], "supervisor_code": sup[1]}
    assert c.post("/api/admin/users", json=body, headers=_h(atok)).status_code == 200
    return c.post("/api/auth/login", json={"email": email, "password": "pw"}).json()["token"]


def _project(sid, owner, rows):
    hdr = [{"value": "基金名稱"}, {"value": "預算數"}]
    sessions[sid] = SessionData(id=sid, name=sid, created_at="x", updated_at="x", original_html="",
                                original_json=[hdr], metadata={}, current_data=[hdr], email=owner)
    main.response_store[sid] = [{"id": "r1", "respondent": "r", "email": "", "submitted_at": "x",
                                 "data": [hdr] + [[{"value": n}, {"value": "1"}] for n in rows]}]


def test_supervisor_scoping():
    atok = c.post("/api/admin/login", json={"password": "testpw"}).json()["token"]
    a = _user(atok, "sup_a@x.com", EXEC)
    b = _user(atok, "sup_b@x.com", EXEC)       # same 主管機關 as a
    m = _user(atok, "sup_m@x.com", MOI)        # different 主管機關
    n = _user(atok, "sup_n@x.com", None)       # none assigned
    _project("sup1", "sup_a@x.com", ["行政院國家發展基金", "營建建設基金"])

    # same-authority peer: read-only
    listed = {p["id"]: p for p in c.get("/api/sessions", headers=_h(b)).json()["sessions"]}
    assert listed["sup1"]["can_edit"] is False
    assert c.get("/api/sessions/sup1", headers=_h(b)).json()["can_edit"] is False
    assert c.get("/api/sessions/sup1/responses", headers=_h(b)).status_code == 200
    assert c.post("/api/sessions/sup1/save", json={"data": []}, headers=_h(b)).status_code == 403
    assert c.delete("/api/sessions/sup1/responses/r1", headers=_h(b)).status_code == 403
    assert c.get("/api/sessions/sup1", headers=_h(a)).json()["can_edit"] is True

    # other authority: invisible
    assert "sup1" not in {p["id"] for p in c.get("/api/sessions", headers=_h(m)).json()["sessions"]}
    assert c.get("/api/sessions/sup1", headers=_h(m)).status_code == 403

    # 總彙整 is filtered by the registry's fund → 主管機關 mapping, across all projects
    def funds(tok):
        res = c.get("/api/consolidate", headers=_h(tok)).json()
        return sorted(f["fund_name"] for g in res["groups"] for ag in g["agencies"] for f in ag["funds"])
    assert funds(b) == ["行政院國家發展基金"]
    assert funds(m) == ["營建建設基金"]              # sees MOI rows even in another authority's project
    assert funds(atok) == ["營建建設基金", "行政院國家發展基金"]
    assert c.get("/api/consolidate", headers=_h(n)).status_code == 403

    # 基金繳交狀態: only the user's domain and authority
    cov = c.get("/api/fund-coverage", headers=_h(b)).json()
    assert set(cov) <= {"special"}
    names = [f["name"] for f in cov.get("special", {}).get("funds", [])] + \
            [k["name"] for f in cov.get("special", {}).get("funds", []) for k in f.get("children", [])]
    assert "營建建設基金" not in names
    assert c.get("/api/fund-coverage", headers=_h(n)).status_code == 403
