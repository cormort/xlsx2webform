#!/usr/bin/env python3
"""
Budget Table Editor Backend
FastAPI application for XLSX upload, table editing, and JSON import/export.
"""

import os
import uuid
import json
import shutil
from datetime import datetime
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, UploadFile, File, HTTPException, Form
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, JSONResponse, FileResponse, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from backend.xlsx_parser import process_xlsx

app = FastAPI(title="Budget Table Editor", version="1.0.0")

# CORS for local development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Upload directory
UPLOAD_DIR = Path(__file__).parent.parent / "uploads"
TEMPLATE_DIR = Path(__file__).parent.parent / "templates"
UPLOAD_DIR.mkdir(exist_ok=True)
TEMPLATE_DIR.mkdir(exist_ok=True)

DATA_DIR = Path(__file__).parent.parent / "data"
DATA_DIR.mkdir(exist_ok=True)

# In-memory stores
sessions = {}
publish_store = {}      # share_token → session_id
published_forms = {}    # session_id → share_token
response_store = {}     # session_id → [{id, data, submitted_at, respondent}]


class SessionData(BaseModel):
    """Session data for a user's editing session."""
    id: str
    name: str
    created_at: str
    updated_at: str
    original_html: str
    original_json: list
    metadata: dict
    current_data: Optional[list] = None
    form_data: Optional[dict] = None


class SaveRequest(BaseModel):
    """Request to save edited data."""
    session_id: str
    data: list


class TemplateData(BaseModel):
    """Template data for creating a new budget from existing data."""
    name: str
    data: list
    metadata: Optional[dict] = None


# ── Persistence ──────────────────────────────────────────
PERSIST_FILES = {
    "publish_store": DATA_DIR / "publish_store.json",
    "published_forms": DATA_DIR / "published_forms.json",
    "response_store": DATA_DIR / "response_store.json",
    "sessions_index": DATA_DIR / "sessions_index.json",
}

def _load_persist():
    for key, path in PERSIST_FILES.items():
        if path.exists():
            try:
                data = json.loads(path.read_text(encoding='utf-8'))
                if key == "publish_store":
                    publish_store.update(data)
                elif key == "published_forms":
                    published_forms.update(data)
                elif key == "response_store":
                    response_store.update(data)
                elif key == "sessions_index":
                    for sid in data:
                        sp = DATA_DIR / f"session_{sid}.json"
                        if sp.exists():
                            try:
                                sd = json.loads(sp.read_text(encoding='utf-8'))
                                sessions[sid] = SessionData(**sd)
                            except:
                                pass
            except:
                pass

def _save_persist(key):
    d = {"publish_store": publish_store, "published_forms": published_forms,
         "response_store": response_store}[key]
    PERSIST_FILES[key].write_text(json.dumps(d, ensure_ascii=False, indent=2), encoding='utf-8')

def _save_session(sid):
    if sid in sessions:
        (DATA_DIR / f"session_{sid}.json").write_text(
            sessions[sid].model_dump_json(indent=2), encoding='utf-8')
    idx = sorted(sessions.keys())
    PERSIST_FILES["sessions_index"].write_text(
        json.dumps(idx, ensure_ascii=False), encoding='utf-8')

_load_persist()


@app.get("/")
async def root():
    """Serve the main frontend page (project management)."""
    frontend_path = Path(__file__).parent.parent / "frontend" / "index.html"
    if frontend_path.exists():
        html = frontend_path.read_text(encoding='utf-8')
        head_script = '<script>window.LANDING_MODE="projects";</script>'
        head_style = '<style>#editor{display:none!important}#fill-mode{display:none!important}</style>'
        html = html.replace("</head>", f"{head_script}{head_style}</head>")
        return HTMLResponse(content=html, headers={"Cache-Control": "no-cache, no-store, must-revalidate", "Pragma": "no-cache", "Expires": "0"})
    return {"message": "Budget Table Editor API", "version": "1.0.0"}


@app.get("/editor/{session_id}")
async def editor_page(session_id: str):
    """Serve editor page for a specific session."""
    frontend_path = Path(__file__).parent.parent / "frontend" / "index.html"
    if not frontend_path.exists():
        raise HTTPException(status_code=404, detail="Page not found")
    if session_id not in sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    html = frontend_path.read_text(encoding='utf-8')
    # Inject EDIT_SESSION_ID and hide projects/fill, show editor
    head_script = f'<script>window.EDIT_SESSION_ID="{session_id}";</script>'
    head_style = '<style>#projects-section{display:none!important}#fill-mode{display:none!important}#editor{display:block!important}</style>'
    html = html.replace("</head>", f"{head_script}{head_style}</head>")
    return HTMLResponse(content=html, headers={"Cache-Control": "no-cache, no-store, must-revalidate", "Pragma": "no-cache", "Expires": "0"})


