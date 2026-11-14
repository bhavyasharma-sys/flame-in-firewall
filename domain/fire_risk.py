"""Spacecraft Fire Risk Index (0-100) with exact 2^5 Shapley attributions
and multi-environment habitat fire safety interpretation.
"""

from __future__ import annotations

import dataclasses
import math
from collections.abc import Iterable
from typing import Any, Final

from domain.combustion import (
    buoyant_velocity,
    canonical_material,
    effective_velocity,
    limiting_oxygen_index,
    predict_regime,
)
from domain.shapley import exact_shapley
from domain.types import ISS_BASELINE, CabinParams, Contribution, RiskResult

FEATURE_GROUPS: Final[dict[str, tuple[str, tuple[str, ...]]]] = {
    "oxygen_enrichment": ("Oxygen concentration", ("oxygen_pct",)),
    "ventilation_coupling": ("HVAC ventilation flow", ("flow_velocity_cm_s",)),
    "gravity_buoyancy_regime": ("Gravity / buoyancy", ("gravity_g",)),
    "cabin_pressure_density": ("Cabin pressure", ("pressure_kpa",)),
    "material_flammability_intrinsic": ("Material & diluent", ("fuel_material", "diluent_gas")),
}


def _sigmoid(z: float) -> float:
    clamped = max(min(z, 60.0), -60.0)
    return 1.0 / (1.0 + math.exp(-clamped))


def oxygen_margin(params: CabinParams) -> tuple[float, float]:
    """Return (oxygen_pct - LOI, LOI)."""
    loi = limiting_oxygen_index(
        params.fuel_material,
        params.gravity_g,
        params.pressure_kpa,
        params.flow_velocity_cm_s,
        params.diluent_gas,
    )
    return params.oxygen_pct - loi, loi


def risk(params: CabinParams) -> float:
    margin, _ = oxygen_margin(params)
    return 100.0 * _sigmoid((margin - 4.0) / 3.0)


def risk_band(r: float) -> str:
    if r < 25:
        return "LOW"
    if r < 50:
        return "ELEVATED"
    if r < 75:
        return "HIGH"
    return "CRITICAL"


def _mix(x: CabinParams, base: CabinParams, groups: Iterable[str]) -> CabinParams:
    changes = {f: getattr(x, f) for g in groups for f in FEATURE_GROUPS[g][1]}
    return dataclasses.replace(base, **changes)


def shapley_contributions(x: CabinParams, base: CabinParams = ISS_BASELINE) -> dict[str, float]:
    """Exact Shapley value of each feature group for risk(x) - risk(base)."""
    return exact_shapley(lambda s: risk(_mix(x, base, s)), list(FEATURE_GROUPS))


def evaluate_cabin(params: CabinParams, baseline: CabinParams = ISS_BASELINE) -> RiskResult:
    norm_params = dataclasses.replace(params, fuel_material=canonical_material(params.fuel_material))
    margin, loi = oxygen_margin(norm_params)
    r = risk(norm_params)
    base_r = risk(baseline)
    r_rounded = round(r, 2)
    base_rounded = round(base_r, 2)
    phi = shapley_contributions(norm_params, baseline)
    contribs = sorted(
        (Contribution(k, FEATURE_GROUPS[k][0], round(v, 2)) for k, v in phi.items()),
        key=lambda c: abs(c.value),
        reverse=True,
    )
    if contribs and abs(contribs[0].value) > 0:
        target_delta = round(r_rounded - base_rounded, 2)
        current_sum = round(sum(c.value for c in contribs), 2)
        residual = round(target_delta - current_sum, 2)
        if residual != 0.0:
            c0 = contribs[0]
            contribs[0] = Contribution(c0.feature, c0.label, round(c0.value + residual, 2))

    u_b = round(buoyant_velocity(norm_params.gravity_g, norm_params.pressure_kpa), 2)
    u_eff = round(effective_velocity(norm_params.flow_velocity_cm_s, norm_params.gravity_g, norm_params.pressure_kpa), 2)
    safety_score = max(1, min(99, round(100.0 - r_rounded)))

    return RiskResult(
        risk_index=r_rounded,
        risk_band=risk_band(r),
        baseline_risk=base_rounded,
        predicted_regime=predict_regime(norm_params.fuel_material, norm_params.gravity_g, margin),
        estimated_loi_pct=round(loi, 2),
        oxygen_margin_pct=round(margin, 2),
        u_buoyant_cm_s=u_b,
        u_eff_cm_s=u_eff,
        safety_score=safety_score,
        contributions=tuple(contribs),
    )


