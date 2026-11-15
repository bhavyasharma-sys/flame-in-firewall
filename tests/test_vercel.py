"""Regression checks for the shared local/Vercel ASGI app and its bundled assets."""

from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import PropertyMock, patch

from fastapi.testclient import TestClient

from api.index import app
import server
from smoke_deployment import smoke_check

ROOT = Path(__file__).resolve().parents[1]


class VercelDeploymentTests(unittest.TestCase):
    def test_vercel_routes_to_the_function_before_the_filesystem(self) -> None:
        config = json.loads((ROOT / "vercel.json").read_text())
        self.assertIsNone(config["framework"])
        self.assertEqual(config["routes"], [{"src": "/(.*)", "dest": "/api/index.py"}])
        self.assertNotIn("rewrites", config)
        for pattern in config["functions"]["api/index.py"].values():
            self.assertLessEqual(len(pattern), 256)
        self.assertEqual((ROOT / ".python-version").read_text().strip(), "3.12")

    def test_entrypoint_exports_the_existing_app(self) -> None:
        self.assertIs(app, server.app)

    def test_required_routes_and_all_bundled_assets(self) -> None:
        with patch.object(type(server.engine.llm), "is_configured", new_callable=PropertyMock, return_value=False):
            smoke_check(TestClient(app))

    def test_source_and_data_are_not_public_static_files(self) -> None:
        client = TestClient(app)
        for path in ("/server.py", "/.env", "/data/knowledge_base/materials.json", "/api/not-a-route"):
            with self.subTest(path=path):
                self.assertEqual(client.get(path).status_code, 404)

    def test_suggestions_serialize_and_validate_the_active_scenario(self) -> None:
        queries = [{"label": "Lunar safety", "prompt": "Explain lunar cabin safety."}]
        with patch.object(type(server.engine.llm), "is_configured", new_callable=PropertyMock, return_value=True):
            with patch.object(server.engine.llm, "generate_quick_queries", return_value=queries) as generate:
                response = TestClient(app).post(
                    "/api/chat/suggestions",
                    json={"messages": [], "notebook_title": "Lunar", "scenario": {"oxygen_pct": 34, "gravity_g": 0.16}},
                )
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json(), {"available": True, "queries": queries})
                scenario = generate.call_args.kwargs["scenario"]
                self.assertEqual(scenario["oxygen_pct"], 34.0)
                self.assertEqual(scenario["gravity_g"], 0.16)
                self.assertEqual(scenario["fuel_material"], "Cotton-Fiberglass")

        invalid = TestClient(app).post("/api/chat/suggestions", json={"scenario": {"oxygen_pct": -1}})
        self.assertEqual(invalid.status_code, 422)

    def test_import_and_routes_without_repository_cwd_or_development_files(self) -> None:
        # Build an isolated source bundle, deliberately omitting .venv, src, tests,
        # local settings/memory, and caches. Dependencies come from the test interpreter.
        with tempfile.TemporaryDirectory() as temp:
            bundle = Path(temp) / "function"
            bundle.mkdir()
            for name in ("server.py", "config.py"):
                shutil.copy2(ROOT / name, bundle / name)
            for name in ("api", "core", "domain", "utils", "frontend", "data/knowledge_base", "data/ember"):
                shutil.copytree(ROOT / name, bundle / name, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))

            env = {key: value for key, value in os.environ.items() if not key.endswith("_API_KEY")}
            env.update(NASA_SYNC_ON_STARTUP="false", PYTHONDONTWRITEBYTECODE="1")
            result = subprocess.run(
                [sys.executable, "-I", "-c", """
import sys
sys.path.insert(0, sys.argv[1])
from fastapi.testclient import TestClient
from api.index import app
from config import NASA_SYNC_ON_STARTUP
assert NASA_SYNC_ON_STARTUP is False
with TestClient(app) as client:
    health = client.get('/api/health').json()
    assert health['counts']['test_runs'] == 50, health
    assert health['counts']['documents'] == 13, health
    assert health['live_nasa_sync']['last_run_at'] is None, health
    for path in ('/', '/css/styles.css', '/js/app.js', '/js/vendor/chart.umd.min.js',
                 '/papers/nasa_glenn_bass.pdf', '/api/telemetry/EXP-0001'):
        assert client.get(path).status_code == 200, path
    assert client.post('/api/chat/suggestions', json={'scenario': {'oxygen_pct': 34}}).json() == {
        'available': False, 'queries': []}
""", str(bundle)],
                cwd=temp,
                env=env,
                capture_output=True,
                text=True,
                timeout=60,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
