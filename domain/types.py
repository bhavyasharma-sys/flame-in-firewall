"""Immutable domain value objects for cabin physics, risk, and ranking."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class CabinParams:
    oxygen_pct: float = 21.0
    pressure_kpa: float = 101.3
    flow_velocity_cm_s: float = 10.0
    gravity_g: float = 0.0
    fuel_material: str = "Cotton-Fiberglass"
    diluent_gas: str = "N2"

    def to_dict(self) -> dict[str, Any]:
        return {
            "oxygen_pct": self.oxygen_pct,
            "pressure_kpa": self.pressure_kpa,
            "flow_velocity_cm_s": self.flow_velocity_cm_s,
            "gravity_g": self.gravity_g,
            "fuel_material": self.fuel_material,
            "diluent_gas": self.diluent_gas,
        }


ISS_BASELINE = CabinParams(
    oxygen_pct=21.0,
    pressure_kpa=101.3,
    flow_velocity_cm_s=10.0,
    gravity_g=0.0,
    fuel_material="Cotton-Fiberglass",
    diluent_gas="N2",
)


@dataclass(frozen=True)
class Contribution:
    feature: str
    label: str
    value: float

    def to_dict(self) -> dict[str, Any]:
        return {"feature": self.feature, "label": self.label, "value": self.value}


@dataclass(frozen=True)
class RiskResult:
    risk_index: float
    risk_band: str
    baseline_risk: float
    predicted_regime: str
    estimated_loi_pct: float
    oxygen_margin_pct: float
    u_buoyant_cm_s: float
    u_eff_cm_s: float
    safety_score: int
    contributions: tuple[Contribution, ...]

    def to_dict(self) -> dict[str, Any]:
        return {
            "risk_index": self.risk_index,
            "risk_band": self.risk_band,
            "baseline_risk": self.baseline_risk,
            "predicted_regime": self.predicted_regime,
            "estimated_loi_pct": self.estimated_loi_pct,
            "oxygen_margin_pct": self.oxygen_margin_pct,
            "u_buoyant_cm_s": self.u_buoyant_cm_s,
            "u_eff_cm_s": self.u_eff_cm_s,
            "safety_score": self.safety_score,
            "contributions": [c.to_dict() for c in self.contributions],
        }


@dataclass(frozen=True)
class RankedRun:
    rank: int
    experiment_id: str
    total_score: float
    similarity_score: float
    completeness_score: float
    criticality_score: float
    record: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return {
            "rank": self.rank,
            "experiment_id": self.experiment_id,
            "total_score": self.total_score,
            "similarity_score": self.similarity_score,
            "completeness_score": self.completeness_score,
            "criticality_score": self.criticality_score,
            "record": self.record,
        }
