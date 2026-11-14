"""Explainable entity rankings for Flame in Freefall:
Ranks Experiments, Materials, Findings, and Safety Guidelines with transparent
component scores and human-readable explanations.
"""

from __future__ import annotations

import re
from typing import Any


def rank_experiments_explainable(
    experiments: list[dict[str, Any]],
    focus: str = "safety",
) -> list[dict[str, Any]]:
    """Rank flagship NASA experiments with visible rule breakdown."""
    scored: list[dict[str, Any]] = []
    for exp in experiments:
        safety_n = len(exp.get("safety_implications") or [])
        findings_n = len(exp.get("key_findings") or [])
        materials_n = len(exp.get("materials_tested") or [])
        platform = str(exp.get("platform") or "")
        years = str(exp.get("years") or "")
        cat = str(exp.get("category") or "")

        safety_pts = min(safety_n * 8.0, 30.0)
        findings_pts = min(findings_n * 5.0, 25.0)
        materials_pts = min(materials_n * 4.0, 20.0)
        platform_pts = 15.0 if ("ISS" in platform or "Cygnus" in platform) else 10.0

        # Recency bonus
        yr_matches = re.findall(r"(20\d{2})", years)
        latest_yr = max((int(y) for y in yr_matches), default=2015)
        recency_pts = min(max((latest_yr - 2008) * 0.7, 2.0), 10.0)

        if focus == "materials":
            total = materials_pts * 1.4 + safety_pts * 0.8 + findings_pts + platform_pts * 0.8
        elif focus == "recency":
            total = recency_pts * 2.5 + safety_pts + findings_pts * 0.8 + platform_pts
        else:
            total = safety_pts + findings_pts + materials_pts + platform_pts + recency_pts

        reasons = [
            f"{safety_n} direct spacecraft safety implications",
            f"{findings_n} empirical combustion findings",
            f"{materials_n} materials/fuels evaluated on {platform or 'orbital platform'}",
        ]
        if latest_yr >= 2020:
            reasons.append(f"Recent exploration-era campaign ({years})")

        scored.append(
            {
                "id": exp.get("id"),
                "name": exp.get("name"),
                "acronym": exp.get("acronym"),
                "category": cat,
                "platform": platform,
                "years": years,
                "score": round(min(total, 100.0), 1),
                "components": {
                    "safety_findings": round(safety_pts, 1),
                    "research_depth": round(findings_pts, 1),
                    "material_breadth": round(materials_pts, 1),
                    "platform_relevance": round(platform_pts, 1),
                    "recency": round(recency_pts, 1),
                },
                "reasons": reasons,
            }
        )

    scored.sort(key=lambda x: x["score"], reverse=True)
    for idx, item in enumerate(scored, start=1):
        item["rank"] = idx
    return scored


def rank_materials_explainable(
    materials: list[dict[str, Any]],
    environment: str = "Lunar 34% O2",
) -> list[dict[str, Any]]:
    """Rank spacecraft materials by composite fire risk (higher score = higher fire hazard)."""
    env_lower = environment.lower()
    env_mult = 1.15 if ("lunar" in env_lower or "34%" in env_lower) else (1.08 if "mars" in env_lower else 1.0)

    smoke_map = {"very high": 15.0, "high": 12.0, "moderate": 8.0, "low": 4.0, "very low": 1.5}
    scored: list[dict[str, Any]] = []
    for mat in materials:
        flam = float(mat.get("flammability_rating") or 5) * 4.5  # up to 45
        tox = float(mat.get("toxicity_rating") or 5) * 2.0  # up to 20
        loi = mat.get("extinction_o2_threshold")
        loi_pts = max(0.0, min(20.0, (28.0 - float(loi)) * 1.4)) if loi is not None else 2.0
        smoke_raw = str(mat.get("smoke_production") or "Moderate").lower()
        smoke_pts = next((v for k, v in smoke_map.items() if k in smoke_raw), 7.0)

        raw_risk = (flam + tox + loi_pts + smoke_pts) * env_mult
        risk_score = round(min(raw_risk, 100.0), 1)
        tier = "CRITICAL" if risk_score >= 75 else ("HIGH" if risk_score >= 55 else ("MODERATE" if risk_score >= 35 else "LOW"))

        reasons = [
            f"Flammability index {mat.get('flammability_rating')}/10, toxicity {mat.get('toxicity_rating')}/10",
            f"Extinction O₂ threshold: {f'{loi}%' if loi is not None else 'Non-propagating in standard air'}",
            f"Smoke output: {mat.get('smoke_production', 'Moderate')} (env factor ×{env_mult:.2f})",
        ]

        scored.append(
            {
                "name": mat.get("name"),
                "category": mat.get("category"),
                "risk_score": risk_score,
                "safety_score": round(max(1.0, 100.0 - risk_score), 1),
                "risk_tier": tier,
                "extinction_o2_threshold": loi,
                "components": {
                    "flammability": round(flam, 1),
                    "toxicity": round(tox, 1),
                    "loi_vulnerability": round(loi_pts, 1),
                    "smoke_obscuration": round(smoke_pts, 1),
                },
                "reasons": reasons,
                "safety_recommendation": mat.get("safety_recommendation", ""),
            }
        )

    scored.sort(key=lambda x: x["risk_score"], reverse=True)
    for idx, item in enumerate(scored, start=1):
        item["rank"] = idx
    return scored


