"""Regression tests for the security review fixes (ownership, fill leak, export DoS, input validation)."""
import io
import os
import sys
import time

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

import pytest
from fastapi.testclient import TestClient
import backend.main as main
from backend.main import app, sessions, SessionData

main.ADMIN_PASSWORD = "testpw"
c = TestClient(app)


@pytest.fixture(autouse=True)
def _isolate(monkeypatch, tmp_path):
    monkeypatch.setattr(main, "DATA_DIR", tmp_path)
    monkeypatch.setattr(main, "PERSIST_FILES", {k: tmp_path / v.name for k, v in main.PERSIST_FILES.items()})
    app.state.limiter.enabled = False
    getattr(main, "_pwd_failures", {}).clear()
    yield
    for sid in [s for s in sessions if s.startswith("sec")]:
        sessions.pop(sid, None)
        main.response_store.pop(sid, None)
    for tok in [t for t, sid in main.publish_store.items() if sid.startswith("sec")]:
        main.published_forms.pop(main.publish_store.pop(tok), None)
    for em in ("sec_a@x.com", "sec_b@x.com"):
        main.users.pop(em, None)


def _h(t):
    return {"X-Admin-Token": t}


def _admin():
    return c.post("/api/admin/login", json={"password": "testpw"}).json()["token"]


def _user(atok, email):
    assert c.post("/api/admin/users", json={"email": email, "password": "pw"}, headers=_h(atok)).status_code == 200
    return c.post("/api/auth/login", json={"email": email, "password": "pw"}).json()["token"]


def _session(sid, email="", password=""):
    sessions[sid] = SessionData(
        id=sid, name="t", created_at="x", updated_at="x", original_html="",
        original_json=[[{"value": "基金名稱"}]], metadata={}, current_data=[[{"value": "基金名稱"}]],
        email=email, password_hash=main._hash_password(password) if password else "")


def test_unprotected_project_is_owner_or_admin_only():
    atok = _admin()
    a, b = _user(atok, "sec_a@x.com"), _user(atok, "sec_b@x.com")
    _session("sec1", email="sec_a@x.com")
    assert c.get("/api/sessions/sec1").status_code == 403                      # guest
    assert c.get("/api/sessions/sec1", headers=_h(b)).status_code == 403       # other user
    assert c.delete("/api/sessions/sec1", headers=_h(b)).status_code == 403
    assert c.get("/api/sessions/sec1/responses?full=true").status_code == 403
    assert c.get("/api/sessions/sec1", headers=_h(a)).status_code == 200       # owner
    assert c.get("/api/sessions/sec1", headers=_h(atok)).status_code == 200    # admin


def test_password_protected_project_and_lockout():
    _session("sec2", password="right")
    assert c.get("/api/sessions/sec2").status_code == 401
    assert c.get("/api/sessions/sec2", headers={"X-Project-Password": "right"}).status_code == 200
    for _ in range(main.PWD_MAX_FAILURES):
        assert c.get("/api/sessions/sec2/responses", headers={"X-Project-Password": "wrong"}).status_code == 403
    # locked out even with the right password, on every endpoint
    assert c.get("/api/sessions/sec2/responses", headers={"X-Project-Password": "right"}).status_code == 429


def test_fill_data_does_not_leak_session_id_and_submit_validates_shape():
    atok = _admin()
    _session("sec3")
    token = c.post("/api/sessions/sec3/publish", headers=_h(atok)).json()["share_token"]
    assert "session_id" not in c.get(f"/api/fill/{token}/data").json()
    # malformed rows rejected
    assert c.post(f"/api/fill/{token}/submit", json={"data": [1, "x"]}).status_code == 422
    assert c.post(f"/api/fill/{token}/submit", json={"data": [[1]]}).status_code == 422
    # numeric cell values no longer crash consolidation
    ok = {"data": [[{"value": "基金名稱"}], [{"value": 123}]], "email": "f@x.com"}
    assert c.post(f"/api/fill/{token}/submit", json=ok).status_code == 200
    assert c.get("/api/consolidate", headers=_h(atok)).status_code == 200
    assert c.get("/api/sessions/sec3/responses/export/csv", headers=_h(atok)).status_code == 200


def test_password_set_on_edit_is_stored():
    atok = _admin()
    _session("sec4")
    token = c.post("/api/sessions/sec4/publish", headers=_h(atok)).json()["share_token"]
    row = {"data": [[{"value": "h"}]], "email": "f@x.com"}
    assert c.post(f"/api/fill/{token}/submit", json=row).status_code == 200
    assert c.post(f"/api/fill/{token}/submit", json={**row, "password": "p"}).status_code == 200
    assert c.post(f"/api/fill/{token}/load-response", json={"email": "f@x.com", "password": "p"}).status_code == 200


def test_export_xlsx_clamps_huge_merge():
    t = time.time()
    r = c.post("/api/export-xlsx", json={"name": "x", "data": [[{"value": "a", "rowspan": 10**6, "colspan": 16000}]]})
    assert r.status_code == 200 and time.time() - t < 10


def test_create_user_rejects_script_email_and_empty_password():
    atok = _admin()
    bad = "x');alert(1)//@a"
    assert c.post("/api/admin/users", json={"email": bad, "password": "pw"}, headers=_h(atok)).status_code == 400
    assert c.post("/api/admin/users", json={"email": "sec_a@x.com", "password": ""}, headers=_h(atok)).status_code == 400


def test_negative_fund_col_rejected():
    atok = _admin()
    _session("sec5")
    assert c.post("/api/sessions/sec5/save", json={"data": [], "fund_col": -1}, headers=_h(atok)).status_code == 400
