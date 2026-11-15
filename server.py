"""
FastAPI Backend Server — Flame in Freefall v3.0
Unified NASA Space Apps 2026 Fire Safety Intelligence Platform combining:
  - Team Eagle20's Hybrid Graph-RAG, Knowledge Graph, Radar Compare & Explainable Rankings
  - EMBER's Combustion Physics, Exact Shapley Attribution, 3D WebGL2 Flame Twin APIs,
    50-Run Scenario Telemetry Ranker, NASA Research Library & Citation Audit.
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
import json
import logging
import os
import sys
import threading
from typing import Any, Optional

from fastapi import FastAPI, Header, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)

from config import (
    APP_TITLE,
    APP_VERSION,
    CORS_ORIGINS,
    FRONTEND_DIR,
    MAX_CHAT_MESSAGE_CHARS,
    NASA_LIVE_SYNC_ENABLED,
    NASA_SYNC_ON_STARTUP,
    TOP_K_RESULTS,
    USER_SETTINGS_FILE,
)
from core.ingestion import compute_corpus_digest, load_and_chunk_data
from core.knowledge_graph import KnowledgeGraph
from core.llm_client import LLMClient
from core.memory import ConversationMemory, SessionMemoryStore
from core.nasa_live_sync import NasaLiveSyncManager
from core.rag_pipeline import RAGPipeline
from core.vectorstore import VectorStore
from domain.combustion import (
    ALLOWED_CANONICAL_MATERIALS,
    ALLOWED_DILUENTS,
    canonical_material,
    phase_grid,
    validate_diluent,
    validate_material,
    ventilation_curve,
)
from domain.entity_ranker import (
    rank_experiments_explainable,
    rank_findings_explainable,
    rank_guidelines_explainable,
    rank_materials_explainable,
)
from domain.fire_risk import (
    build_engineering_guidance,
    evaluate_cabin,
    habitat_materials_matrix,
)
from domain.scenario_ranker import DEFAULT_WEIGHTS, rank_runs
from domain.types import CabinParams
from utils.data_loader import (
    get_experiment_by_id,
    get_material_by_name,
    load_all_data,
)
from utils.helpers import clean_markdown_text, color_for_risk, find_similar_findings

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(levelname)s: %(message)s")
logger = logging.getLogger("FlameServer")


async def _nasa_sync_scheduler() -> None:
    """Periodic background loop polling official NASA websites for RAG updates."""
    try:
        if NASA_SYNC_ON_STARTUP:
            await asyncio.sleep(2.0)
            await asyncio.to_thread(engine.live_sync.sync_all, force=False)
        while True:
            await asyncio.sleep(engine.live_sync.interval_seconds)
            if engine.live_sync.enabled:
                await asyncio.to_thread(engine.live_sync.sync_all, force=False)
    except asyncio.CancelledError:
        logger.info("NASA live sync scheduler stopped cleanly.")
    except Exception as exc:
        logger.warning("NASA live sync scheduler encountered an error: %s", exc)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    task: Optional[asyncio.Task] = None
    if engine.live_sync.enabled:
        task = asyncio.create_task(_nasa_sync_scheduler(), name="nasa-live-sync-scheduler")
    try:
        yield
    finally:
        if task is not None:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass


class _SSESafeGZipMiddleware:
    """Applies GZip compression to HTML/CSS/JS/JSON responses while bypassing SSE streams."""

    def __init__(self, app, minimum_size: int = 500) -> None:
        self.app = app
        self.gzip = GZipMiddleware(app, minimum_size=minimum_size)

    async def __call__(self, scope, receive, send) -> None:
        if scope.get("type") == "http" and str(scope.get("path", "")).endswith("/stream"):
            await self.app(scope, receive, send)
            return
        await self.gzip(scope, receive, send)


app = FastAPI(title=APP_TITLE, version=APP_VERSION, lifespan=lifespan)

allow_all = "*" in CORS_ORIGINS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if allow_all else CORS_ORIGINS,
    allow_credentials=False if allow_all else True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(_SSESafeGZipMiddleware, minimum_size=500)


@app.middleware("http")
async def smart_asset_cache_headers(request, call_next):
    response = await call_next(request)
    path = request.url.path
    # Explicitly permit microphone capture on same-origin & embedded preview contexts
    response.headers.setdefault("Permissions-Policy", "microphone=(self)")
    if path.startswith("/js/vendor/") or path.startswith("/icons/") or path.startswith("/papers/"):
        response.headers["Cache-Control"] = "public, max-age=86400"
    elif path in ("/", "/sw.js", "/manifest.json") or (
        path.startswith("/js/") or path.startswith("/css/")
    ):
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return response


# ── Singleton Core Engine ─────────────────────────────────────────────────────
class EngineState:
    def __init__(self) -> None:
        self._rebuild_lock = threading.RLock()
        self.all_data = load_all_data()
        self._base_documents = list(self.all_data.get("documents") or [])

        # Initialize Live NASA Sync Manager and merge any previously cached live NASA docs
        self.live_sync = NasaLiveSyncManager(
            enabled=NASA_LIVE_SYNC_ENABLED,
            on_corpus_updated=self.apply_live_documents,
        )
        initial_live_docs = self.live_sync.get_live_documents()
        if initial_live_docs:
            self.all_data["documents"] = list(self._base_documents) + initial_live_docs

        self.kg = KnowledgeGraph()
        self.kg.build_from_all_data(self.all_data)

        chunks = load_and_chunk_data(
            documents=self.all_data.get("documents"),
            test_runs=self.all_data.get("test_runs"),
        )
        digest = compute_corpus_digest(chunks)
        self.vectorstore = VectorStore()
        self.vectorstore.build_index(chunks, digest=digest)

        self.llm = LLMClient()
        self.user_preferences: dict[str, Any] = {}
        self._saved_api_keys: dict[str, str] = {}
        self._load_persisted_settings()
        self.memory = ConversationMemory()
        self.session_memories = SessionMemoryStore(default_memory=self.memory, max_sessions=256)
        self.rag = RAGPipeline(
            vectorstore=self.vectorstore,
            knowledge_graph=self.kg,
            llm_client=self.llm,
            memory=self.memory,
            all_data=self.all_data,
        )
        self.docs_by_id = {
            str(d["doc_id"]).upper(): d for d in (self.all_data.get("documents") or [])
        }
        self.runs_by_id = {
            str(r["experiment_id"]).upper(): r for r in (self.all_data.get("test_runs") or [])
        }

    def _load_persisted_settings(self) -> None:
        """Restore saved theme/font preferences and provider API keys on startup."""
        if not os.path.exists(USER_SETTINGS_FILE):
            return
        try:
            with open(USER_SETTINGS_FILE, "r", encoding="utf-8") as fh:
                payload = json.load(fh)
            if not isinstance(payload, dict):
                return
            prefs = payload.get("preferences")
            if isinstance(prefs, dict):
                self.user_preferences = dict(prefs)
            creds = payload.get("credentials")
            if isinstance(creds, dict):
                keys = creds.get("api_keys") or {}
                models = creds.get("models") or {}
                if isinstance(keys, dict):
                    self._saved_api_keys = {
                        k: str(v).strip()
                        for k, v in keys.items()
                        if k in ("openai", "gemini", "groq", "openrouter") and str(v).strip()
                    }
                self.llm.update_credentials(
                    preferred_provider=creds.get("preferred_provider"),
                    openai_key=self._saved_api_keys.get("openai", ""),
                    gemini_key=self._saved_api_keys.get("gemini", ""),
                    groq_key=self._saved_api_keys.get("groq", ""),
                    openrouter_key=self._saved_api_keys.get("openrouter", ""),
                    openai_model=models.get("openai") if isinstance(models, dict) else None,
                    gemini_model=models.get("gemini") if isinstance(models, dict) else None,
                    groq_model=models.get("groq") if isinstance(models, dict) else None,
                    openrouter_model=models.get("openrouter") if isinstance(models, dict) else None,
                )
        except Exception as exc:
            logger.warning("Could not load persisted settings (%s); using defaults.", exc)

    def save_user_settings(
        self,
        *,
        preferences: Optional[dict[str, Any]] = None,
        preferred_provider: Optional[str] = None,
        api_keys: Optional[dict[str, Optional[str]]] = None,
        models: Optional[dict[str, Optional[str]]] = None,
    ) -> dict[str, Any]:
        """Thread-safely apply and persist user preferences & API keys to data/user_settings.json."""
        with self._rebuild_lock:
            if isinstance(preferences, dict):
                merged = dict(self.user_preferences)
                for k, v in preferences.items():
                    if isinstance(k, str) and len(k) <= 64:
                        merged[k] = v
                self.user_preferences = merged

            if isinstance(api_keys, dict):
                for provider in ("openai", "gemini", "groq", "openrouter"):
                    if provider in api_keys:
                        raw_val = api_keys[provider]
                        if raw_val is None or str(raw_val).strip() == "":
                            self._saved_api_keys.pop(provider, None)
                        else:
                            self._saved_api_keys[provider] = str(raw_val).strip()

            model_updates = models if isinstance(models, dict) else {}
            self.llm.update_credentials(
                preferred_provider=preferred_provider,
                openai_key=self._saved_api_keys.get("openai", ""),
                gemini_key=self._saved_api_keys.get("gemini", ""),
                groq_key=self._saved_api_keys.get("groq", ""),
                openrouter_key=self._saved_api_keys.get("openrouter", ""),
                openai_model=model_updates.get("openai"),
                gemini_model=model_updates.get("gemini"),
                groq_model=model_updates.get("groq"),
                openrouter_model=model_updates.get("openrouter"),
            )

            persisted = {
                "preferences": self.user_preferences,
                "credentials": {
                    "preferred_provider": self.llm.preferred_provider,
                    "api_keys": self._saved_api_keys,
                    "models": {
                        "openai": self.llm.openai_model,
                        "gemini": self.llm.gemini_model,
                        "groq": self.llm.groq_model,
                        "openrouter": self.llm.openrouter_model,
                    },
                },
            }
            os.makedirs(os.path.dirname(USER_SETTINGS_FILE), exist_ok=True)
            tmp_path = f"{USER_SETTINGS_FILE}.tmp"
            with open(tmp_path, "w", encoding="utf-8") as fh:
                json.dump(persisted, fh, indent=2)
            os.replace(tmp_path, USER_SETTINGS_FILE)
            try:
                os.chmod(USER_SETTINGS_FILE, 0o600)
            except OSError:
                pass
            return self.get_public_settings()

    def reset_user_settings(self) -> dict[str, Any]:
        with self._rebuild_lock:
            self.user_preferences = {}
            self._saved_api_keys = {}
            self.llm.update_credentials(
                preferred_provider="auto",
                openai_key="",
                gemini_key="",
                groq_key="",
                openrouter_key="",
            )
            if os.path.exists(USER_SETTINGS_FILE):
                try:
                    os.remove(USER_SETTINGS_FILE)
                except OSError:
                    pass
            return self.get_public_settings()

    def get_public_settings(self) -> dict[str, Any]:
        """Returns public preferences + masked provider key status (never leaks raw secrets)."""
        return {
            "preferences": dict(self.user_preferences),
            "ai": self.llm.get_provider_status(),
        }

    def apply_live_documents(self, live_docs: list[dict[str, Any]]) -> dict[str, Any]:
        """Atomically merge updated live NASA website docs into RAG VectorStore & citation index."""
        with self._rebuild_lock:
            combined_docs = list(self._base_documents) + list(live_docs)
            chunks = load_and_chunk_data(
                documents=combined_docs,
                test_runs=self.all_data.get("test_runs"),
            )
            digest = compute_corpus_digest(chunks)
            self.vectorstore.build_index(chunks, digest=digest)

            self.all_data["documents"] = combined_docs
            self.docs_by_id = {str(d["doc_id"]).upper(): d for d in combined_docs}
            self.rag.refresh_valid_citations(self.all_data)

            return {
                "corpus_digest": digest,
                "document_count": len(combined_docs),
                "live_document_count": len(live_docs),
                "chunk_count": len(chunks),
            }


engine = EngineState()


# ── Pydantic Schemas ──────────────────────────────────────────────────────────
class CabinConfigIn(BaseModel):
    oxygen_pct: float = Field(21.0, ge=0.0, allow_inf_nan=False)
    pressure_kpa: float = Field(101.3, ge=0.0, allow_inf_nan=False)
    flow_velocity_cm_s: float = Field(10.0, ge=0.0, allow_inf_nan=False)
    gravity_g: float = Field(0.0, ge=0.0, allow_inf_nan=False)
    fuel_material: str = Field("Cotton-Fiberglass", min_length=1, max_length=120)
    diluent_gas: str = Field("N2", min_length=1, max_length=16)


class RankWeightsIn(BaseModel):
    similarity: float = Field(0.5, ge=0.0, allow_inf_nan=False)
    completeness: float = Field(0.2, ge=0.0, allow_inf_nan=False)
    criticality: float = Field(0.3, ge=0.0, allow_inf_nan=False)


class RankRunsRequest(BaseModel):
    config: CabinConfigIn = Field(default_factory=CabinConfigIn)
    weights: RankWeightsIn = Field(default_factory=RankWeightsIn)
    limit: int = Field(50, ge=1, le=100)


class ScoreRequest(BaseModel):
    material: str
    environment: str
    oxygen_level: str
    flow_velocity_cm_s: Optional[float] = None
    pressure_kpa: Optional[float] = None
    diluent_gas: str = "N2"


class ChatRequest(BaseModel):
    message: str = Field(..., min_length=1, max_length=MAX_CHAT_MESSAGE_CHARS)
    scenario: Optional[CabinConfigIn] = None


class LiveSyncRequest(BaseModel):
    force: bool = False
    doc_id: Optional[str] = Field(default=None, max_length=32)


class AddLiveSourceRequest(BaseModel):
    url: str = Field(..., min_length=10, max_length=600)
    title: Optional[str] = Field(default=None, max_length=180)
    investigation: Optional[str] = Field(default=None, max_length=120)
    kind: str = Field(default="html", pattern="^(html|ntrs_api)$")
    sync_now: bool = True


# ── Health, Stats & Overview ──────────────────────────────────────────────────
@app.get("/api/health")
def health() -> dict[str, Any]:
    kg_stats = engine.kg.get_graph_data()["stats"]
    return {
        "status": "healthy",
        "title": APP_TITLE,
        "version": APP_VERSION,
        "provider": engine.llm.active_provider,
        "ai_engine": engine.llm.display_label,
        "ai_configured": engine.llm.is_configured,
        "counts": {
            "experiments": len(engine.all_data.get("experiments", [])),
            "test_runs": len(engine.all_data.get("test_runs", [])),
            "materials": len(engine.all_data.get("materials", [])),
            "findings": len(engine.all_data.get("findings", [])),
            "guidelines": len(engine.all_data.get("guidelines", [])),
            "documents": len(engine.all_data.get("documents", [])),
            "presets": len(engine.all_data.get("presets", [])),
        },
        "graph": kg_stats,
        "vectorstore": engine.vectorstore.get_collection_stats(),
        "live_nasa_sync": {
            "enabled": engine.live_sync.enabled,
            "syncing": engine.live_sync.get_status()["syncing"],
            "interval_seconds": engine.live_sync.interval_seconds,
            "last_run_at": engine.live_sync.get_status()["last_run_at"],
            "last_update_at": engine.live_sync.get_status()["last_update_at"],
            "live_documents_active": engine.live_sync.get_status()["live_documents_active"],
            "total_watched_sources": engine.live_sync.get_status()["total_watched_sources"],
        },
    }


@app.get("/api/stats")
def get_stats() -> dict[str, Any]:
    exp_list = engine.all_data.get("experiments", [])
    mat_list = engine.all_data.get("materials", [])
    find_list = engine.all_data.get("findings", [])
    guide_list = engine.all_data.get("guidelines", [])
    runs_list = engine.all_data.get("test_runs", [])
    docs_list = engine.all_data.get("documents", [])

    categories: dict[str, int] = {}
    for e in exp_list:
        cat = str(e.get("category", "General"))
        categories[cat] = categories.get(cat, 0) + 1

    mat_types: dict[str, int] = {}
    for m in mat_list:
        cat = str(m.get("category", "Other"))
        mat_types[cat] = mat_types.get(cat, 0) + 1

    run_programs: dict[str, int] = {}
    run_regimes: dict[str, int] = {}
    for r in runs_list:
        p = str(r.get("program", "Other"))
        run_programs[p] = run_programs.get(p, 0) + 1
        reg = str(r.get("combustion_regime", "Unknown"))
        run_regimes[reg] = run_regimes.get(reg, 0) + 1

    kg_stats = engine.kg.get_graph_data()["stats"]

    return {
        "total_experiments": len(exp_list),
        "total_test_runs": len(runs_list),
        "materials_tested": len(mat_list),
        "key_findings": len(find_list),
        "safety_guidelines": len(guide_list),
        "nasa_documents": len(docs_list),
        "graph_nodes": kg_stats["node_count"],
        "graph_edges": kg_stats["edge_count"],
        "categories": categories,
        "material_types": mat_types,
        "run_programs": run_programs,
        "run_regimes": run_regimes,
        "ai_configured": engine.llm.is_configured,
        "ai_engine": engine.llm.display_label,
        "live_nasa_sources": engine.live_sync.get_status()["total_watched_sources"],
        "live_nasa_active_docs": engine.live_sync.get_status()["live_documents_active"],
        "last_nasa_sync_at": engine.live_sync.get_status()["last_run_at"],
    }


@app.get("/api/filters")
def get_filters() -> dict[str, Any]:
    exps = engine.all_data.get("experiments", [])
    runs = engine.all_data.get("test_runs", [])
    return {
        "experiment_categories": sorted({str(e.get("category")) for e in exps if e.get("category")}),
        "experiment_platforms": sorted({str(e.get("platform")) for e in exps if e.get("platform")}),
        "run_programs": sorted({str(r.get("program")) for r in runs if r.get("program")}),
        "run_materials": sorted({str(r.get("fuel_material")) for r in runs if r.get("fuel_material")}),
        "run_regimes": sorted({str(r.get("combustion_regime")) for r in runs if r.get("combustion_regime")}),
    }


@app.get("/api/summary")
def get_mission_summary() -> dict[str, Any]:
    """AI Mission Brief synthesized from ranked NASA experiments, materials, and guidelines."""
    ranked_exps = rank_experiments_explainable(engine.all_data.get("experiments", []))
    ranked_mats = rank_materials_explainable(engine.all_data.get("materials", []), environment="Lunar 34% O2")
    ranked_guides = rank_guidelines_explainable(engine.all_data.get("guidelines", []))
    artemis_eval = evaluate_cabin(CabinParams(34.0, 56.5, 5.0, 0.16, "PMMA", "N2"))

    top_exp = ranked_exps[0] if ranked_exps else {}
    top_risk_mat = ranked_mats[0] if ranked_mats else {}
    top_guide = ranked_guides[0] if ranked_guides else {}

    return {
        "headline": (
            "Microgravity eliminates buoyant convection — turning cabin HVAC fans into the primary driver of flame "
            "survival (BASS-II ventilation paradox), while Artemis 34% O₂ / 56.5 kPa exploration atmospheres narrow "
            "flammability margins across common polymers."
        ),
        "top_ranked_experiment": {
            "name": top_exp.get("name", "BASS"),
            "acronym": top_exp.get("acronym", "BASS"),
            "score": top_exp.get("score", 95.0),
            "reason": (top_exp.get("reasons") or [""])[0],
            "source_url": "https://psi.nasa.gov/investigation/BASS",
        },
        "highest_risk_material_34_o2": {
            "name": top_risk_mat.get("name", "Polyethylene"),
            "risk_score": top_risk_mat.get("risk_score", 92.0),
            "risk_tier": top_risk_mat.get("risk_tier", "CRITICAL"),
            "pmma_artemis_risk_index": artemis_eval.risk_index,
            "pmma_artemis_loi": artemis_eval.estimated_loi_pct,
            "recommendation": top_risk_mat.get("safety_recommendation", ""),
            "source_url": "https://standards.nasa.gov/standard/nasa/nasa-std-6001",
        },
        "priority_safety_directive": {
            "title": top_guide.get("title", "Cabin Ventilation Shutdown Protocol"),
            "environment": top_guide.get("environment", "ISS / Transit"),
            "recommendation": top_guide.get("recommendation", ""),
            "rationale": top_guide.get("rationale", ""),
        },
        "recommended_actions": [
            "Shut down inter-module ventilation (IMV) fans immediately upon optical smoke or CO alarm to collapse oxidizer transport [DOC-01 p.3].",
            "Re-qualify all non-metallic cabin materials under NASA-STD-6001B at 34% O₂ / 56.5 kPa prior to Artemis lunar surface operations [DOC-02 p.1].",
            "Deploy dual-wavelength photoelectric smoke detectors in HVAC return ducts to capture >300 nm microgravity soot chains [DOC-06 p.2].",
            "Enforce 45-minute IR thermal quarantine post-extinction to catch invisible FLEX-2 cool flames (~650 K) before restoring airflow [DOC-03 p.2].",
        ],
    }


@app.get("/api/search")
def unified_search(q: str = Query(..., min_length=1, max_length=200)) -> dict[str, Any]:
    """Unified search across experiments, materials, findings, guidelines, test runs, and NASA papers."""
    needle = q.strip().lower()
    if not needle:
        return {"query": q, "count": 0, "results": []}
    results: list[dict[str, Any]] = []

    for e in engine.all_data.get("experiments", []):
        hay = f"{e.get('name', '')} {e.get('acronym', '')} {e.get('description', '')} {' '.join(e.get('materials_tested') or [])}".lower()
        if needle in hay:
            results.append(
                {
                    "type": "experiment",
                    "id": e.get("id"),
                    "title": e.get("name"),
                    "badge": e.get("category"),
                    "snippet": str(e.get("description") or "")[:180],
                    "tab": "explorer",
                }
            )

    for m in engine.all_data.get("materials", []):
        hay = f"{m.get('name', '')} {m.get('category', '')} {m.get('microgravity_behavior', '')} {m.get('safety_recommendation', '')}".lower()
        if needle in hay:
            results.append(
                {
                    "type": "material",
                    "id": m.get("name"),
                    "title": m.get("name"),
                    "badge": f"Flammability {m.get('flammability_rating')}/10",
                    "snippet": str(m.get("safety_recommendation") or m.get("microgravity_behavior") or "")[:180],
                    "tab": "cabin",
                }
            )

    for f in engine.all_data.get("findings", []):
        hay = f"{f.get('title', '')} {f.get('description', '')} {f.get('source_experiment', '')} {f.get('implications_for_spacecraft', '')}".lower()
        if needle in hay:
            results.append(
                {
                    "type": "finding",
                    "id": f.get("id"),
                    "title": f.get("title"),
                    "badge": f.get("source_experiment"),
                    "snippet": str(f.get("quantitative_result") or f.get("description") or "")[:180],
                    "tab": "dashboard",
                }
            )

    for g in engine.all_data.get("guidelines", []):
        hay = f"{g.get('title', '')} {g.get('recommendation', '')} {g.get('rationale', '')} {g.get('environment', '')}".lower()
        if needle in hay:
            results.append(
                {
                    "type": "guideline",
                    "id": g.get("id"),
                    "title": g.get("title"),
                    "badge": g.get("risk_level"),
                    "snippet": str(g.get("recommendation") or "")[:180],
                    "tab": "ranking",
                }
            )

    for d in engine.all_data.get("documents", []):
        pages_text = " ".join(p.get("text", "") for p in d.get("pages") or [])
        hay = f"{d.get('doc_id', '')} {d.get('title', '')} {d.get('investigation', '')} {pages_text}".lower()
        if needle in hay:
            results.append(
                {
                    "type": "paper",
                    "id": d.get("doc_id"),
                    "title": d.get("title"),
                    "badge": d.get("doc_id"),
                    "snippet": str((d.get("pages") or [{}])[0].get("section") or d.get("title"))[:180],
                    "tab": "resources",
                }
            )

    for r in engine.all_data.get("test_runs", []):
        hay = f"{r.get('experiment_id', '')} {r.get('program', '')} {r.get('fuel_material', '')} {r.get('combustion_regime', '')}".lower()
        if needle in hay:
            results.append(
                {
                    "type": "test_run",
                    "id": r.get("experiment_id"),
                    "title": f"{r.get('experiment_id')} — {r.get('program')} ({r.get('fuel_material')})",
                    "badge": r.get("combustion_regime"),
                    "snippet": f"{r.get('oxygen_pct')}% O₂, {r.get('pressure_kpa')} kPa, {r.get('flow_velocity_cm_s')} cm/s, {r.get('gravity_g')} g",
                    "tab": "ranking",
                }
            )

    return {"query": q, "count": len(results), "results": results[:40]}


def _require_valid_material(material: str) -> str:
    resolved = validate_material(material)
    if resolved is None:
        allowed = ", ".join(sorted(ALLOWED_CANONICAL_MATERIALS))
        raise HTTPException(
            status_code=422,
            detail=f"Unknown material '{material}'. Allowed materials: {allowed}",
        )
    return resolved


def _require_valid_diluent(diluent: str) -> str:
    resolved = validate_diluent(diluent)
    if resolved is None:
        allowed = ", ".join(sorted(ALLOWED_DILUENTS))
        raise HTTPException(
            status_code=422,
            detail=f"Unknown diluent '{diluent}'. Allowed diluents: {allowed}",
        )
    return resolved


# ── Presets, Cabin Evaluator & Physics (EMBER + Flame in Freefall) ────────────
@app.get("/api/presets")
def get_presets() -> dict[str, Any]:
    return {"presets": engine.all_data.get("presets", [])}


@app.post("/api/evaluate-cabin")
def api_evaluate_cabin(cfg: CabinConfigIn) -> dict[str, Any]:
    canon_mat = _require_valid_material(cfg.fuel_material)
    canon_dil = _require_valid_diluent(cfg.diluent_gas)
    cp = CabinParams(
        oxygen_pct=cfg.oxygen_pct,
        pressure_kpa=cfg.pressure_kpa,
        flow_velocity_cm_s=cfg.flow_velocity_cm_s,
        gravity_g=cfg.gravity_g,
        fuel_material=canon_mat,
        diluent_gas=canon_dil,
    )
    res = evaluate_cabin(cp)
    guidance = build_engineering_guidance(cp, res)
    return {
        "config": cp.to_dict(),
        **res.to_dict(),
        "risk_color": color_for_risk(res.risk_band),
        "factors": guidance["factors"],
        "recommendations": guidance["recommendations"],
        "recommendation_items": guidance["recommendation_items"],
        "ranked_table": habitat_materials_matrix(),
    }


@app.get("/api/physics/ventilation-curve")
def get_ventilation_curve() -> dict[str, Any]:
    return ventilation_curve()


@app.get("/api/physics/phase-grid")
def get_phase_grid(
    material: str = Query("PMMA"),
    gravity_g: float = Query(0.0, ge=0.0, le=3.0),
    flow_cm_s: float = Query(10.0, ge=0.0, le=80.0),
    diluent: str = Query("N2"),
) -> dict[str, Any]:
    canon_mat = _require_valid_material(material)
    canon_dil = _require_valid_diluent(diluent)
    return {
        "material": canon_mat,
        "gravity_g": gravity_g,
        "flow_cm_s": flow_cm_s,
        "diluent": canon_dil,
        "cells": phase_grid(canon_mat, gravity_g=gravity_g, flow_cm_s=flow_cm_s, diluent=canon_dil),
    }


@app.post("/api/score")
def calculate_score(req: ScoreRequest) -> dict[str, Any]:
    """Backward-compatible Habitat Fire Safety Scorer backed by exact combustion physics & Shapley."""
    canon_mat = _require_valid_material(req.material)
    canon_dil = _require_valid_diluent(req.diluent_gas)

    env_l = req.environment.lower()
    if "lunar" in env_l:
        g, default_p, default_f = 0.16, 56.5, 5.0
    elif "martian" in env_l or "mars" in env_l:
        g, default_p, default_f = 0.38, 70.3, 5.0
    elif "transit" in env_l or "deep" in env_l:
        g, default_p, default_f = 0.0, 56.5, 10.0
    else:
        g, default_p, default_f = 0.0, 101.3, 10.0

    # Parse numeric oxygen percentage from strings like "34% (Exploration)"
    import re
    m = re.search(r"(\d+(?:\.\d+)?)", req.oxygen_level)
    o2 = float(m.group(1)) if m else 21.0
    pressure = req.pressure_kpa if req.pressure_kpa is not None else (56.5 if o2 >= 30 else default_p)
    flow = req.flow_velocity_cm_s if req.flow_velocity_cm_s is not None else default_f

    cp = CabinParams(
        oxygen_pct=o2,
        pressure_kpa=pressure,
        flow_velocity_cm_s=flow,
        gravity_g=g,
        fuel_material=canon_mat,
        diluent_gas=canon_dil,
    )
    res = evaluate_cabin(cp)
    guidance = build_engineering_guidance(cp, res)

    return {
        "material": req.material,
        "canonical_material": cp.fuel_material,
        "environment": req.environment,
        "oxygen_level": req.oxygen_level,
        "score": res.safety_score,
        "risk_index": res.risk_index,
        "risk_level": res.risk_band,
        "risk_color": color_for_risk(res.risk_band),
        "estimated_loi_pct": res.estimated_loi_pct,
        "oxygen_margin_pct": res.oxygen_margin_pct,
        "predicted_regime": res.predicted_regime,
        "contributions": [c.to_dict() for c in res.contributions],
        "factors": guidance["factors"],
        "recommendations": guidance["recommendations"],
        "ranked_table": habitat_materials_matrix(),
    }


# ── 50-Run Scenario Ranker & Telemetry (EMBER Extra) ──────────────────────────
@app.get("/api/runs")
def list_runs(
    program: Optional[str] = Query(None),
    material: Optional[str] = Query(None),
    regime: Optional[str] = Query(None),
) -> dict[str, Any]:
    runs = engine.all_data.get("test_runs", [])
    if program and program != "all":
        runs = [r for r in runs if str(r.get("program", "")).lower() == program.lower()]
    if material and material != "all":
        runs = [r for r in runs if str(r.get("fuel_material", "")).lower() == material.lower()]
    if regime and regime != "all":
        runs = [r for r in runs if str(r.get("combustion_regime", "")).lower() == regime.lower()]
    return {"count": len(runs), "runs": runs}


@app.post("/api/runs/rank")
def api_rank_runs(req: RankRunsRequest) -> dict[str, Any]:
    weights = {
        "similarity": req.weights.similarity,
        "completeness": req.weights.completeness,
        "criticality": req.weights.criticality,
    }
    if sum(weights.values()) <= 0:
        weights = dict(DEFAULT_WEIGHTS)
    ranked = rank_runs(
        engine.all_data.get("test_runs", []),
        req.config.model_dump(),
        weights=weights,
        limit=req.limit,
    )
    tel_map = engine.all_data.get("telemetry", {})
    results = []
    for item in ranked:
        d = item.to_dict()
        d["has_telemetry"] = bool(tel_map.get(item.experiment_id, {}).get("time_s"))
        results.append(d)
    return {
        "config": req.config.model_dump(),
        "weights": weights,
        "count": len(results),
        "results": results,
    }


@app.get("/api/telemetry/{experiment_id}")
def get_run_telemetry(experiment_id: str) -> dict[str, Any]:
    eid = experiment_id.strip().upper()
    tel = engine.all_data.get("telemetry", {}).get(eid)
    if not tel:
        raise HTTPException(status_code=404, detail=f"Telemetry not found for {eid}")
    return {"experiment_id": eid, "run": engine.runs_by_id.get(eid), **tel}


# ── Explainable Entity Rankings (Flame in Freefall Summary) ───────────────────
@app.get("/api/rank/experiments")
def api_rank_experiments(focus: str = Query("safety")) -> dict[str, Any]:
    ranked = rank_experiments_explainable(engine.all_data.get("experiments", []), focus=focus)
    return {"focus": focus, "rule": "Weighted score: Safety Implications + Empirical Findings + Material Breadth + Platform + Recency", "results": ranked}


@app.get("/api/rank/materials")
def api_rank_materials(environment: str = Query("Lunar 34% O2")) -> dict[str, Any]:
    ranked = rank_materials_explainable(engine.all_data.get("materials", []), environment=environment)
    return {"environment": environment, "rule": "Composite fire hazard: Flammability + Toxicity + LOI Vulnerability + Smoke × Environment Multiplier", "results": ranked}


@app.get("/api/rank/findings")
def api_rank_findings() -> dict[str, Any]:
    ranked = rank_findings_explainable(engine.all_data.get("findings", []))
    return {"rule": "Safety Relevance Tier + Quantitative Metric Density + Actionable Spacecraft Implications", "results": ranked}


@app.get("/api/rank/guidelines")
def api_rank_guidelines(environment: Optional[str] = Query(None)) -> dict[str, Any]:
    ranked = rank_guidelines_explainable(engine.all_data.get("guidelines", []), environment=environment)
    return {"environment": environment or "All Environments", "rule": "Priority Tier + Risk Severity + NASA Experimental Backing + Environment Fit", "results": ranked}


# ── Flagship Experiments, Materials, Findings, Guidelines & Compare ───────────
@app.get("/api/experiments")
def list_experiments(
    query: Optional[str] = Query(None),
    category: Optional[str] = Query(None),
    platform: Optional[str] = Query(None),
) -> dict[str, Any]:
    exps = engine.all_data.get("experiments", [])
    if query:
        q = query.lower()
        exps = [
            e
            for e in exps
            if q in str(e.get("name", "")).lower()
            or q in str(e.get("description", "")).lower()
            or any(q in str(m).lower() for m in e.get("materials_tested", []))
            or any(q in str(f).lower() for f in e.get("key_findings", []))
        ]
    if category and category != "All Categories":
        exps = [e for e in exps if e.get("category") == category]
    if platform and platform != "All Platforms":
        exps = [e for e in exps if e.get("platform") == platform]
    return {"experiments": exps}


@app.get("/api/experiments/{exp_id}")
def get_experiment_detail(exp_id: str) -> dict[str, Any]:
    exp = get_experiment_by_id(exp_id, engine.all_data.get("experiments", []))
    if not exp:
        raise HTTPException(status_code=404, detail=f"Experiment '{exp_id}' not found")
    node_name = exp.get("acronym") or exp.get("name")
    kg_links = engine.kg.get_node_connections(str(node_name))
    return {"experiment": exp, "graph_links": kg_links}


@app.get("/api/materials")
def list_materials() -> dict[str, Any]:
    return {"materials": engine.all_data.get("materials", [])}


@app.get("/api/materials/{name}")
def get_material_detail(name: str) -> dict[str, Any]:
    mat = get_material_by_name(name, engine.all_data.get("materials", []))
    if not mat:
        raise HTTPException(status_code=404, detail=f"Material '{name}' not found")
    canon = canonical_material(str(mat.get("name", name)))
    kg_links = engine.kg.get_node_connections(canon)
    return {"material": mat, "canonical_name": canon, "graph_links": kg_links}


@app.get("/api/findings")
def list_findings() -> dict[str, Any]:
    return {"findings": engine.all_data.get("findings", [])}


@app.get("/api/findings/{finding_id}")
def get_finding_detail(finding_id: str) -> dict[str, Any]:
    findings = engine.all_data.get("findings", [])
    target = next((f for f in findings if str(f.get("id", "")).lower() == finding_id.lower()), None)
    if not target:
        raise HTTPException(status_code=404, detail=f"Finding '{finding_id}' not found")
    return {"finding": target, "similar": find_similar_findings(target, findings)}


@app.get("/api/guidelines")
def list_guidelines() -> dict[str, Any]:
    return {"guidelines": engine.all_data.get("guidelines", [])}


@app.get("/api/guidelines/{guideline_id}")
def get_guideline_detail(guideline_id: str) -> dict[str, Any]:
    guides = engine.all_data.get("guidelines", [])
    target = next((g for g in guides if str(g.get("id", "")).lower() == guideline_id.lower()), None)
    if not target:
        raise HTTPException(status_code=404, detail=f"Guideline '{guideline_id}' not found")
    return {"guideline": target}


@app.get("/api/compare")
def compare_experiments(e1: str = Query("SAFFIRE-I"), e2: str = Query("BASS-II")) -> dict[str, Any]:
    exp_metrics = {
        "SAFFIRE": {"flame_spread": 7.4, "extinction_time": 6.8, "soot_yield": 5.8, "heat_release": 8.4, "safety_score": 7.2},
        "BASS-II": {"flame_spread": 6.2, "extinction_time": 7.5, "soot_yield": 4.8, "heat_release": 7.6, "safety_score": 6.8},
        "BASS": {"flame_spread": 5.8, "extinction_time": 7.2, "soot_yield": 4.5, "heat_release": 7.4, "safety_score": 6.5},
        "SoFIE": {"flame_spread": 4.2, "extinction_time": 8.6, "soot_yield": 3.0, "heat_release": 5.2, "safety_score": 8.9},
        "FLEX-2": {"flame_spread": 2.4, "extinction_time": 9.1, "soot_yield": 6.0, "heat_release": 8.5, "safety_score": 4.8},
        "FLEX": {"flame_spread": 2.1, "extinction_time": 4.5, "soot_yield": 6.2, "heat_release": 8.9, "safety_score": 4.5},
        "ACME": {"flame_spread": 4.5, "extinction_time": 7.0, "soot_yield": 3.5, "heat_release": 5.6, "safety_score": 7.9},
        "SPICE": {"flame_spread": 3.8, "extinction_time": 6.0, "soot_yield": 9.2, "heat_release": 5.0, "safety_score": 6.0},
    }

    def get_metrics(name: str) -> dict[str, float]:
        for key, val in exp_metrics.items():
            if key.lower() in name.lower():
                return val
        return {"flame_spread": 5.0, "extinction_time": 6.0, "soot_yield": 5.0, "heat_release": 6.0, "safety_score": 7.0}

    exps = engine.all_data.get("experiments", [])
    exp1 = get_experiment_by_id(e1, exps)
    if not exp1:
        raise HTTPException(status_code=404, detail=f"Experiment '{e1}' not found")
    exp2 = get_experiment_by_id(e2, exps)
    if not exp2:
        raise HTTPException(status_code=404, detail=f"Experiment '{e2}' not found")
    m1 = get_metrics(str(exp1.get("acronym") or exp1.get("name") or e1))
    m2 = get_metrics(str(exp2.get("acronym") or exp2.get("name") or e2))
    deltas = {k: round(m1[k] - m2[k], 2) for k in m1}

    return {
        "exp1": {"name": exp1.get("name", e1), "acronym": exp1.get("acronym", e1), "metrics": m1, "details": exp1},
        "exp2": {"name": exp2.get("name", e2), "acronym": exp2.get("acronym", e2), "metrics": m2, "details": exp2},
        "deltas": deltas,
    }


# ── NASA Research Library & Document Reader (EMBER Extra) ─────────────────────
@app.get("/api/documents")
def list_documents() -> dict[str, Any]:
    docs = engine.all_data.get("documents", [])
    return {"count": len(docs), "documents": docs}


@app.get("/api/documents/{doc_id}")
def get_document(doc_id: str) -> dict[str, Any]:
    doc = engine.docs_by_id.get(doc_id.strip().upper())
    if not doc:
        raise HTTPException(status_code=404, detail=f"Document '{doc_id}' not found")
    return doc


# ── Knowledge Graph ───────────────────────────────────────────────────────────
@app.get("/api/graph")
def get_graph() -> dict[str, Any]:
    return engine.kg.get_graph_data()


@app.get("/api/graph/node/{node_id:path}")
def get_graph_node(node_id: str) -> dict[str, Any]:
    return engine.kg.get_node_connections(node_id)


# ── Live NASA Website Sync -> Auto-Updating RAG Pipeline ──────────────────────
@app.get("/api/sync/status")
def get_live_sync_status() -> dict[str, Any]:
    st = engine.live_sync.get_status()
    vs = engine.vectorstore.get_collection_stats()
    return {
        **st,
        "corpus_digest": vs.get("corpus_digest"),
        "total_chunks": vs.get("document_count", 0),
        "total_documents": len(engine.all_data.get("documents", [])),
    }


@app.post("/api/sync/nasa")
async def trigger_live_nasa_sync(req: Optional[LiveSyncRequest] = None) -> dict[str, Any]:
    body = req or LiveSyncRequest()
    before_vs = engine.vectorstore.get_collection_stats()
    try:
        report = await asyncio.to_thread(
            engine.live_sync.sync_all, force=body.force, doc_id=body.doc_id
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    after_vs = engine.vectorstore.get_collection_stats()
    return {
        **report,
        "corpus_digest_before": before_vs.get("corpus_digest"),
        "corpus_digest_after": after_vs.get("corpus_digest"),
        "total_chunks": after_vs.get("document_count", 0),
        "total_documents": len(engine.all_data.get("documents", [])),
    }


@app.post("/api/sync/sources")
async def add_live_nasa_source(req: AddLiveSourceRequest) -> dict[str, Any]:
    try:
        src = engine.live_sync.add_source(
            req.url,
            title=req.title,
            investigation=req.investigation,
            kind=req.kind,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    sync_report = None
    if req.sync_now:
        sync_report = await asyncio.to_thread(
            engine.live_sync.sync_all, force=True, doc_id=src["doc_id"]
        )
    vs = engine.vectorstore.get_collection_stats()
    return {
        "source": src,
        "sync": sync_report,
        "corpus_digest": vs.get("corpus_digest"),
        "total_chunks": vs.get("document_count", 0),
        "status": engine.live_sync.get_status(),
    }


@app.delete("/api/sync/sources/{doc_id}")
def delete_live_nasa_source(doc_id: str) -> dict[str, Any]:
    try:
        removed = engine.live_sync.remove_source(doc_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not removed:
        raise HTTPException(status_code=404, detail=f"Live NASA source '{doc_id}' not found")
    vs = engine.vectorstore.get_collection_stats()
    return {
        "deleted": doc_id.upper(),
        "corpus_digest": vs.get("corpus_digest"),
        "total_chunks": vs.get("document_count", 0),
        "status": engine.live_sync.get_status(),
    }


# ── FlameAI Chat (Sync + SSE Stream + Per-Session Memory) ─────────────────────
@app.post("/api/chat")
def chat(
    req: ChatRequest,
    x_session_id: Optional[str] = Header(default=None, alias="X-Session-Id"),
) -> dict[str, Any]:
    if not req.message.strip():
        raise HTTPException(status_code=400, detail="Empty message")
    engine.live_sync.maybe_trigger_background_sync()
    scenario = req.scenario.model_dump() if req.scenario else None
    mem = engine.session_memories.get(x_session_id)
    result = engine.rag.query(
        req.message.strip(), top_k=TOP_K_RESULTS, scenario=scenario, memory_override=mem
    )
    result["answer"] = clean_markdown_text(str(result.get("answer") or ""))
    result["history"] = mem.get_full_history()[-10:]
    return result


@app.post("/api/chat/stream")
def chat_stream(
    req: ChatRequest,
    x_session_id: Optional[str] = Header(default=None, alias="X-Session-Id"),
) -> StreamingResponse:
    if not req.message.strip():
        raise HTTPException(status_code=400, detail="Empty message")
    engine.live_sync.maybe_trigger_background_sync()
    scenario = req.scenario.model_dump() if req.scenario else None
    mem = engine.session_memories.get(x_session_id)

    def event_generator():
        for evt in engine.rag.stream_query(
            req.message.strip(), top_k=TOP_K_RESULTS, scenario=scenario, memory_override=mem
        ):
            event_name = evt["event"]
            payload = json.dumps(evt["data"], ensure_ascii=False)
            yield f"event: {event_name}\ndata: {payload}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


class ChatSuggestionsRequest(BaseModel):
    messages: list[dict[str, str]] = Field(default_factory=list)
    notebook_title: str = ""
    scenario: Optional[CabinParams] = None


@app.post("/api/chat/suggestions")
def chat_suggestions(req: ChatSuggestionsRequest) -> dict[str, Any]:
    if not engine.llm.is_configured:
        return {"available": False, "queries": []}
    scenario_dict = req.scenario.model_dump() if req.scenario else None
    queries = engine.llm.generate_quick_queries(
        messages=req.messages,
        notebook_title=req.notebook_title,
        scenario=scenario_dict,
    )
    if not queries:
        return {"available": False, "queries": []}
    return {"available": True, "queries": queries}


@app.delete("/api/chat/memory")
def clear_memory(
    x_session_id: Optional[str] = Header(default=None, alias="X-Session-Id"),
) -> dict[str, str]:
    engine.session_memories.clear(x_session_id)
    return {"message": "Conversation memory cleared"}


class UserSettingsPayload(BaseModel):
    preferences: Optional[dict[str, Any]] = None
    preferred_provider: Optional[str] = None
    api_keys: Optional[dict[str, Optional[str]]] = None
    models: Optional[dict[str, Optional[str]]] = None


@app.get("/api/settings")
def get_user_settings() -> dict[str, Any]:
    return engine.get_public_settings()


@app.post("/api/settings")
def update_user_settings(req: UserSettingsPayload) -> dict[str, Any]:
    return engine.save_user_settings(
        preferences=req.preferences,
        preferred_provider=req.preferred_provider,
        api_keys=req.api_keys,
        models=req.models,
    )


class ModelDiscoveryPayload(BaseModel):
    provider: str = Field(..., min_length=2, max_length=32)
    api_key: Optional[str] = None


_OPENAI_NON_CHAT_PREFIXES = (
    "text-embedding",
    "embedding",
    "whisper",
    "tts-",
    "dall-e",
    "text-moderation",
    "omni-moderation",
    "babbage-",
    "davinci-",
    "gpt-image",
    "sora",
)


def _rank_openai_model(mid: str) -> tuple[int, str]:
    low = mid.lower()
    if low.startswith(("gpt-5", "gpt-4.1", "gpt-4o", "o4-", "o3-", "o1-")):
        return (0, low)
    if low.startswith(("gpt-4", "chatgpt-")):
        return (1, low)
    if low.startswith("gpt-3.5"):
        return (2, low)
    if any(low.startswith(p) for p in _OPENAI_NON_CHAT_PREFIXES):
        return (9, low)
    return (3, low)


def _rank_gemini_model(mid: str) -> tuple[int, str]:
    low = mid.lower()
    if low.startswith("gemini-2.5"):
        return (0, low)
    if low.startswith("gemini-2.0"):
        return (1, low)
    if low.startswith("gemini-1.5"):
        return (2, low)
    if low.startswith("gemini"):
        return (3, low)
    return (5, low)


def _rank_groq_model(mid: str) -> tuple[int, str]:
    low = mid.lower()
    if "whisper" in low or "tts" in low or "guard" in low:
        return (8, low)
    if low.startswith(("llama-3.3", "llama-4", "qwen", "deepseek")):
        return (0, low)
    if low.startswith(("llama-", "meta-llama/", "mixtral", "gemma", "compound")):
        return (1, low)
    return (2, low)


async def _fetch_provider_models_http(provider: str, api_key: str) -> list[dict[str, Any]]:
    """Queries the provider's official models endpoint using the supplied API key."""
    import httpx

    async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
        if provider == "openai":
            resp = await client.get(
                "https://api.openai.com/v1/models",
                headers={"Authorization": f"Bearer {api_key}"},
            )
            resp.raise_for_status()
            raw = resp.json().get("data") or []
            out = []
            seen = set()
            for item in raw:
                mid = str(item.get("id") or "").strip()
                if not mid or mid in seen:
                    continue
                seen.add(mid)
                low = mid.lower()
                is_non_chat = any(low.startswith(p) for p in _OPENAI_NON_CHAT_PREFIXES)
                out.append({
                    "id": mid,
                    "label": mid,
                    "owned_by": str(item.get("owned_by") or "openai"),
                    "category": "media/embed" if is_non_chat else "chat",
                })
            out.sort(key=lambda m: _rank_openai_model(m["id"]))
            return out

        if provider == "gemini":
            resp = await client.get(
                "https://generativelanguage.googleapis.com/v1beta/models",
                params={"key": api_key, "pageSize": 200},
            )
            resp.raise_for_status()
            raw = resp.json().get("models") or []
            out = []
            seen = set()
            for item in raw:
                methods = item.get("supportedGenerationMethods") or []
                if methods and "generateContent" not in methods:
                    continue
                full_name = str(item.get("name") or "").strip()
                mid = full_name.split("models/", 1)[-1] if "models/" in full_name else full_name
                if not mid or mid in seen:
                    continue
                seen.add(mid)
                display = str(item.get("displayName") or mid).strip()
                ctx = item.get("inputTokenLimit")
                out.append({
                    "id": mid,
                    "label": f"{display} ({mid})" if display.lower() != mid.lower() else mid,
                    "owned_by": "google",
                    "context_length": int(ctx) if isinstance(ctx, (int, float)) else None,
                    "category": "chat",
                })
            out.sort(key=lambda m: _rank_gemini_model(m["id"]))
            return out

        if provider == "groq":
            resp = await client.get(
                "https://api.groq.com/openai/v1/models",
                headers={"Authorization": f"Bearer {api_key}"},
            )
            resp.raise_for_status()
            raw = resp.json().get("data") or []
            out = []
            seen = set()
            for item in raw:
                if item.get("active") is False:
                    continue
                mid = str(item.get("id") or "").strip()
                if not mid or mid in seen:
                    continue
                seen.add(mid)
                ctx = item.get("context_window")
                low = mid.lower()
                cat = "audio/guard" if ("whisper" in low or "tts" in low or "guard" in low) else "chat"
                out.append({
                    "id": mid,
                    "label": mid,
                    "owned_by": str(item.get("owned_by") or "groq"),
                    "context_length": int(ctx) if isinstance(ctx, (int, float)) else None,
                    "category": cat,
                })
            out.sort(key=lambda m: _rank_groq_model(m["id"]))
            return out

        if provider == "openrouter":
            resp = await client.get(
                "https://openrouter.ai/api/v1/models",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "HTTP-Referer": "http://localhost:8000",
                    "X-Title": "Ignis",
                },
            )
            resp.raise_for_status()
            raw = resp.json().get("data") or []
            out = []
            seen = set()
            for item in raw:
                mid = str(item.get("id") or "").strip()
                if not mid or mid in seen:
                    continue
                seen.add(mid)
                name = str(item.get("name") or mid).strip()
                ctx = item.get("context_length")
                out.append({
                    "id": mid,
                    "label": f"{name} — {mid}" if name.lower() != mid.lower() else mid,
                    "owned_by": mid.split("/", 1)[0] if "/" in mid else "openrouter",
                    "context_length": int(ctx) if isinstance(ctx, (int, float)) else None,
                    "category": "chat",
                })
            out.sort(key=lambda m: (0 if ":free" in m["id"] else 1, m["id"].lower()))
            return out

    raise HTTPException(status_code=422, detail=f"Unsupported provider: {provider}")