def rank_findings_explainable(findings: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Rank empirical findings by safety relevance, quantitative evidence, and operational impact."""
    rel_map = {"critical": 45.0, "high": 34.0, "medium": 22.0, "low": 12.0}
    scored: list[dict[str, Any]] = []
    for f in findings:
        rel_str = str(f.get("safety_relevance") or "High").lower()
        rel_pts = rel_map.get(rel_str, 25.0)
        quant = str(f.get("quantitative_result") or "")
        nums = re.findall(r"\d+(?:\.\d+)?", quant)
        quant_pts = min(15.0 + len(nums) * 5.0, 30.0) if quant else 5.0
        imp = str(f.get("implications_for_spacecraft") or "")
        imp_pts = min(10.0 + len(imp.split()) * 0.7, 25.0) if imp else 5.0

        total = round(min(rel_pts + quant_pts + imp_pts, 100.0), 1)
        reasons = [
            f"Safety relevance rated {f.get('safety_relevance', 'High')}",
            f"{len(nums)} quantitative empirical metric(s) documented",
            f"Source investigation: {f.get('source_experiment', 'NASA PSI')}",
        ]
        scored.append(
            {
                "id": f.get("id"),
                "title": f.get("title"),
                "category": f.get("category"),
                "source_experiment": f.get("source_experiment"),
                "safety_relevance": f.get("safety_relevance"),
                "quantitative_result": quant,
                "implications_for_spacecraft": imp,
                "score": total,
                "components": {
                    "safety_relevance": round(rel_pts, 1),
                    "quantitative_evidence": round(quant_pts, 1),
                    "spacecraft_impact": round(imp_pts, 1),
                },
                "reasons": reasons,
            }
        )

    scored.sort(key=lambda x: x["score"], reverse=True)
    for idx, item in enumerate(scored, start=1):
        item["rank"] = idx
    return scored


def rank_guidelines_explainable(
    guidelines: list[dict[str, Any]],
    environment: str | None = None,
) -> list[dict[str, Any]]:
    """Rank safety guidelines by priority, risk tier, experimental backing, and habitat match."""
    risk_map = {"critical": 35.0, "high": 25.0, "medium": 15.0, "low": 8.0}
    env_q = (environment or "").strip().lower()
    scored: list[dict[str, Any]] = []

    for g in guidelines:
        prio = int(g.get("priority") or 2)
        prio_pts = {1: 35.0, 2: 24.0, 3: 14.0}.get(prio, 12.0)
        risk_pts = risk_map.get(str(g.get("risk_level") or "High").lower(), 20.0)
        exps = g.get("related_experiments") or []
        exp_pts = min(len(exps) * 6.0, 18.0)

        g_env = str(g.get("environment") or "All Environments").lower()
        if not env_q or "all" in g_env or env_q in g_env:
            env_pts = 12.0
        else:
            env_pts = 4.0

        total = round(min(prio_pts + risk_pts + exp_pts + env_pts, 100.0), 1)
        reasons = [
            f"Priority P{prio} ({g.get('risk_level', 'High')} risk)",
            f"Backed by {len(exps)} NASA experiment(s): {', '.join(exps[:3])}",
            f"Applicability: {g.get('environment', 'All Environments')}",
        ]
        scored.append(
            {
                "id": g.get("id"),
                "title": g.get("title"),
                "environment": g.get("environment"),
                "category": g.get("category"),
                "risk_level": g.get("risk_level"),
                "priority": prio,
                "recommendation": g.get("recommendation"),
                "rationale": g.get("rationale"),
                "related_experiments": exps,
                "score": total,
                "components": {
                    "priority_weight": round(prio_pts, 1),
                    "risk_severity": round(risk_pts, 1),
                    "experiment_backing": round(exp_pts, 1),
                    "environment_fit": round(env_pts, 1),
                },
                "reasons": reasons,
            }
        )

    scored.sort(key=lambda x: x["score"], reverse=True)
    for idx, item in enumerate(scored, start=1):
        item["rank"] = idx
    return scored
