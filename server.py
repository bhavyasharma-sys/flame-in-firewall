"""
FastAPI Backend Server — Flame in Freefall v3.0
Unified NASA Space Apps 2026 Fire Safety Intelligence Platform combining:
  - Team Eagle20's Hybrid Graph-RAG, Knowledge Graph, Radar Compare & Explainable Rankings
  - EMBER's Combustion Physics, Exact Shapley Attribution, 3D WebGL2 Flame Twin APIs,
    50-Run Scenario Telemetry Ranker, NASA Research Library & Citation Audit.
"""

from __future__ import annotations

import json
import logging
import os
import sys
from typing import Any, Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
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
    TOP_K_RESULTS,
)
from core.ingestion import compute_corpus_digest, load_and_chunk_data
from core.knowledge_graph import KnowledgeGraph
from core.llm_client import LLMClient
from core.memory import ConversationMemory
from core.rag_pipeline import RAGPipeline
from core.vectorstore import VectorStore
from domain.combustion import canonical_material, phase_grid, ventilation_curve
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

app = FastAPI(title=APP_TITLE, version=APP_VERSION)

allow_all = "*" in CORS_ORIGINS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if allow_all else CORS_ORIGINS,
    allow_credentials=False if allow_all else True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Singleton Core Engine ─────────────────────────────────────────────────────
class EngineState:
    def __init__(self) -> None:
        self.all_data = load_all_data()
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
        self.memory = ConversationMemory()
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


engine = EngineState()


# ── Pydantic Schemas ──────────────────────────────────────────────────────────
class CabinConfigIn(BaseModel):
    oxygen_pct: float = Field(21.0, ge=10.0, le=100.0)
    pressure_kpa: float = Field(101.3, ge=15.0, le=150.0)
    flow_velocity_cm_s: float = Field(10.0, ge=0.0, le=80.0)
    gravity_g: float = Field(0.0, ge=0.0, le=3.0)
    fuel_material: str = Field("Cotton-Fiberglass", min_length=1, max_length=120)
    diluent_gas: str = Field("N2", min_length=1, max_length=16)


class RankWeightsIn(BaseModel):
    similarity: float = Field(0.5, ge=0.0, le=1.0)
    completeness: float = Field(0.2, ge=0.0, le=1.0)
    criticality: float = Field(0.3, ge=0.0, le=1.0)


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


# ── Presets, Cabin Evaluator & Physics (EMBER + Flame in Freefall) ────────────
@app.get("/api/presets")
def get_presets() -> dict[str, Any]:
    return {"presets": engine.all_data.get("presets", [])}


@app.post("/api/evaluate-cabin")
def api_evaluate_cabin(cfg: CabinConfigIn) -> dict[str, Any]:
    cp = CabinParams(
        oxygen_pct=cfg.oxygen_pct,
        pressure_kpa=cfg.pressure_kpa,
        flow_velocity_cm_s=cfg.flow_velocity_cm_s,
        gravity_g=cfg.gravity_g,
        fuel_material=canonical_material(cfg.fuel_material),
        diluent_gas=cfg.diluent_gas,
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
    return {
        "material": canonical_material(material),
        "gravity_g": gravity_g,
        "flow_cm_s": flow_cm_s,
        "diluent": diluent,
        "cells": phase_grid(material, gravity_g=gravity_g, flow_cm_s=flow_cm_s, diluent=diluent),
    }


@app.post("/api/score")
def calculate_score(req: ScoreRequest) -> dict[str, Any]:
    """Backward-compatible Habitat Fire Safety Scorer backed by exact combustion physics & Shapley."""
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
        fuel_material=canonical_material(req.material),
        diluent_gas=req.diluent_gas,
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
    exp1 = get_experiment_by_id(e1, exps) or {"name": e1, "acronym": e1, "category": "General"}
    exp2 = get_experiment_by_id(e2, exps) or {"name": e2, "acronym": e2, "category": "General"}
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


# ── FlameAI Chat (Sync + SSE Stream + Memory) ─────────────────────────────────
@app.post("/api/chat")
def chat(req: ChatRequest) -> dict[str, Any]:
    if not req.message.strip():
        raise HTTPException(status_code=400, detail="Empty message")
    scenario = req.scenario.model_dump() if req.scenario else None
    result = engine.rag.query(req.message.strip(), top_k=TOP_K_RESULTS, scenario=scenario)
    result["answer"] = clean_markdown_text(str(result.get("answer") or ""))
    result["history"] = engine.memory.get_full_history()[-10:]
    return result


@app.post("/api/chat/stream")
def chat_stream(req: ChatRequest) -> StreamingResponse:
    if not req.message.strip():
        raise HTTPException(status_code=400, detail="Empty message")
    scenario = req.scenario.model_dump() if req.scenario else None

    def event_generator():
        for evt in engine.rag.stream_query(req.message.strip(), top_k=TOP_K_RESULTS, scenario=scenario):
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


@app.delete("/api/chat/memory")
def clear_memory() -> dict[str, str]:
    engine.memory.clear()
    return {"message": "Conversation memory cleared"}


# ── Static Frontend & NASA PDF Papers ─────────────────────────────────────────
if os.path.isdir(FRONTEND_DIR):
    for sub in ("css", "js", "papers"):
        sub_dir = os.path.join(FRONTEND_DIR, sub)
        if os.path.isdir(sub_dir):
            app.mount(f"/{sub}", StaticFiles(directory=sub_dir), name=sub)

    @app.api_route("/", methods=["GET", "HEAD"])
    def serve_index():
        return FileResponse(os.path.join(FRONTEND_DIR, "index.html"))

    @app.get("/manifest.json")
    def serve_manifest():
        return FileResponse(os.path.join(FRONTEND_DIR, "manifest.json"))

    @app.get("/sw.js")
    def serve_sw():
        return FileResponse(os.path.join(FRONTEND_DIR, "sw.js"))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=False)
