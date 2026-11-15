"""
Comprehensive End-to-End Test Suite for Flame in Freefall v3.0
Covers REST endpoints, SSE streaming, combustion physics, exact 2^5 Shapley identity,
50-run scenario ranking, telemetry, explainable rankings, KG, NASA documents/PDFs,
in-chat Matplotlib chart generation, citation audit, and out-of-scope guard.
"""

from __future__ import annotations

import json
import threading
import time
import unittest
from unittest.mock import patch
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from fastapi.testclient import TestClient

from core.nasa_live_sync import extract_ntrs_api_document
import server


class FlameInFreefallAPITests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        # Prevent unmocked external NASA background polling during offline test runs
        server.engine.live_sync._last_run_monotonic = time.monotonic()
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
        for path in (
            "/",
            "/css/styles.css",
            "/js/app.js",
            "/js/flame-shader.js",
            "/js/vendor/chart.umd.min.js",
            "/manifest.json",
            "/sw.js",
            "/icons/icon.svg",
            "/icons/icon-192.png",
            "/icons/icon-512.png",
            "/favicon.ico",
        ):
            r = self.client.get(path)
            self.assertEqual(r.status_code, 200, msg=f"Static asset failed: {path}")

    # ── Regression Tests (Integration Defects 1–13) ───────────────────────────

    def test_regression_search_whitespace_returns_zero(self) -> None:
        r = self.client.get("/api/search?q=%20")
        self.assertEqual(r.status_code, 200)
        data = r.json()
        self.assertEqual(data["count"], 0)
        self.assertEqual(data["results"], [])

    def test_regression_validate_material_and_diluent_422(self) -> None:
        bad_cabin = self.client.post(
            "/api/evaluate-cabin",
            json={"fuel_material": "Unobtainium", "diluent_gas": "N2"},
        )
        self.assertEqual(bad_cabin.status_code, 422)
        self.assertIn("Unobtainium", bad_cabin.json()["detail"])

        bad_dil = self.client.post(
            "/api/evaluate-cabin",
            json={"fuel_material": "PMMA", "diluent_gas": "Xe"},
        )
        self.assertEqual(bad_dil.status_code, 422)
        self.assertIn("Xe", bad_dil.json()["detail"])

        bad_score = self.client.post(
            "/api/score",
            json={"material": "Unobtainium", "environment": "ISS", "oxygen_level": "21%"},
        )
        self.assertEqual(bad_score.status_code, 422)

        bad_grid = self.client.get(
            "/api/physics/phase-grid",
            params={"material": "Unobtainium", "diluent": "N2"},
        )
        self.assertEqual(bad_grid.status_code, 422)

        bad_grid_dil = self.client.get(
            "/api/physics/phase-grid",
            params={"material": "PMMA", "diluent": "Kr"},
        )
        self.assertEqual(bad_grid_dil.status_code, 422)

    def test_regression_compare_unknown_experiment_404(self) -> None:
        r1 = self.client.get("/api/compare", params={"e1": "NOPE", "e2": "BASS-II"})
        self.assertEqual(r1.status_code, 404)
        r2 = self.client.get("/api/compare", params={"e1": "SAFFIRE", "e2": "NOPE"})
        self.assertEqual(r2.status_code, 404)

    def test_regression_runs_rank_record_fields_and_normalization(self) -> None:
        r = self.client.post("/api/runs/rank", json={"limit": 50})
        self.assertEqual(r.status_code, 200)
        results = r.json()["results"]
        self.assertEqual(len(results), 50)

        # Emulate frontend normalization: { ...r, ...(r.record || {}) }
        normalized = [{**item, **(item.get("record") or {})} for item in results]
        for orig, norm in zip(results, normalized):
            self.assertEqual(norm["total_score"], orig["total_score"])
            self.assertEqual(norm["similarity_score"], orig["similarity_score"])
            self.assertEqual(norm["completeness_score"], orig["completeness_score"])
            self.assertEqual(norm["criticality_score"], orig["criticality_score"])
            for field in (
                "program",
                "oxygen_pct",
                "pressure_kpa",
                "flow_velocity_cm_s",
                "gravity_g",
                "fuel_material",
                "combustion_regime",
            ):
                self.assertIn(field, norm)
                self.assertIsNotNone(norm[field])

        programs = sorted({x["program"] for x in normalized})
        regimes = sorted({x["combustion_regime"] for x in normalized})
        self.assertEqual(programs, ["ACME", "BASS-II", "FLEX", "SoFIE"])
        self.assertEqual(len(regimes), 4)

    def test_regression_chat_stream_token_audit_and_done_contract(self) -> None:
        def parse_sse(raw: str) -> list[tuple[str, dict]]:
            events: list[tuple[str, dict]] = []
            for block in raw.strip().split("\n\n"):
                ev_name = None
                data_lines = []
                for line in block.split("\n"):
                    if line.startswith("event:"):
                        ev_name = line[6:].strip()
                    elif line.startswith("data:"):
                        data_lines.append(line[5:].strip())
                if ev_name and data_lines:
                    events.append((ev_name, json.loads("\n".join(data_lines))))
            return events

        with self.client.stream(
            "POST",
            "/api/chat/stream",
            json={"message": "Plot the BASS-II ventilation paradox"},
            headers={"X-Session-Id": "sse-contract-test"},
        ) as resp:
            self.assertEqual(resp.status_code, 200)
            events = parse_sse("".join(resp.iter_text()))

        by_name: dict[str, list[dict]] = {}
        for name, payload in events:
            by_name.setdefault(name, []).append(payload)

        # Sources event includes kg_fact_count & out_of_scope
        self.assertIn("sources", by_name)
        self.assertIn("kg_fact_count", by_name["sources"][0])
        self.assertFalse(by_name["sources"][0]["out_of_scope"])

        # Chart image is a valid data URI with title and caption
        self.assertIn("chart", by_name)
        chart = by_name["chart"][0]
        self.assertTrue(chart["image_base64"].startswith("data:image/png;base64,"))
        self.assertTrue(chart.get("title"))
        self.assertTrue(chart.get("caption"))

        # First token event contains non-empty "token"
        self.assertIn("token", by_name)
        first_tok = by_name["token"][0]
        self.assertIn("token", first_tok)
        self.assertTrue(len(first_tok["token"]) > 0)

        # Audit event contains grounding_pct, checked_sentences, provider, out_of_scope
        self.assertIn("audit", by_name)
        audit = by_name["audit"][0]
        for key in ("grounding_pct", "checked_sentences", "cited_sentences", "provider", "out_of_scope"):
            self.assertIn(key, audit)
        self.assertFalse(audit["out_of_scope"])
        self.assertTrue(audit["provider"])

        # Done event contains final_answer and provider
        self.assertIn("done", by_name)
        done = by_name["done"][0]
        self.assertTrue(done.get("final_answer"))
        self.assertTrue(done.get("provider"))

        # Out-of-scope stream sets out_of_scope == True in sources & audit
        with self.client.stream(
            "POST",
            "/api/chat/stream",
            json={"message": "How do I bake a chocolate cake?"},
            headers={"X-Session-Id": "sse-oos-test"},
        ) as resp:
            oos_events = parse_sse("".join(resp.iter_text()))
        oos_map = {n: p for n, p in oos_events}
        self.assertTrue(oos_map["sources"]["out_of_scope"])
        self.assertTrue(oos_map["audit"]["out_of_scope"])
        self.assertIn("Warning: This answer is not from the database of NASA.", oos_map["done"]["final_answer"])

    def test_regression_graph_nodes_and_edges_schema(self) -> None:
        g = self.client.get("/api/graph").json()
        self.assertTrue(len(g["nodes"]) > 0)
        self.assertTrue(len(g["edges"]) > 0)
        for node in g["nodes"]:
            self.assertIn("node_type", node)
            self.assertTrue(node["node_type"])
        for edge in g["edges"]:
            self.assertIn("relationship", edge)
            self.assertTrue(edge["relationship"])

    def test_regression_cabin_ranked_table_and_u_eff(self) -> None:
        r = self.client.post(
            "/api/evaluate-cabin",
            json={
                "oxygen_pct": 21.0,
                "pressure_kpa": 101.3,
                "flow_velocity_cm_s": 10.0,
                "gravity_g": 0.0,
                "fuel_material": "PMMA",
                "diluent_gas": "N2",
            },
        )
        self.assertEqual(r.status_code, 200)
        data = r.json()
        self.assertIn("u_eff_cm_s", data)
        self.assertIsInstance(data["u_eff_cm_s"], (int, float))

        rows = data["ranked_table"]
        self.assertEqual(len(rows), 12)
        required_cols = ("material", "loi_iss", "iss", "lunar", "martian", "transit", "avg_safety_score")
        for row in rows:
            for col in required_cols:
                self.assertIn(col, row)
                self.assertIsNotNone(row[col])
            expected_avg = round((row["iss"] + row["lunar"] + row["martian"] + row["transit"]) / 4.0, 1)
            self.assertAlmostEqual(row["avg_safety_score"], expected_avg, delta=0.11)

    def test_regression_per_session_chat_memory_isolation(self) -> None:
        sid_a = "session-alpha-isolation"
        sid_b = "session-beta-isolation"
        self.client.delete("/api/chat/memory", headers={"X-Session-Id": sid_a})
        self.client.delete("/api/chat/memory", headers={"X-Session-Id": sid_b})

        ra = self.client.post(
            "/api/chat",
            json={"message": "What are FLEX-2 cool flames?"},
            headers={"X-Session-Id": sid_a},
        )
        self.assertEqual(ra.status_code, 200)
        hist_a = ra.json()["history"]
        self.assertEqual(len(hist_a), 1)
        self.assertIn("FLEX-2", hist_a[0]["user"])

        rb = self.client.post(
            "/api/chat",
            json={"message": "Explain the BASS-II ventilation paradox."},
            headers={"X-Session-Id": sid_b},
        )
        self.assertEqual(rb.status_code, 200)
        hist_b = rb.json()["history"]
        self.assertEqual(len(hist_b), 1)
        self.assertIn("BASS-II", hist_b[0]["user"])
        self.assertNotIn("FLEX-2", json.dumps(hist_b))

        # Clearing session A must not affect session B
        self.client.delete("/api/chat/memory", headers={"X-Session-Id": sid_a})
        rb2 = self.client.post(
            "/api/chat",
            json={"message": "What is PMMA LOI in microgravity?"},
            headers={"X-Session-Id": sid_b},
        )
        self.assertEqual(rb2.status_code, 200)
        self.assertEqual(len(rb2.json()["history"]), 2)

    def test_regression_chat_sources_websites_and_pdfs(self) -> None:
        r = self.client.post(
            "/api/chat",
            json={"message": "Explain partial gravity lunar Mars flammability and SAFFIRE findings."},
            headers={"X-Session-Id": "sources-box-test"},
        )
        self.assertEqual(r.status_code, 200)
        data = r.json()
        self.assertNotIn("Cited NASA Sources:", data["answer"])
        self.assertNotIn("Exact URL not provided in database", data["answer"])

        sources = data["sources"]
        self.assertTrue(len(sources) > 0)
        web_urls = [s["url"] for s in sources if str(s.get("url") or "").startswith("https://")]
        pdf_urls = [s["pdf_url"] for s in sources if str(s.get("pdf_url") or "").startswith("/papers/")]
        self.assertTrue(len(web_urls) > 0, msg="Expected at least one https website source")
        self.assertTrue(len(pdf_urls) > 0, msg="Expected at least one bundled /papers/*.pdf source")
        for pdf in set(pdf_urls):
            pr = self.client.get(pdf)
            self.assertEqual(pr.status_code, 200, msg=f"Bundled PDF not served: {pdf}")

    def test_live_nasa_sync_status_domain_guard_and_ntrs_parser(self) -> None:
        st = self.client.get("/api/sync/status")
        self.assertEqual(st.status_code, 200)
        data = st.json()
        self.assertGreaterEqual(data["total_watched_sources"], 11)
        self.assertTrue(data["corpus_digest"])
        self.assertGreater(data["total_chunks"], 100)

        # SSRF guard: non-NASA domain & non-HTTPS must be rejected with 422
        bad_host = self.client.post(
            "/api/sync/sources",
            json={"url": "https://example.com/fake-nasa", "sync_now": False},
        )
        self.assertEqual(bad_host.status_code, 422)

        bad_scheme = self.client.post(
            "/api/sync/sources",
            json={"url": "http://www.nasa.gov/combustion", "sync_now": False},
        )
        self.assertEqual(bad_scheme.status_code, 422)

        # Built-in NASA sources cannot be deleted
        del_builtin = self.client.delete("/api/sync/sources/LIVE-01")
        self.assertEqual(del_builtin.status_code, 400)

        # Verify NTRS JSON citations parser extracts structured pages cleanly
        parsed_ntrs = extract_ntrs_api_document(
            {
                "results": [
                    {
                        "id": 20260009999,
                        "title": "SoFIE Lunar Exploration Flammability Limits Update",
                        "abstract": "Measured opposed-flow PMMA flame spread at 34% O2 and 56.5 kPa.",
                        "distributionDate": "2026-09-15T00:00:00Z",
                        "authorAffiliations": [{"meta": {"author": {"name": "S. L. Olson"}}}],
                        "subjectCategories": ["Spacecraft Fire Safety"],
                    }
                ]
            }
        )
        self.assertEqual(len(parsed_ntrs["pages"]), 1)
        self.assertIn("20260009999", parsed_ntrs["pages"][0]["text"])
        self.assertIn("S. L. Olson", parsed_ntrs["pages"][0]["text"])

    def test_live_nasa_website_update_auto_updates_rag_pipeline(self) -> None:
        # Local HTTP server simulating a live NASA webpage that updates over time
        page_state = {
            "etag": '"nasa-v1"',
            "html": (
                "<!doctype html><html><head><title>NASA SoFIE Live Bulletin | NASA</title></head>"
                "<body><nav>Skip to main content</nav><main>"
                "<h1>SoFIE Lunar Fire Safety Live Telemetry Update</h1>"
                "<p>NASA Glenn engineers reported that the MIST-7 lunar habitat test measured a "
                "critical flame quenching pressure threshold of 14.7 kPa under 0.16g gravity and 34% oxygen.</p>"
                "</main></body></html>"
            ),
        }

        class MockNasaHandler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802
                if self.headers.get("If-None-Match") == page_state["etag"]:
                    self.send_response(304)
                    self.send_header("ETag", page_state["etag"])
                    self.end_headers()
                    return
                body = page_state["html"].encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("ETag", page_state["etag"])
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, format: str, *args) -> None:  # noqa: A002
                pass

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), MockNasaHandler)
        port = httpd.server_address[1]
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()

        prev_allow_local = server.engine.live_sync.allow_local_test_urls
        added_doc_id = None
        try:
            server.engine.live_sync.allow_local_test_urls = True
            base_digest = self.client.get("/api/sync/status").json()["corpus_digest"]

            # 1. Register & sync v1 of the live NASA webpage
            add_resp = self.client.post(
                "/api/sync/sources",
                json={
                    "url": f"http://127.0.0.1:{port}/sofie-live-update",
                    "title": "NASA SoFIE Live Bulletin",
                    "investigation": "SoFIE Live",
                    "sync_now": True,
                },
            )
            self.assertEqual(add_resp.status_code, 200)
            added = add_resp.json()
            added_doc_id = added["source"]["doc_id"]
            self.assertTrue(added["sync"]["rag_rebuilt"])
            self.assertEqual(added["sync"]["updated_count"], 1)
            digest_v1 = added["corpus_digest"]
            self.assertNotEqual(digest_v1, base_digest)

            # Document reader immediately serves the live-synced NASA page
            doc_resp = self.client.get(f"/api/documents/{added_doc_id}")
            self.assertEqual(doc_resp.status_code, 200)
            self.assertTrue(doc_resp.json()["is_live"])
            self.assertIn("14.7 kPa", doc_resp.json()["pages"][0]["text"])

            # FlameAI RAG immediately answers using v1 live NASA data & verifies [LIVE-XX p.1]
            chat_v1 = self.client.post(
                "/api/chat",
                json={"message": "What MIST-7 lunar flame quenching pressure threshold did NASA measure?"},
                headers={"X-Session-Id": "live-sync-rag-v1"},
            )
            self.assertEqual(chat_v1.status_code, 200)
            c1 = chat_v1.json()
            self.assertFalse(c1["out_of_scope"])
            self.assertIn("14.7 kPa", c1["answer"])
            self.assertTrue(any(s.get("is_live") for s in c1["sources"]))
            self.assertTrue(
                any(c.get("doc_id") == added_doc_id for c in c1["citations"]["verified_doc_citations"]),
                msg=f"Expected verified live citation {added_doc_id}, got {c1['citations']}",
            )

            # 2. Re-sync without changes -> 304 Not Modified, zero unnecessary RAG rebuilds
            resync_304 = self.client.post(
                "/api/sync/nasa",
                json={"force": False, "doc_id": added_doc_id},
            )
            self.assertEqual(resync_304.status_code, 200)
            r304 = resync_304.json()
            self.assertFalse(r304["rag_rebuilt"])
            self.assertEqual(r304["unchanged_count"], 1)
            self.assertEqual(r304["corpus_digest_after"], digest_v1)

            # 3. Mutate the live NASA webpage -> sync detects update & hot-swaps RAG pipeline
            page_state["etag"] = '"nasa-v2"'
            page_state["html"] = (
                "<!doctype html><html><head><title>NASA SoFIE Live Bulletin | NASA</title></head>"
                "<body><main>"
                "<h1>SoFIE Lunar Fire Safety Live Telemetry Update (Revised)</h1>"
                "<p>Revised NASA Glenn flight analysis updated the MIST-7 lunar flame quenching "
                "pressure threshold to 19.3 kPa under 0.16g gravity, validated alongside the newly "
                "announced HELIOS-9 microgravity smoldering detector payload.</p>"
                "</main></body></html>"
            )
            resync_v2 = self.client.post(
                "/api/sync/nasa",
                json={"force": False, "doc_id": added_doc_id},
            )
            self.assertEqual(resync_v2.status_code, 200)
            rv2 = resync_v2.json()
            self.assertTrue(rv2["rag_rebuilt"])
            self.assertEqual(rv2["updated_count"], 1)
            self.assertNotEqual(rv2["corpus_digest_after"], digest_v1)

            # FlameAI RAG now returns the updated 19.3 kPa value & brand-new HELIOS-9 payload (NOT stale 14.7 kPa)
            chat_v2 = self.client.post(
                "/api/chat",
                json={"message": "What is the revised MIST-7 lunar flame quenching pressure threshold and HELIOS-9 payload?"},
                headers={"X-Session-Id": "live-sync-rag-v2"},
            )
            self.assertEqual(chat_v2.status_code, 200)
            c2 = chat_v2.json()
            self.assertFalse(c2["out_of_scope"])
            self.assertIn("19.3 kPa", c2["answer"])
            self.assertIn("HELIOS-9", c2["answer"])
            self.assertNotIn("14.7 kPa", c2["answer"])
        finally:
            if added_doc_id:
                del_r = self.client.delete(f"/api/sync/sources/{added_doc_id}")
                self.assertEqual(del_r.status_code, 200)
            server.engine.live_sync.allow_local_test_urls = prev_allow_local
            httpd.shutdown()
            httpd.server_close()

    def test_user_settings_themes_and_persistent_api_keys(self) -> None:
        import os
        import tempfile
        from unittest.mock import patch

        prev_prefs = dict(server.engine.user_preferences)
        prev_keys = dict(server.engine._saved_api_keys)
        prev_pref_prov = server.engine.llm.preferred_provider
        prev_models = {
            "openai": server.engine.llm.openai_model,
            "gemini": server.engine.llm.gemini_model,
            "groq": server.engine.llm.groq_model,
            "openrouter": server.engine.llm.openrouter_model,
        }
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_settings = os.path.join(tmpdir, "user_settings.json")
            with patch.object(server, "USER_SETTINGS_FILE", tmp_settings):
                try:
                    # 1. Save theme/font preferences + OpenAI key and confirm key is masked, never echoed raw
                    r = self.client.post(
                        "/api/settings",
                        json={
                            "preferences": {"palette": "orbital-gold", "font": "space-grotesk", "scale": "comfortable"},
                            "preferred_provider": "openai",
                            "api_keys": {"openai": "sk-test-1234567890abcdef"},
                            "models": {"openai": "gpt-4o-mini"},
                        },
                    )
                    self.assertEqual(r.status_code, 200)
                    body = r.json()
                    self.assertEqual(body["preferences"]["palette"], "orbital-gold")
                    self.assertEqual(body["preferences"]["font"], "space-grotesk")
                    self.assertEqual(body["ai"]["active_provider"], "openai")
                    self.assertTrue(body["ai"]["providers"]["openai"]["configured"])
                    self.assertEqual(body["ai"]["providers"]["openai"]["masked_key"], "sk-t••••cdef")
                    self.assertNotIn("1234567890ab", r.text)

                    # 2. GET /api/settings returns persisted state & masked preview
                    g = self.client.get("/api/settings")
                    self.assertEqual(g.status_code, 200)
                    gb = g.json()
                    self.assertEqual(gb["preferences"]["palette"], "orbital-gold")
                    self.assertEqual(gb["ai"]["active_provider"], "openai")
                    self.assertNotIn("1234567890ab", g.text)

                    # 3. Reset cleanly clears stored keys & preferences
                    rs = self.client.post("/api/settings/reset")
                    self.assertEqual(rs.status_code, 200)
                    rb = rs.json()
                    self.assertEqual(rb["preferences"], {})
                    self.assertEqual(rb["ai"]["active_provider"], "offline_grounded")
                    self.assertFalse(rb["ai"]["providers"]["openai"]["configured"])
                finally:
                    server.engine.user_preferences = prev_prefs
                    server.engine._saved_api_keys = prev_keys
                    server.engine.llm.update_credentials(
                        preferred_provider=prev_pref_prov,
                        openai_key=prev_keys.get("openai", ""),
                        gemini_key=prev_keys.get("gemini", ""),
                        groq_key=prev_keys.get("groq", ""),
                        openrouter_key=prev_keys.get("openrouter", ""),
                        openai_model=prev_models["openai"],
                        gemini_model=prev_models["gemini"],
                        groq_model=prev_models["groq"],
                        openrouter_model=prev_models["openrouter"],
                    )

    def test_extract_models_from_provider_api_key(self) -> None:
        import os
        import tempfile
        from unittest.mock import AsyncMock, patch

        prev_prefs = dict(server.engine.user_preferences)
        prev_keys = dict(server.engine._saved_api_keys)
        prev_pref_prov = server.engine.llm.preferred_provider
        prev_models = {
            "openai": server.engine.llm.openai_model,
            "gemini": server.engine.llm.gemini_model,
            "groq": server.engine.llm.groq_model,
            "openrouter": server.engine.llm.openrouter_model,
        }

        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_settings = os.path.join(tmpdir, "user_settings.json")
            with patch.object(server, "USER_SETTINGS_FILE", tmp_settings):
                try:
                    self.client.post("/api/settings/reset")

                    # 1. Unsupported provider -> 422; missing API key -> 400
                    bad = self.client.post("/api/settings/models", json={"provider": "unknown_llm", "api_key": "abc"})
                    self.assertEqual(bad.status_code, 422)
                    missing = self.client.post("/api/settings/models", json={"provider": "openai"})
                    self.assertEqual(missing.status_code, 400)

                    # 2. Mock provider model discovery for OpenAI, Gemini, Groq, and OpenRouter
                    sample_catalog = {
                        "openai": [
                            {"id": "gpt-4o", "label": "gpt-4o", "owned_by": "openai", "category": "chat"},
                            {"id": "gpt-4o-mini", "label": "gpt-4o-mini", "owned_by": "openai", "category": "chat"},
                        ],
                        "gemini": [
                            {"id": "gemini-2.5-flash", "label": "Gemini 2.5 Flash (gemini-2.5-flash)", "owned_by": "google", "context_length": 1048576, "category": "chat"},
                        ],
                        "groq": [
                            {"id": "llama-3.3-70b-versatile", "label": "llama-3.3-70b-versatile", "owned_by": "groq", "context_length": 131072, "category": "chat"},
                        ],
                        "openrouter": [
                            {"id": "anthropic/claude-3.7-sonnet", "label": "Claude 3.7 Sonnet — anthropic/claude-3.7-sonnet", "owned_by": "anthropic", "context_length": 200000, "category": "chat"},
                        ],
                    }

                    async def fake_fetch(provider: str, api_key: str):
                        self.assertTrue(len(api_key) > 4)
                        return sample_catalog[provider]

                    with patch.object(server, "_fetch_provider_models_http", new=AsyncMock(side_effect=fake_fetch)):
                        for prov in ("openai", "gemini", "groq", "openrouter"):
                            r = self.client.post(
                                "/api/settings/models",
                                json={"provider": prov, "api_key": f"test-key-{prov}-9999"},
                            )
                            self.assertEqual(r.status_code, 200)
                            body = r.json()
                            self.assertEqual(body["provider"], prov)
                            self.assertEqual(body["count"], len(sample_catalog[prov]))
                            self.assertEqual(body["models"][0]["id"], sample_catalog[prov][0]["id"])
                            self.assertNotIn("9999", r.text)

                        # Also verify discovery falls back to the backend's saved key when api_key is omitted
                        self.client.post(
                            "/api/settings",
                            json={"api_keys": {"gemini": "AIzaSyTestSavedKey12345"}},
                        )
                        r2 = self.client.post("/api/settings/models", json={"provider": "gemini"})
                        self.assertEqual(r2.status_code, 200)
                        self.assertEqual(r2.json()["models"][0]["id"], "gemini-2.5-flash")
                finally:
                    server.engine.user_preferences = prev_prefs
                    server.engine._saved_api_keys = prev_keys
                    server.engine.llm.update_credentials(
                        preferred_provider=prev_pref_prov,
                        openai_key=prev_keys.get("openai", ""),
                        gemini_key=prev_keys.get("gemini", ""),
                        groq_key=prev_keys.get("groq", ""),
                        openrouter_key=prev_keys.get("openrouter", ""),
                        openai_model=prev_models["openai"],
                        gemini_model=prev_models["gemini"],
                        groq_model=prev_models["groq"],
                        openrouter_model=prev_models["openrouter"],
                    )

    def test_chat_suggestions_only_when_ai_available(self) -> None:
        # When running in offline_grounded mode (no live AI), quick queries must be hidden/empty
        prev_pref = server.engine.llm.preferred_provider
        prev_openai = server.engine.llm.openai_key
        try:
            server.engine.llm.update_credentials(preferred_provider="offline_grounded")
            r_off = self.client.post(
                "/api/chat/suggestions",
                json={"messages": [{"role": "user", "content": "Explain BASS-II"}]},
            )
            self.assertEqual(r_off.status_code, 200)
            self.assertEqual(r_off.json(), {"available": False, "queries": []})

            # When a live AI provider is configured and returns JSON queries, return them
            server.engine.llm.update_credentials(
                preferred_provider="openai",
                openai_key="sk-test-1234567890",
            )
            with patch.object(
                server.engine.llm,
                "_call_openai_compat",
                return_value='[{"label":"BASS-II Flow Curve","prompt":"Plot the BASS-II opposed-flow LOI shift curve."}]',
            ):
                r_on = self.client.post(
                    "/api/chat/suggestions",
                    json={"messages": [{"role": "user", "content": "Explain BASS-II"}]},
                )
                self.assertEqual(r_on.status_code, 200)
                data = r_on.json()
                self.assertTrue(data["available"])
                self.assertEqual(len(data["queries"]), 1)
                self.assertEqual(data["queries"][0]["label"], "BASS-II Flow Curve")
        finally:
            server.engine.llm.update_credentials(
                preferred_provider=prev_pref,
                openai_key=prev_openai,
            )


if __name__ == "__main__":
    unittest.main()
