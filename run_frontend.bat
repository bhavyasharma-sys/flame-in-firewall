@echo off
echo Starting Flame in Freefall v3.0 — NASA Fire Safety Intelligence...
python -m uvicorn server:app --host 0.0.0.0 --port 8000
pause