@app.post("/api/upload-xlsx")
async def upload_xlsx(
    file: UploadFile = File(...),
    sheet_index: int = Form(0),
    mode: str = Form("table")  # 'table' or 'form'
):
    """Upload an XLSX file and convert to HTML table or form."""
    if not file.filename.endswith(('.xlsx', '.xls')):
        raise HTTPException(status_code=400, detail="Only .xlsx files are supported")

    # Save uploaded file
    session_id = str(uuid.uuid4())[:8]
    file_path = UPLOAD_DIR / f"{session_id}_{file.filename}"

    try:
        with open(file_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)

        # Process the XLSX file
        result = process_xlsx(str(file_path), sheet_index, mode=mode)

        if mode == 'form':
            # Form mode
            session = SessionData(
                id=session_id,
                name=file.filename,
                created_at=datetime.now().isoformat(),
                updated_at=datetime.now().isoformat(),
                original_html="",
                original_json=[],
                metadata=result['metadata'],
                current_data=[],
                form_data=result.get('form')
            )

            sessions[session_id] = session
            _save_session(session_id)

            return {
                "success": True,
                "session_id": session_id,
                "form": result.get('form'),
                "metadata": result['metadata']
            }
        else:
            # Table mode (default)
            session = SessionData(
                id=session_id,
                name=file.filename,
                created_at=datetime.now().isoformat(),
                updated_at=datetime.now().isoformat(),
                original_html=result['html'],
                original_json=result['json'],
                metadata=result['metadata'],
                current_data=result['json']
            )

            sessions[session_id] = session
            _save_session(session_id)

            return {
                "success": True,
                "session_id": session_id,
                "html": result['html'],
                "json": result['json'],
                "metadata": result['metadata']
            }

    except Exception as e:
        # Clean up file on error
        if file_path.exists():
            file_path.unlink()
        raise HTTPException(status_code=500, detail=f"Error processing file: {str(e)}")


@app.get("/api/sessions")
async def list_sessions():
    """List all active editing sessions."""
    return {
        "sessions": [
            {
                "id": s.id,
                "name": s.name,
                "created_at": s.created_at,
                "updated_at": s.updated_at,
                "row_count": s.metadata.get('row_count', 0),
                "col_count": s.metadata.get('col_count', 0),
                "published": s.id in published_forms,
                "share_token": published_forms.get(s.id),
                "response_count": len(response_store.get(s.id, []))
            }
            for s in sessions.values()
        ]
    }


@app.get("/api/sessions/{session_id}")
async def get_session(session_id: str):
    """Get session data by ID."""
    if session_id not in sessions:
        raise HTTPException(status_code=404, detail="Session not found")

    session = sessions[session_id]
    return {
        "id": session.id,
        "name": session.name,
        "html": session.original_html,
        "json": session.original_json,
        "current_data": session.current_data or session.original_json,
        "metadata": session.metadata,
        "form": session.form_data,
        "created_at": session.created_at,
        "updated_at": session.updated_at
    }


@app.post("/api/sessions/{session_id}/save")
async def save_session(session_id: str, request: SaveRequest):
    """Save edited data to session."""
    if session_id not in sessions:
        raise HTTPException(status_code=404, detail="Session not found")

    session = sessions[session_id]
    session.current_data = request.data
    session.updated_at = datetime.now().isoformat()
    _save_session(session_id)

    return {"success": True, "updated_at": session.updated_at}


@app.get("/api/sessions/{session_id}/export/json")
async def export_json(session_id: str):
    """Export session data as JSON file."""
    if session_id not in sessions:
        raise HTTPException(status_code=404, detail="Session not found")

    session = sessions[session_id]
    data = {
        "session": {
            "id": session.id,
            "name": session.name,
            "created_at": session.created_at,
            "updated_at": session.updated_at
        },
        "metadata": session.metadata,
        "data": session.current_data or session.original_json
    }

    json_str = json.dumps(data, ensure_ascii=False, indent=2)
    json_path = TEMPLATE_DIR / f"{session_id}_export.json"
    json_path.write_text(json_str, encoding='utf-8')

    return FileResponse(
        path=str(json_path),
        filename=f"budget_export_{session.name.replace('.xlsx', '')}_{session_id}.json",
        media_type="application/json"
    )


@app.post("/api/sessions/{session_id}/import/json")
async def import_json(session_id: str, file: UploadFile = File(...)):
    """Import JSON data into session."""
    if session_id not in sessions:
        raise HTTPException(status_code=404, detail="Session not found")

    try:
        content = await file.read()
        data = json.loads(content.decode('utf-8'))

        session = sessions[session_id]
        if 'data' in data:
            session.current_data = data['data']
        session.updated_at = datetime.now().isoformat()

        return {"success": True, "message": "JSON imported successfully"}

    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON file")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error importing JSON: {str(e)}")


