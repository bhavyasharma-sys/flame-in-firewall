"""Microgravity combustion physics engine.

Transparent, explainable combustion models unifying EMBER's physics formulas
with Flame in Freefall's expanded spacecraft material catalog.
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Mapping
from typing import Any

P0_KPA = 101.3
DEFAULT_BASE_LOI = 18.0

# Canonical base Limiting Oxygen Index (% O2 at 1g, 101.3 kPa, buoyant flow)
MATERIAL_BASE_LOI: dict[str, float] = {
    "PMMA": 17.5,
    "Cotton-Fiberglass": 18.5,
    "Nomex": 27.0,
    "Heptane": 13.5,
    "Methanol": 15.5,
    "Teflon (PTFE)": 95.0,
    "Kapton Film": 37.0,
    "Silicone Composite": 25.5,
    "Epoxy Composite": 22.0,
    "Nylon-6": 21.0,
    "Polyethylene": 17.0,
    "Velcro Strips": 16.5,
    "Kevlar": 29.0,
    "Cellulose (Paper)": 18.0,
    "Foam Insulation (Polyurethane)": 16.5,
    "Electrical Wire Insulation (Cross-linked ETFE)": 26.0,
    "Polycarbonate": 25.0,
}

# Material display aliases -> canonical key
MATERIAL_ALIASES: dict[str, str] = {
    "pmma": "PMMA",
    "pmma (acrylic)": "PMMA",
    "pmma (plexiglass)": "PMMA",
    "acrylic": "PMMA",
    "cotton": "Cotton-Fiberglass",
    "cotton fabric": "Cotton-Fiberglass",
    "cotton-fiberglass": "Cotton-Fiberglass",
    "cotton-fiberglass blend (sibal)": "Cotton-Fiberglass",
    "cotton-fiberglass blend fabric": "Cotton-Fiberglass",
    "sibal": "Cotton-Fiberglass",
    "sibal cloth": "Cotton-Fiberglass",
    "nomex": "Nomex",
    "nomex® blend": "Nomex",
    "nomex blend": "Nomex",
    "nomex fabric": "Nomex",
    "heptane": "Heptane",
    "n-heptane": "Heptane",
    "methanol": "Methanol",
    "teflon": "Teflon (PTFE)",
    "ptfe": "Teflon (PTFE)",
    "teflon (ptfe)": "Teflon (PTFE)",
    "kapton": "Kapton Film",
    "kapton film": "Kapton Film",
    "kapton (polyimide film)": "Kapton Film",
    "silicone": "Silicone Composite",
    "silicone rubber": "Silicone Composite",
    "silicone composite": "Silicone Composite",
    "silicone rubber sheets": "Silicone Composite",
    "epoxy": "Epoxy Composite",
    "epoxy composite": "Epoxy Composite",
    "nylon": "Nylon-6",
    "nylon-6": "Nylon-6",
    "polyethylene": "Polyethylene",
    "velcro": "Velcro Strips",
    "velcro® strips": "Velcro Strips",
    "velcro strips": "Velcro Strips",
    "velcro (hook and loop)": "Velcro Strips",
    "kevlar": "Kevlar",
    "cellulose": "Cellulose (Paper)",
    "cellulose (paper)": "Cellulose (Paper)",
    "paper": "Cellulose (Paper)",
    "foam insulation (polyurethane)": "Foam Insulation (Polyurethane)",
    "polyurethane": "Foam Insulation (Polyurethane)",
    "polyurethane foam": "Foam Insulation (Polyurethane)",
    "electrical wire insulation (cross-linked etfe)": "Electrical Wire Insulation (Cross-linked ETFE)",
    "etfe": "Electrical Wire Insulation (Cross-linked ETFE)",
    "polycarbonate": "Polycarbonate",
}

DILUENT_SHIFT: dict[str, float] = {
    "N2": 0.0,
    "CO2": 3.0,
    "He": 2.0,
    "Ar": -1.0,
}

ALLOWED_DILUENTS: frozenset[str] = frozenset(DILUENT_SHIFT.keys())
ALLOWED_CANONICAL_MATERIALS: frozenset[str] = frozenset(MATERIAL_BASE_LOI.keys())
_EXACT_MATERIAL_MAP: dict[str, str] = {
    **{k.lower(): k for k in MATERIAL_BASE_LOI},
    **MATERIAL_ALIASES,
}


def validate_material(name: str) -> str | None:
    """Return canonical material name if `name` is an allowed material/alias, else None."""
    if not isinstance(name, str) or not name.strip():
        return None
    cleaned = name.strip()
    if cleaned in MATERIAL_BASE_LOI:
        return cleaned
    return _EXACT_MATERIAL_MAP.get(cleaned.lower())


def validate_diluent(diluent: str) -> str | None:
    """Return canonical diluent symbol if in {N2, CO2, He, Ar}, else None."""
    if not isinstance(diluent, str) or not diluent.strip():
        return None
    cleaned = diluent.strip()
    if cleaned in ALLOWED_DILUENTS:
        return cleaned
    return None


def canonical_material(name: str) -> str:
    """Normalize a material label to its canonical physics key."""
    if not name:
        return "Cotton-Fiberglass"
    cleaned = name.strip()
    if cleaned in MATERIAL_BASE_LOI:
        return cleaned
    key = cleaned.lower()
    if key in MATERIAL_ALIASES:
        return MATERIAL_ALIASES[key]
    for alias, canon in MATERIAL_ALIASES.items():
        if alias in key:
            return canon
    return cleaned


def buoyant_velocity(gravity_g: float, pressure_kpa: float) -> float:
    """Characteristic buoyancy-induced velocity (cm/s); ~30 cm/s at 1g sea level."""
    return 30.0 * math.sqrt(max(gravity_g, 0.0) * max(pressure_kpa, 0.0) / P0_KPA)


def effective_velocity(flow_cm_s: float, gravity_g: float, pressure_kpa: float) -> float:
    """u_eff = sqrt(u_forced^2 + u_buoyant^2)."""
    return math.sqrt(flow_cm_s**2 + buoyant_velocity(gravity_g, pressure_kpa) ** 2)


def flow_loi_shift(u_eff: float) -> float:
    """U-shaped LOI shift vs effective velocity (the 'ventilation paradox').

    * u -> 0  : oxygen starvation / radiative loss -> LOI rises (~+2.75 %)
    * u ~ 8   : 'ventilation paradox' minimum -> LOI dips (~-1.3 %)
    * u > 30  : blow-off -> LOI rises again
    """
    return (
        3.0 * math.exp(-u_eff / 3.0)
        - 1.5 * math.exp(-(((u_eff - 8.0) / 6.0) ** 2))
        + 0.05 * max(0.0, u_eff - 30.0)
    )


def pressure_loi_shift(pressure_kpa: float) -> float:
    """Lower ambient pressure reduces gas-phase heat capacity & shifts LOI."""
    return 4.0 * (1.0 - pressure_kpa / P0_KPA)


def limiting_oxygen_index(
    material: str,
    gravity_g: float,
    pressure_kpa: float,
    flow_cm_s: float,
    diluent: str = "N2",
) -> float:
    canon = canonical_material(material)
    u = effective_velocity(flow_cm_s, gravity_g, pressure_kpa)
    base_loi = MATERIAL_BASE_LOI.get(canon, DEFAULT_BASE_LOI)
    return (
        base_loi
        + flow_loi_shift(u)
        + pressure_loi_shift(pressure_kpa)
        + DILUENT_SHIFT.get(diluent, 0.0)
    )


def predict_regime(material: str, gravity_g: float, oxygen_margin: float) -> str:
    canon = canonical_material(material)
    if oxygen_margin < -2.0:
        return "No Ignition"
    if oxygen_margin < 0.0:
        return "Self-Extinguished"
    if canon == "Heptane" and gravity_g < 0.05 and oxygen_margin < 9.0:
        return "Cool Flame"
    return "Sustained Burn"


def ventilation_curve(u_max: float = 40.0, steps: int = 81) -> dict[str, Any]:
    """Return U-shaped LOI shift curve points and the exact danger minimum."""
    points = []
    min_pt = {"u_eff": 0.0, "velocity_cm_s": 0.0, "loi_shift": float("inf"), "loi_shift_pct": float("inf")}
    for i in range(steps):
        u = (i / max(steps - 1, 1)) * u_max
        shift = flow_loi_shift(u)
        pt = {
            "u_eff": round(u, 2),
            "velocity_cm_s": round(u, 2),
            "loi_shift": round(shift, 3),
            "loi_shift_pct": round(shift, 3),
        }
        points.append(pt)
        if shift < min_pt["loi_shift"]:
            min_pt = pt
    return {"points": points, "danger_minimum": min_pt}


def phase_grid(
    material: str,
    gravity_g: float = 0.0,
    flow_cm_s: float = 10.0,
    diluent: str = "N2",
    o2_values: tuple[float, ...] = tuple(15.0 + 1.5 * i for i in range(17)),
    pressure_values: tuple[float, ...] = tuple(50.0 + 5.0 * i for i in range(14)),
) -> list[dict[str, float | str]]:
    """2D (O2, P) combustion regime & LOI margin grid for phase diagram plotting."""
    grid: list[dict[str, float | str]] = []
    for p_kpa in pressure_values:
        loi = limiting_oxygen_index(material, gravity_g, p_kpa, flow_cm_s, diluent)
        for o2_pct in o2_values:
            margin = o2_pct - loi
            regime = predict_regime(material, gravity_g, margin)
            grid.append(
                {
                    "oxygen_pct": round(o2_pct, 1),
                    "pressure_kpa": round(p_kpa, 1),
                    "estimated_loi_pct": round(loi, 2),
                    "oxygen_margin_pct": round(margin, 2),
                    "regime": regime,
                    "predicted_regime": regime,
                }
            )
    return grid


def fit_material_base_loi(runs: Iterable[Mapping[str, Any]]) -> dict[str, float]:
    """Least-squares calibration of MATERIAL_BASE_LOI against experimental LOI observations."""
    residuals_by_mat: dict[str, list[float]] = {}
    for r in runs:
        loi_obs = r.get("limiting_oxygen_index_pct")
        mat = r.get("fuel_material")
        g = r.get("gravity_g")
        p = r.get("pressure_kpa")
        flow = r.get("flow_velocity_cm_s")
        dil = r.get("diluent_gas") or "N2"
        if loi_obs is None or not mat or g is None or p is None or flow is None:
            continue
        u = effective_velocity(float(flow), float(g), float(p))
        shift = flow_loi_shift(u) + pressure_loi_shift(float(p)) + DILUENT_SHIFT.get(str(dil), 0.0)
        residuals_by_mat.setdefault(str(mat), []).append(float(loi_obs) - shift)
    calibrated = dict(MATERIAL_BASE_LOI)
    for mat, vals in residuals_by_mat.items():
        if vals:
            calibrated[mat] = round(sum(vals) / len(vals), 2)
    return calibrated
