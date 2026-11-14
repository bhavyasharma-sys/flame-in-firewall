"""General formatting and risk-color helpers for Flame in Freefall."""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any


def format_timestamp(dt: datetime | None = None) -> str:
    if dt is None:
        dt = datetime.now()
    return dt.strftime("%Y-%m-%d %H:%M:%S")


def truncate_text(text: str, max_len: int = 120, suffix: str = "…") -> str:
    if not text:
        return ""
    if len(text) <= max_len:
        return text
    return text[: max_len - len(suffix)] + suffix


def color_for_risk(score: float | int | str) -> str:
    """Return a hex color for a risk band string or 0-100 safety score."""
    if isinstance(score, str):
        level = score.upper()
        if "LOW" in level:
            return "#22c55e"
        if "ELEV" in level or "MOD" in level:
            return "#eab308"
        if "HIGH" in level:
            return "#f97316"
        if "CRIT" in level:
            return "#ef4444"
        try:
            score = float(score)
        except ValueError:
            return "#94a3b8"
    try:
        val = float(score)
        if val >= 75:
            return "#22c55e"
        if val >= 55:
            return "#eab308"
        if val >= 35:
            return "#f97316"
        return "#ef4444"
    except Exception:
        return "#94a3b8"


def clean_markdown_text(text: str, keep_markdown: bool = True) -> str:
    """Clean debug lines while preserving rich Markdown formatting for the Web UI."""
    if not text:
        return ""
    lines = []
    for raw_line in text.split("\n"):
        line = raw_line.rstrip()
        if line.strip().startswith("//"):
            continue
        if not keep_markdown:
            line = re.sub(r"^#{1,6}\s+", "", line)
            line = re.sub(r"\*\*(.*?)\*\*", r"\1", line)
            line = re.sub(r"`([^`]+)`", r"\1", line)
        lines.append(line)
    cleaned = "\n".join(lines)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned.strip()


def find_similar_findings(
    target: dict[str, Any], all_findings: list[dict[str, Any]], top_n: int = 4
) -> list[dict[str, Any]]:
    """Find similar findings by category, source experiment, and token overlap."""
    target_id = target.get("id")
    target_cat = str(target.get("category") or "").lower()
    target_exp = str(target.get("source_experiment") or "").lower()
    t_words = set(
        re.findall(
            r"[a-z]{4,}",
            f"{target.get('title', '')} {target.get('description', '')} {target.get('implications_for_spacecraft', '')}".lower(),
        )
    )

    scored = []
    for f in all_findings:
        if f.get("id") == target_id:
            continue
        score = 0.0
        if str(f.get("category") or "").lower() == target_cat and target_cat:
            score += 3.0
        if str(f.get("source_experiment") or "").lower() == target_exp and target_exp:
            score += 2.5
        f_words = set(
            re.findall(
                r"[a-z]{4,}",
                f"{f.get('title', '')} {f.get('description', '')} {f.get('implications_for_spacecraft', '')}".lower(),
            )
        )
        overlap = len(t_words & f_words)
        score += min(overlap * 0.4, 5.0)
        if score > 0:
            scored.append((score, f))

    scored.sort(key=lambda x: x[0], reverse=True)
    return [item for _, item in scored[:top_n]]
