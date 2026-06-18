#!/bin/bash
# Start script for local development
cd "$(dirname "$0")"
uvicorn backend.main:app --host 0.0.0.0 --port 7860 --reload