@app.post("/api/settings/models")
async def discover_provider_models(req: ModelDiscoveryPayload) -> dict[str, Any]:
    """Extracts all available models directly from the selected provider API key."""
    provider = req.provider.strip().lower()
    if provider not in ("openai", "gemini", "groq", "openrouter"):
        raise HTTPException(
            status_code=422,
            detail="Provider must be one of: openai, gemini, groq, openrouter",
        )

    saved_keys = {
        "openai": engine.llm.openai_key,
        "gemini": engine.llm.gemini_key,
        "groq": engine.llm.groq_key,
        "openrouter": engine.llm.openrouter_key,
    }
    current_models = {
        "openai": engine.llm.openai_model,
        "gemini": engine.llm.gemini_model,
        "groq": engine.llm.groq_model,
        "openrouter": engine.llm.openrouter_model,
    }

    key = (req.api_key or "").strip() or (saved_keys.get(provider) or "").strip()
    if not key or key.startswith("your_"):
        raise HTTPException(
            status_code=400,
            detail=f"Enter or save a {provider.upper()} API key first to extract available models.",
        )

    try:
        models = await _fetch_provider_models_http(provider, key)
        return {
            "provider": provider,
            "count": len(models),
            "current_model": current_models.get(provider, ""),
            "models": models,
            "error": None,
        }
    except HTTPException:
        raise
    except Exception as exc:
        import httpx

        if isinstance(exc, httpx.HTTPStatusError):
            code = exc.response.status_code
            if code in (401, 403):
                raise HTTPException(
                    status_code=401,
                    detail=f"{provider.upper()} rejected this API key (HTTP {code}). Check that the key is valid.",
                )
            raise HTTPException(
                status_code=502,
                detail=f"{provider.upper()} model list request failed (HTTP {code}).",
            )
        raise HTTPException(
            status_code=502,
            detail=f"Could not reach {provider.upper()} models API ({type(exc).__name__}).",
        )


