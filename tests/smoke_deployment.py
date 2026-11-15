"""Read-only smoke checks: python tests/smoke_deployment.py https://PROJECT.vercel.app"""

from __future__ import annotations

import argparse
from pathlib import Path

import httpx

FRONTEND = Path(__file__).resolve().parents[1] / "frontend"


def smoke_check(client) -> None:
    def get(path: str):
        response = client.get(path)
        assert response.status_code == 200, f"GET {path}: HTTP {response.status_code}"
        print(f"PASS GET {path}")
        return response

    health = get("/api/health").json()
    assert health["status"] == "healthy", health
    assert health["counts"]["test_runs"] == 50, health["counts"]
    assert health["counts"]["documents"] >= 13, health["counts"]
    assert not health["live_nasa_sync"]["syncing"], health["live_nasa_sync"]
    assert get("/api/stats").json()["total_test_runs"] == 50
    runs = get("/api/runs").json()
    assert runs["count"] == len(runs["runs"]) == 50, runs["count"]
    get("/api/documents")
    for run in runs["runs"]:
        experiment_id = run["experiment_id"]
        telemetry = get(f"/api/telemetry/{experiment_id}").json()
        assert telemetry["experiment_id"] == experiment_id
        assert len(telemetry["time_s"]) == 40, experiment_id
    assert "text/html" in get("/").headers["content-type"]

    # Check every shipped asset, including all nine PDFs and the vendored chart library.
    for asset in sorted(FRONTEND.rglob("*")):
        if not asset.is_file() or asset.name == "index.html":
            continue
        path = "/" + asset.relative_to(FRONTEND).as_posix()
        response = get(path)
        assert response.content == asset.read_bytes(), f"Incorrect asset body: {path}"
        if asset.suffix == ".pdf":
            assert "application/pdf" in response.headers["content-type"], path
            assert response.content.startswith(b"%PDF-"), path

    for path in ("/", "/sw.js"):
        response = client.head(path)
        assert response.status_code == 200, f"HEAD {path}: HTTP {response.status_code}"
        print(f"PASS HEAD {path}")

    for scenario in (None, {"oxygen_pct": 34.0, "gravity_g": 0.16}):
        response = client.post(
            "/api/chat/suggestions",
            json={"messages": [], "notebook_title": "Deployment smoke check", "scenario": scenario},
        )
        assert response.status_code == 200, f"POST /api/chat/suggestions: {response.status_code}"
        payload = response.json()
        assert isinstance(payload["available"], bool), payload
        assert isinstance(payload["queries"], list), payload
        if not health["ai_configured"]:
            assert payload == {"available": False, "queries": []}, payload
        print(f"PASS POST /api/chat/suggestions (scenario={scenario is not None})")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("base_url", help="Public production URL, including https://")
    args = parser.parse_args()
    with httpx.Client(base_url=args.base_url.rstrip("/"), timeout=60, follow_redirects=False) as client:
        smoke_check(client)
    print("All deployment smoke checks passed.")
