"""End-to-end checks for the 主計總處 (dgbas) elevated-but-read-only role and audit log.

Run with the project venv (needs fastapi/slowapi/bcrypt): `.venv/bin/python -m pytest tests/test_dgbas.py`
"""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from fastapi.testclient import TestClient
import backend.main as main
from backend.main import app, sessions, SessionData

# Force an admin password regardless of import order / env (other test modules
# may import backend.main before this one runs).
main.ADMIN_PASSWORD = "testpw"

c = TestClient(app)
EM = "pytest_dgbas@x.com"


def _h(t):
    return {"X-Admin-Token": t}


def _admin():
    r = c.post("/api/admin/login", json={"password": "testpw"})
    assert r.status_code == 200, r.text
    return r.json()["token"]


def _make_dgbas(atok, email=EM):
    c.delete(f"/api/admin/users/{email}", headers=_h(atok))
    assert c.post("/api/admin/users", json={"email": email, "password": "pw"}, headers=_h(atok)).status_code == 200
    assert c.put(f"/api/admin/users/{email}/role", json={"role": "dgbas"}, headers=_h(atok)).status_code == 200
    r = c.post("/api/auth/login", json={"email": email, "password": "pw"})
    assert r.status_code == 200 and r.json()["role"] == "dgbas", r.text
    return r.json()["token"]


def test_dgbas_read_all_but_cannot_write():
    atok = _admin()
    dtok = _make_dgbas(atok)
    try:
        assert c.get("/api/auth/verify", headers=_h(dtok)).json()["role"] == "dgbas"
        # reads every project
        assert c.get("/api/sessions", headers=_h(dtok)).status_code == 200
        sid = "pytestfake01"
        sessions[sid] = SessionData(id=sid, name="t", created_at="x", updated_at="x",
                                    original_html="", original_json=[], metadata={}, current_data=[])
        try:
            assert c.get(f"/api/sessions/{sid}", headers=_h(dtok)).status_code == 200
            assert c.post(f"/api/sessions/{sid}/save", json={"data": []}, headers=_h(dtok)).status_code == 403
            assert c.delete(f"/api/sessions/{sid}", headers=_h(dtok)).status_code == 403
            assert c.post(f"/api/sessions/{sid}/publish", headers=_h(dtok)).status_code == 403
        finally:
            sessions.pop(sid, None)
    finally:
        c.delete(f"/api/admin/users/{EM}", headers=_h(atok))


def test_dgbas_manages_users_and_views_audit_but_no_escalation():
    atok = _admin()
    dtok = _make_dgbas(atok)
    em2 = "pytest_dgbas2@x.com"
    try:
        # can list users / templates / audit
        assert c.get("/api/admin/users", headers=_h(dtok)).status_code == 200
        assert c.get("/api/templates", headers=_h(dtok)).status_code == 200
        assert c.get("/api/admin/audit-log", headers=_h(dtok)).status_code == 200
        # cannot grant roles (admin-only endpoint)
        assert c.put(f"/api/admin/users/{EM}/role", json={"role": "dgbas"}, headers=_h(dtok)).status_code in (401, 403)
        # cannot delete another 主計總處
        c.delete(f"/api/admin/users/{em2}", headers=_h(atok))
        c.post("/api/admin/users", json={"email": em2, "password": "pw"}, headers=_h(atok))
        c.put(f"/api/admin/users/{em2}/role", json={"role": "dgbas"}, headers=_h(atok))
        assert c.delete(f"/api/admin/users/{em2}", headers=_h(dtok)).status_code == 403
    finally:
        c.delete(f"/api/admin/users/{EM}", headers=_h(atok))
        c.delete(f"/api/admin/users/{em2}", headers=_h(atok))