def build_engineering_guidance(params: CabinParams, res: RiskResult) -> dict[str, Any]:
    """Produce actionable spacecraft fire-safety risk factors & engineering directives."""
    factors: list[str] = []
    recs: list[str] = []

    if params.gravity_g < 0.05:
        factors.append(
            f"Microgravity (0 g) eliminates buoyant plumes (u_buoyant = {res.u_buoyant_cm_s} cm/s); "
            f"oxygen transport is dictated solely by HVAC ventilation ({params.flow_velocity_cm_s:.1f} cm/s)."
        )
    elif params.gravity_g <= 0.45:
        body = "Lunar (0.16 g)" if params.gravity_g < 0.25 else "Martian (0.38 g)"
        factors.append(
            f"Partial gravity ({body}, u_buoyant = {res.u_buoyant_cm_s} cm/s) sits near the flammability "
            f"inversion zone where gentle buoyancy enhances oxidizer supply without blowing off flames."
        )
    else:
        factors.append(
            f"Normal/elevated gravity ({params.gravity_g:.2f} g) induces strong buoyant upward convection "
            f"(u_buoyant = {res.u_buoyant_cm_s} cm/s), elongating flames and accelerating upward spread."
        )

    if 3.0 <= res.u_eff_cm_s <= 15.0:
        factors.append(
            f"Ventilation Paradox Active: effective flow ({res.u_eff_cm_s} cm/s) sits in the peak-flammability "
            f"trough (~5–12 cm/s) where LOI dips below both quiescent 0 g and 1 g limits (BASS-II finding)."
        )
        recs.append("Mandate immediate inter-module ventilation (IMV) fan shutdown upon first optical smoke or CO trigger.")
    elif res.u_eff_cm_s < 3.0:
        factors.append(
            f"Quiescent flow ({res.u_eff_cm_s} cm/s) increases radiative heat loss and raises LOI, "
            f"but combustion products and CO accumulate near ignition sites."
        )
        recs.append("Maintain CO electrochemical monitoring (25 ppm warning) and 45-min post-extinction thermal watch.")
    else:
        factors.append(
            f"Elevated effective velocity ({res.u_eff_cm_s} cm/s) increases convective heat removal toward blow-off limits."
        )

    if params.oxygen_pct >= 28.0:
        factors.append(
            f"Hyperoxic exploration atmosphere ({params.oxygen_pct:.1f}% O₂ at {params.pressure_kpa:.1f} kPa) "
            f"yields an oxygen margin of {res.oxygen_margin_pct:+.1f}% above estimated LOI ({res.estimated_loi_pct:.1f}%)."
        )
        recs.append(
            f"Re-qualify {params.fuel_material} under NASA-STD-6001B Test 1 at {params.oxygen_pct:.1f}% O₂ / {params.pressure_kpa:.1f} kPa; "
            f"enforce non-metallic mass limits and thermal barrier isolation."
        )
    elif res.oxygen_margin_pct > 0:
        factors.append(
            f"Positive oxygen margin ({res.oxygen_margin_pct:+.1f}% over LOI {res.estimated_loi_pct:.1f}%) "
            f"supports {res.predicted_regime} combustion."
        )
        recs.append(
            f"Restrict {params.fuel_material} away from electrical harnesses; deploy dual-wavelength photoelectric smoke detectors in return ducts."
        )
    else:
        factors.append(
            f"Negative oxygen margin ({res.oxygen_margin_pct:+.1f}% below LOI {res.estimated_loi_pct:.1f}%) "
            f"favors {res.predicted_regime} under nominal airflow."
        )
        recs.append(
            f"{params.fuel_material} maintains fire margin under these conditions; verify thermal decomposition off-gassing (HF/HCN/CO) if exposed to external heat."
        )

    if res.predicted_regime == "Cool Flame":
        factors.append(
            "FLEX-2 Cool-Flame Alert: invisible low-temperature (~650 K) oxidation can persist for 40+ s after hot flame extinction."
        )
        recs.append("Require IR thermal imaging and trace formaldehyde/CO verification before restoring cabin airflow.")

    return {
        "factors": factors,
        "recommendations": " ".join(recs),
        "recommendation_items": recs,
    }


def habitat_materials_matrix() -> list[dict[str, Any]]:
    """Compute physics-backed comparative safety scores across ISS, Lunar, and Martian habitats."""
    materials = [
        "Teflon (PTFE)",
        "Kapton Film",
        "Nomex",
        "Silicone Composite",
        "Epoxy Composite",
        "Nylon-6",
        "Cotton-Fiberglass",
        "PMMA",
        "Polyethylene",
        "Velcro Strips",
        "Methanol",
        "Heptane",
    ]
    rows = []
    for mat in materials:
        iss_res = evaluate_cabin(CabinParams(21.0, 101.3, 10.0, 0.0, mat, "N2"))
        lunar_res = evaluate_cabin(CabinParams(34.0, 56.5, 5.0, 0.16, mat, "N2"))
        mars_res = evaluate_cabin(CabinParams(26.5, 70.3, 5.0, 0.38, mat, "N2"))
        rows.append(
            {
                "material": mat,
                "iss": iss_res.safety_score,
                "lunar": lunar_res.safety_score,
                "martian": mars_res.safety_score,
                "iss_risk": iss_res.risk_index,
                "lunar_risk": lunar_res.risk_index,
                "martian_risk": mars_res.risk_index,
                "loi_iss": iss_res.estimated_loi_pct,
                "loi_lunar": lunar_res.estimated_loi_pct,
                "risk": lunar_res.risk_band,
            }
        )
    rows.sort(key=lambda r: r["lunar"], reverse=True)
    return rows


__all__ = [
    "FEATURE_GROUPS",
    "build_engineering_guidance",
    "evaluate_cabin",
    "habitat_materials_matrix",
    "oxygen_margin",
    "risk",
    "risk_band",
    "shapley_contributions",
]