@app.post("/api/sessions/{session_id}/reset")
async def reset_session(session_id: str):
    """Reset session to original data."""
    if session_id not in sessions:
        raise HTTPException(status_code=404, detail="Session not found")

    session = sessions[session_id]
    session.current_data = session.original_json

    # Reset form_data to original by re-processing the uploaded file
    if session.form_data:
        import glob
        pattern = str(UPLOAD_DIR / f"{session_id}_*.xlsx")
        files = glob.glob(pattern)
        if files:
            try:
                from backend.xlsx_parser import process_xlsx
                result = process_xlsx(files[0], mode='form')
                session.form_data = result.get('form')
            except Exception as e:
                # If re-processing fails, keep existing form_data
                pass

    session.updated_at = datetime.now().isoformat()

    return {"success": True, "message": "Session reset to original data"}


@app.delete("/api/sessions/{session_id}")
async def delete_session(session_id: str):
    """Delete a session."""
    if session_id not in sessions:
        raise HTTPException(status_code=404, detail="Session not found")

    del sessions[session_id]
    _save_session(session_id)  # updates index
    return {"success": True, "message": "Session deleted"}


@app.post("/api/templates/save")
async def save_template(request: TemplateData):
    """Save current data as a reusable template."""
    template_id = str(uuid.uuid4())[:8]
    template_path = TEMPLATE_DIR / f"template_{template_id}.json"

    template_data = {
        "id": template_id,
        "name": request.name,
        "created_at": datetime.now().isoformat(),
        "data": request.data,
        "metadata": request.metadata or {}
    }

    template_path.write_text(json.dumps(template_data, ensure_ascii=False, indent=2), encoding='utf-8')

    return {"success": True, "template_id": template_id}


@app.get("/api/templates")
async def list_templates():
    """List all saved templates."""
    templates = []
    for f in TEMPLATE_DIR.glob("template_*.json"):
        try:
            data = json.loads(f.read_text(encoding='utf-8'))
            templates.append({
                "id": data.get('id'),
                "name": data.get('name'),
                "created_at": data.get('created_at'),
                "row_count": len(data.get('data', []))
            })
        except:
            continue

    return {"templates": templates}


@app.post("/api/templates/{template_id}/load")
async def load_template(template_id: str):
    """Load a template and create a new session from it."""
    template_path = TEMPLATE_DIR / f"template_{template_id}.json"
    if not template_path.exists():
        raise HTTPException(status_code=404, detail="Template not found")

    template_data = json.loads(template_path.read_text(encoding='utf-8'))

    # Create new session from template
    session_id = str(uuid.uuid4())[:8]
    session = SessionData(
        id=session_id,
        name=template_data.get('name', 'Untitled'),
        created_at=datetime.now().isoformat(),
        updated_at=datetime.now().isoformat(),
        original_html="",
        original_json=template_data.get('data', []),
        metadata=template_data.get('metadata', {}),
        current_data=template_data.get('data', [])
    )

    sessions[session_id] = session

    _save_session(session_id)
    return {"success": True, "session_id": session_id}


# ========== Publish / Fill / Responses ==========

class PublishResponse(BaseModel):
    share_token: str
    fill_url: str
    published_at: str
    response_count: int

class SubmitRequest(BaseModel):
    data: list
    respondent: Optional[str] = ""

@app.post("/api/sessions/{session_id}/publish")
async def publish_form(session_id: str):
    """Publish a form for others to fill."""
    if session_id not in sessions:
        raise HTTPException(status_code=404, detail="Session not found")

    if session_id in published_forms:
        token = published_forms[session_id]
    else:
        token = str(uuid.uuid4())[:12]
        publish_store[token] = session_id
        published_forms[session_id] = token
        _save_persist("publish_store")
        _save_persist("published_forms")

    return PublishResponse(
        share_token=token,
        fill_url=f"/fill/{token}",
        published_at=datetime.now().isoformat(),
        response_count=len(response_store.get(session_id, []))
    )

@app.get("/api/sessions/{session_id}/publish")
async def get_publish_status(session_id: str):
    """Get publish status for a session."""
    if session_id not in sessions:
        raise HTTPException(status_code=404, detail="Session not found")

    if session_id in published_forms:
        token = published_forms[session_id]
        return PublishResponse(
            share_token=token,
            fill_url=f"/fill/{token}",
            published_at=datetime.now().isoformat(),
            response_count=len(response_store.get(session_id, []))
        )
    return {"published": False}