@app.post("/api/settings/reset")
def reset_user_settings() -> dict[str, Any]:
    return engine.reset_user_settings()


@app.post("/api/transcribe")
async def transcribe_audio(request: Request) -> dict[str, Any]:
    """Optional server-side Whisper transcription fallback when browser SpeechRecognition is unavailable."""
    audio_bytes = await request.body()
    if not audio_bytes:
        return {"transcript": "", "provider": "none", "error": "empty_audio"}
    if len(audio_bytes) > 8 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Audio recording exceeds 8 MB limit")

    content_type = (request.headers.get("content-type") or "audio/webm").split(";")[0].strip()
    ext = "webm"
    if "mp4" in content_type or "m4a" in content_type:
        ext = "m4a"
    elif "ogg" in content_type:
        ext = "ogg"
    elif "wav" in content_type:
        ext = "wav"

    groq_key = (engine.llm.groq_key or os.getenv("GROQ_API_KEY", "")).strip()
    openai_key = (engine.llm.openai_key or os.getenv("OPENAI_API_KEY", "")).strip()
    if groq_key.startswith("your_"):
        groq_key = ""
    if openai_key.startswith("your_"):
        openai_key = ""
    if not groq_key and not openai_key:
        return {"transcript": "", "provider": "none", "error": "no_server_stt_key"}

    endpoint = (
        "https://api.groq.com/openai/v1/audio/transcriptions"
        if groq_key
        else "https://api.openai.com/v1/audio/transcriptions"
    )
    api_key = groq_key or openai_key
    model = "whisper-large-v3-turbo" if groq_key else "whisper-1"
    provider_name = "groq_whisper" if groq_key else "openai_whisper"

    try:
        import httpx

        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.post(
                endpoint,
                headers={"Authorization": f"Bearer {api_key}"},
                data={"model": model, "language": "en"},
                files={"file": (f"dictation.{ext}", audio_bytes, content_type)},
            )
        if resp.status_code == 200:
            data = resp.json()
            return {"transcript": (data.get("text") or "").strip(), "provider": provider_name}
        return {"transcript": "", "provider": provider_name, "error": f"http_{resp.status_code}"}
    except Exception as exc:
        logger.warning("Server audio transcription failed: %s", exc)
        return {"transcript": "", "provider": provider_name, "error": str(exc)}


