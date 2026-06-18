import sys
import os
from datetime import datetime
import pytest
from fastapi.testclient import TestClient

# 將專案根目錄加入 path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from backend import main

@pytest.fixture(autouse=True)
def setup_auth_env(monkeypatch, tmp_path):
    # 關鍵技術重點 1: ADMIN_PASSWORD 是 backend.main 的模組層全域變數，用 monkeypatch 設定
    monkeypatch.setattr(main, 'ADMIN_PASSWORD', 'testpass123')
    
    # 關鍵技術重點 2: 將 DATA_DIR 導向 tmp_path，避免污染 data/ 目錄
    monkeypatch.setattr(main, 'DATA_DIR', tmp_path)
    
    # 停用 Rate limiter 避免測試受到 429 限制
    if hasattr(main.app.state, "limiter"):
        main.app.state.limiter.enabled = False

    # 關鍵技術重點 4: 每個測試開始前清空 store
    main.users.clear()
    main.admin_tokens.clear()
    main.user_tokens.clear()
    main.sessions.clear()
    
    yield
    
    # 每個測試結束後也清空 store
    main.users.clear()
    main.admin_tokens.clear()
    main.user_tokens.clear()
    main.sessions.clear()


def test_admin_login():
    # 關鍵技術重點 3: 用 TestClient
    client = TestClient(main.app)
    
    # 密碼錯誤回 403
    response = client.post("/api/admin/login", json={"password": "wrongpassword"})
    assert response.status_code == 403
    
    # 密碼正確回 200 且含 token
    response = client.post("/api/admin/login", json={"password": "testpass123"})
    assert response.status_code == 200
    data = response.json()
    assert data["success"] is True
    assert "token" in data
    assert len(data["token"]) > 0


def test_admin_verify():
    client = TestClient(main.app)
    
    # 無 token 回 false
    response = client.get("/api/admin/verify")
    assert response.status_code == 200
    assert response.json()["authenticated"] is False
    
    # 帶有效 admin token 回 authenticated=true
    login_resp = client.post("/api/admin/login", json={"password": "testpass123"})
    token = login_resp.json()["token"]
    
    response = client.get("/api/admin/verify", headers={"X-Admin-Token": token})
    assert response.status_code == 200
    assert response.json()["authenticated"] is True
    
    # 帶無效 token 回 false
    response = client.get("/api/admin/verify", headers={"X-Admin-Token": "invalid_token"})
    assert response.status_code == 200
    assert response.json()["authenticated"] is False


def test_auth_login():
    client = TestClient(main.app)
    
    # admin 密碼登入回 role=admin
    response = client.post("/api/auth/login", json={"email": "admin", "password": "testpass123"})
    assert response.status_code == 200
    data = response.json()
    assert data["success"] is True
    assert data["role"] == "admin"
    assert "token" in data
    
    # 不存在的使用者回 403
    response = client.post("/api/auth/login", json={"email": "nonexistent@example.com", "password": "password"})
    assert response.status_code == 403


def test_protected_endpoints_guest():
    client = TestClient(main.app)
    # 受保護端點在無 token（guest）時回 401
    response = client.get("/api/sessions")
    assert response.status_code == 401
    assert response.json()["detail"] == "Authentication required"


def test_admin_create_user_and_login():
    client = TestClient(main.app)
    
    # 取得 admin token
    login_resp = client.post("/api/admin/login", json={"password": "testpass123"})
    admin_token = login_resp.json()["token"]
    
    # 管理員建立使用者
    # 建立使用者需帶有效 admin token 於 X-Admin-Token header
    new_user_payload = {"email": "user@example.com", "password": "userpass123"}
    create_resp = client.post(
        "/api/admin/users",
        json=new_user_payload,
        headers={"X-Admin-Token": admin_token}
    )
    assert create_resp.status_code == 200
    assert create_resp.json()["success"] is True
    
    # 該使用者可用 POST /api/auth/login 登入成功（role=user）
    user_login_payload = {"email": "user@example.com", "password": "userpass123"}
    user_login_resp = client.post("/api/auth/login", json=user_login_payload)
    assert user_login_resp.status_code == 200
    user_data = user_login_resp.json()
    assert user_data["success"] is True
    assert user_data["role"] == "user"
    assert user_data["email"] == "user@example.com"
    assert "token" in user_data


def test_create_user_validation():
    client = TestClient(main.app)
    
    # 取得 admin token
    login_resp = client.post("/api/admin/login", json={"password": "testpass123"})
    admin_token = login_resp.json()["token"]
    
    # email 缺少 @ 回 400
    invalid_email_payload = {"email": "invalidemail", "password": "password123"}
    resp = client.post(
        "/api/admin/users",
        json=invalid_email_payload,
        headers={"X-Admin-Token": admin_token}
    )
    assert resp.status_code == 400
    assert "Invalid email address" in resp.json()["detail"]
    
    # 建立一個正常的使用者
    valid_payload = {"email": "duplicate@example.com", "password": "password123"}
    resp = client.post(
        "/api/admin/users",
        json=valid_payload,
        headers={"X-Admin-Token": admin_token}
    )
    assert resp.status_code == 200
    
    # 建立重複 email 回 400
    resp_dup = client.post(
        "/api/admin/users",
        json=valid_payload,
        headers={"X-Admin-Token": admin_token}
    )
    assert resp_dup.status_code == 400
    assert "User already exists" in resp_dup.json()["detail"]