@app.delete("/api/sessions/{session_id}/publish")
async def unpublish_form(session_id: str):
    """Unpublish a form."""
    if session_id not in sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    if session_id in published_forms:
        token = published_forms.pop(session_id)
        publish_store.pop(token, None)
        _save_persist("published_forms")
        _save_persist("publish_store")
    return {"success": True, "published": False}

@app.get("/fill/{token}")
async def fill_form_page(token: str):
    """Serve fill-mode HTML page."""
    frontend_path = Path(__file__).parent.parent / "frontend" / "index.html"
    if not frontend_path.exists():
        raise HTTPException(status_code=404, detail="Page not found")
    html = frontend_path.read_text(encoding='utf-8')
    # Inject fill token and CSS to hide other sections, show fill mode
    head_script = f'<script>window.FILL_TOKEN="{token}";</script>'
    head_style = '<style>#projects-section{display:none!important}#editor{display:none!important}#fill-mode{display:block!important}#fill-banner{display:block!important}</style>'
    html = html.replace("</head>", f"{head_script}{head_style}</head>")
    return HTMLResponse(content=html, headers={"Cache-Control": "no-cache, no-store, must-revalidate", "Pragma": "no-cache", "Expires": "0"})

@app.get("/api/fill/{token}/data")
async def get_fill_data(token: str):
    """Get form data for fill mode."""
    if token not in publish_store:
        raise HTTPException(status_code=404, detail="Form not found or has been unpublished")
    session_id = publish_store[token]
    if session_id not in sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    session = sessions[session_id]
    data = session.current_data or session.original_json
    return {
        "session_id": session_id,
        "name": session.name,
        "data": data,
        "metadata": session.metadata
    }

@app.post("/api/fill/{token}/submit")
async def submit_fill(token: str, request: SubmitRequest):
    """Submit a filled form response."""
    if token not in publish_store:
        raise HTTPException(status_code=404, detail="Form not found or has been unpublished")
    session_id = publish_store[token]

    resp = {
        "id": str(uuid.uuid4())[:8],
        "session_id": session_id,
        "data": request.data,
        "respondent": request.respondent or "",
        "submitted_at": datetime.now().isoformat()
    }
    if session_id not in response_store:
        response_store[session_id] = []
    response_store[session_id].append(resp)
    _save_persist("response_store")

    return {"success": True, "response_id": resp["id"], "submitted_at": resp["submitted_at"]}

@app.get("/api/sessions/{session_id}/responses")
async def list_responses(session_id: str):
    """List all submitted responses for a session."""
    if session_id not in sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    responses = response_store.get(session_id, [])
    return {
        "session_id": session_id,
        "count": len(responses),
        "responses": [
            {
                "id": r["id"],
                "submitted_at": r["submitted_at"],
                "respondent": r["respondent"]
            }
            for r in responses
        ]
    }

@app.get("/api/sessions/{session_id}/responses/{response_id}")
async def get_response(session_id: str, response_id: str):
    """Get a single response with full data."""
    if session_id not in sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    responses = response_store.get(session_id, [])
    for r in responses:
        if r["id"] == response_id:
            return r
    raise HTTPException(status_code=404, detail="Response not found")

@app.delete("/api/sessions/{session_id}/responses/{response_id}")
async def delete_response(session_id: str, response_id: str):
    """Delete a single response."""
    if session_id not in sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    responses = response_store.get(session_id, [])
    for i, r in enumerate(responses):
        if r["id"] == response_id:
            del response_store[session_id][i]
            _save_persist("response_store")
            return {"success": True, "deleted": response_id}
    raise HTTPException(status_code=404, detail="Response not found")

@app.get("/api/sessions/{session_id}/responses/export/csv")
async def export_responses_csv(session_id: str):
    """Export all responses as CSV."""
    if session_id not in sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    session = sessions[session_id]
    responses = response_store.get(session_id, [])
    if not responses:
        raise HTTPException(status_code=404, detail="No responses to export")

    # Build CSV: headers from original data row 0, then each response
    data = session.current_data or session.original_json
    headers = [c.get("value", "") for c in (data[0] if data else [])]

    import io
    import csv
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["回應時間", "填表人"] + headers)

    for r in responses:
        row_data = r.get("data", [])
        # Flatten the first data row's values
        vals = [c.get("value", "") for c in (row_data[0] if row_data else [])]
        writer.writerow([r["submitted_at"], r["respondent"]] + vals)

    csv_content = output.getvalue()
    return Response(
        content=csv_content,
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename=responses_{session_id}.csv"}
    )

# Mount static files for frontend assets
frontend_dir = Path(__file__).parent.parent / "frontend"
if frontend_dir.exists():
    app.mount("/static", StaticFiles(directory=str(frontend_dir)), name="static")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=7860)