# ── Static Frontend & NASA PDF Papers ─────────────────────────────────────────
if os.path.isdir(FRONTEND_DIR):
    for sub in ("css", "js", "papers", "icons"):
        sub_dir = os.path.join(FRONTEND_DIR, sub)
        if os.path.isdir(sub_dir):
            app.mount(f"/{sub}", StaticFiles(directory=sub_dir), name=sub)

    @app.api_route("/", methods=["GET", "HEAD"])
    def serve_index():
        return FileResponse(os.path.join(FRONTEND_DIR, "index.html"))

    @app.get("/manifest.json")
    def serve_manifest():
        return FileResponse(os.path.join(FRONTEND_DIR, "manifest.json"))

    @app.api_route("/sw.js", methods=["GET", "HEAD"])
    def serve_sw():
        return FileResponse(os.path.join(FRONTEND_DIR, "sw.js"))

    @app.get("/favicon.ico")
    def serve_favicon():
        ico_path = os.path.join(FRONTEND_DIR, "favicon.ico")
        if os.path.exists(ico_path):
            return FileResponse(ico_path, media_type="image/x-icon")
        svg_path = os.path.join(FRONTEND_DIR, "icons", "icon.svg")
        if os.path.exists(svg_path):
            return FileResponse(svg_path, media_type="image/svg+xml")
        raise HTTPException(status_code=404, detail="Favicon not found")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=False)
