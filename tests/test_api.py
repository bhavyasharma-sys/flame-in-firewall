"""
Comprehensive End-to-End Test Suite for Flame in Freefall v3.0
Covers REST endpoints, SSE streaming, combustion physics, exact 2^5 Shapley identity,
50-run scenario ranking, telemetry, explainable rankings, KG, NASA documents/PDFs,
in-chat Matplotlib chart generation, citation audit, and out-of-scope guard.
"""

from __future__ import annotations

import json
import unittest

from fastapi.testclient import TestClient

import server


class FlameInFreefallAPITests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.client = TestClient(server.app)

    def test_health_and_stats(self) -> None:
        r = self.client.get("/api/health")
        self.assertEqual(r.status_code, 200)
        h = r.json()
        self.assertEqual(h["status"], "healthy")
        self.assertGreaterEqual(h["counts"]["experiments"], 12)
        self.assertGreaterEqual(h["counts"]["test_runs"], 50)
        self.assertGreaterEqual(h["counts"]["documents"], 13)
        self.assertGreaterEqual(h["graph"]["node_count"], 150)

        rs = self.client.get("/api/stats")
        self.assertEqual(rs.status_code, 200)
        s = rs.json()
        self.assertEqual(s["total_test_runs"], 50)
        self.assertIn("Sustained Burn", s["run_regimes"])

    def test_mission_summary_and_unified_search(self) -> None:
        r = self.client.get("/api/summary")
        self.assertEqual(r.status_code, 200)
        data = r.json()
        self.assertIn("headline", data)
        self.assertTrue(len(data["recommended_actions"]) >= 3)

        sr = self.client.get("/api/search", params={"q": "BASS"})
        self.assertEqual(sr.status_code, 200)
        sdata = sr.json()
        self.assertGreater(sdata["count"], 0)
        types_found = {item["type"] for item in sdata["results"]}
        self.assertTrue(len(types_found) >= 2)

    def test_cabin_physics_and_exact_shapley_identity(self) -> None:
        payload = {
            "oxygen_pct": 34.0,
            "pressure_kpa": 56.5,
            "flow_velocity_cm_s": 5.0,
            "gravity_g": 0.16,
            "fuel_material": "PMMA",
            "diluent_gas": "N2",
        }
        r = self.client.post("/api/evaluate-cabin", json=payload)
        self.assertEqual(r.status_code, 200)
        res = r.json()
        self.assertEqual(res["risk_band"], "CRITICAL")
        self.assertEqual(len(res["contributions"]), 5)

        # Exact Shapley efficiency: sum(phi_i) == risk_index - baseline_risk
        shapley_sum = sum(c["value"] for c in res["contributions"])
        expected_delta = res["risk_index"] - res["baseline_risk"]
        self.assertAlmostEqual(shapley_sum, expected_delta, delta=0.05)

        # Backward-compatible /api/score endpoint
        sc = self.client.post(
            "/api/score",
            json={"material": "Teflon (PTFE)", "environment": "ISS (Microgravity)", "oxygen_level": "21% (Normal)"},
        )
        self.assertEqual(sc.status_code, 200)
        self.assertGreater(sc.json()["score"], 75.0)

    def test_ventilation_curve_and_phase_grid(self) -> None:
        vc = self.client.get("/api/physics/ventilation-curve")
        self.assertEqual(vc.status_code, 200)
        pts = vc.json()["points"]
        self.assertGreater(len(pts), 40)
        # Minimum LOI shift should occur near ~8 cm/s (BASS-II paradox)
        min_pt = min(pts, key=lambda p: p["loi_shift_pct"])
        self.assertGreaterEqual(min_pt["velocity_cm_s"], 5.0)
        self.assertLessEqual(min_pt["velocity_cm_s"], 11.0)

        pg = self.client.get("/api/physics/phase-grid", params={"material": "PMMA", "gravity_g": 0.0})
        self.assertEqual(pg.status_code, 200)
        self.assertGreater(len(pg.json()["cells"]), 100)

    def test_scenario_run_ranker_and_telemetry(self) -> None:
        r = self.client.post(
            "/api/runs/rank",
            json={
                "config": {
                    "oxygen_pct": 21.0,
                    "pressure_kpa": 101.3,
                    "flow_velocity_cm_s": 8.0,
                    "gravity_g": 0.0,
                    "fuel_material": "PMMA",
                    "diluent_gas": "N2",
                },
                "weights": {"similarity": 0.6, "completeness": 0.2, "criticality": 0.2},
                "limit": 10,
            },
        )
        self.assertEqual(r.status_code, 200)
        runs = r.json()["results"]
        self.assertEqual(len(runs), 10)
        # Scores monotonically non-increasing
        scores = [x["total_score"] for x in runs]
        self.assertEqual(scores, sorted(scores, reverse=True))

        top_id = runs[0]["experiment_id"]
        tel = self.client.get(f"/api/telemetry/{top_id}")
        self.assertEqual(tel.status_code, 200)
        tdata = tel.json()
        self.assertGreaterEqual(len(tdata["time_s"]), 20)
        self.assertEqual(len(tdata["time_s"]), len(tdata["flame_radius_mm"]))

    def test_explainable_entity_rankings_and_compare(self) -> None:
        for ep in ("/api/rank/experiments", "/api/rank/materials", "/api/rank/findings", "/api/rank/guidelines"):
            r = self.client.get(ep)
            self.assertEqual(r.status_code, 200, msg=f"Failed {ep}")
            self.assertGreater(len(r.json()["results"]), 0)

        cmp_r = self.client.get("/api/compare", params={"e1": "SAFFIRE", "e2": "BASS-II"})
        self.assertEqual(cmp_r.status_code, 200)
        self.assertIn("deltas", cmp_r.json())

    def test_knowledge_graph_and_nasa_documents_and_pdfs(self) -> None:
        g = self.client.get("/api/graph")
        self.assertEqual(g.status_code, 200)
        gdata = g.json()
        self.assertGreater(gdata["stats"]["node_count"], 150)
        self.assertGreater(gdata["stats"]["edge_count"], 200)

        docs = self.client.get("/api/documents")
        self.assertEqual(docs.status_code, 200)
        doc_list = docs.json()["documents"]
        self.assertGreaterEqual(len(doc_list), 13)

        doc1 = self.client.get("/api/documents/DOC-01")
        self.assertEqual(doc1.status_code, 200)
        pdf_file = doc1.json().get("pdf_file")
        self.assertTrue(pdf_file)

        pdf_resp = self.client.get(f"/papers/{pdf_file}")
        self.assertEqual(pdf_resp.status_code, 200)
        self.assertTrue(pdf_resp.content.startswith(b"%PDF"))

    def test_chat_sync_chart_citation_audit_and_out_of_scope(self) -> None:
        # In-scope with explicit plot request & active cabin scenario
        r = self.client.post(
            "/api/chat",
            json={
                "message": "Plot the BASS-II ventilation paradox and explain why 8 cm/s is dangerous.",
                "scenario": {
                    "oxygen_pct": 34.0,
                    "pressure_kpa": 56.5,
                    "flow_velocity_cm_s": 5.0,
                    "gravity_g": 0.16,
                    "fuel_material": "PMMA",
                    "diluent_gas": "N2",
                },
            },
        )
        self.assertEqual(r.status_code, 200)
        data = r.json()
        self.assertFalse(data["out_of_scope"])
        self.assertTrue(data["chart"])
        self.assertGreater(len(data["citations"]["verified_doc_citations"]), 0)

        # Out-of-scope safety guard (includes tricky word 'bass' to ensure no false positive)
        oos = self.client.post("/api/chat", json={"message": "How do I tune a bass guitar?"})
        self.assertEqual(oos.status_code, 200)
        odata = oos.json()
        self.assertTrue(odata["out_of_scope"])
        self.assertIn("Warning: This answer is not from the database of NASA.", odata["answer"])
        self.assertEqual(odata["sources"], [])

    def test_chat_sse_streaming(self) -> None:
        with self.client.stream(
            "POST",
            "/api/chat/stream",
            json={"message": "What are FLEX-2 cool flames?"},
        ) as resp:
            self.assertEqual(resp.status_code, 200)
            raw = "".join(resp.iter_text())
        self.assertIn("event: sources", raw)
        self.assertIn("event: token", raw)
        self.assertIn("event: audit", raw)
        self.assertIn("event: done", raw)

    def test_frontend_static_assets_served(self) -> None:
        for path in ("/", "/css/styles.css", "/js/app.js", "/js/flame-shader.js", "/manifest.json"):
            r = self.client.get(path)
            self.assertEqual(r.status_code, 200, msg=f"Static asset failed: {path}")


if __name__ == "__main__":
    unittest.main()
