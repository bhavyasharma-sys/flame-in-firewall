"""Unified data ingestion and overlapping semantic chunking.
Ingests:
  1. Flame in Freefall JSON knowledge base (experiments, materials, findings, guidelines, challenge_brief)
  2. EMBER NASA NTRS/PSI corpus papers & ISS investigation summaries (page-aware for [DOC-XX p.Y])
  3. EMBER 50 structured NASA combustion test runs (for [EXP-XXXX] retrieval)
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
from typing import Any

from config import CHUNK_OVERLAP, CHUNK_SIZE, KNOWLEDGE_BASE_DIR
from utils.data_loader import load_nasa_documents, load_test_runs

logger = logging.getLogger(__name__)


def compute_corpus_digest(chunks: list[dict[str, Any]]) -> str:
    """Compute a stable SHA-256 digest of all ingested chunks to detect corpus updates."""
    h = hashlib.sha256()
    for c in chunks:
        h.update(c.get("text", "").encode("utf-8"))
        meta = c.get("metadata", {})
        h.update(json.dumps(meta, sort_keys=True, default=str).encode("utf-8"))
    return h.hexdigest()[:16]


def load_and_chunk_data(
    knowledge_dir: str | None = None,
    chunk_size: int = CHUNK_SIZE,
    chunk_overlap: int = CHUNK_OVERLAP,
    documents: list[dict[str, Any]] | None = None,
    test_runs: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    knowledge_dir = knowledge_dir or KNOWLEDGE_BASE_DIR
    all_chunks: list[dict[str, Any]] = []

    # 1. Flame in Freefall JSON knowledge base
    if os.path.isdir(knowledge_dir):
        for filename in sorted(os.listdir(knowledge_dir)):
            if not filename.endswith(".json"):
                continue
            filepath = os.path.join(knowledge_dir, filename)
            try:
                with open(filepath, "r", encoding="utf-8") as fh:
                    data = json.load(fh)
            except (json.JSONDecodeError, OSError) as exc:
                logger.error("Failed to load %s: %s", filepath, exc)
                continue
            for record in _extract_records(data):
                all_chunks.extend(_chunk_record(record, filename, chunk_size, chunk_overlap))

    # 2. EMBER NASA NTRS/PSI Corpus & ISS Pages (page-aware chunks)
    docs = documents if documents is not None else load_nasa_documents()
    for doc in docs:
        doc_id = doc.get("doc_id", "DOC")
        title = doc.get("title", doc_id)
        url = doc.get("url") or (doc.get("sources") or [""])[0]
        inv = doc.get("investigation") or "NASA Combustion"
        for page_obj in doc.get("pages") or []:
            page_num = int(page_obj.get("page", 1))
            page_text = str(page_obj.get("text") or "").strip()
            if not page_text:
                continue
            header = f"[{doc_id} p.{page_num}] {title} — {page_obj.get('section', '')}\n\n"
            for idx, piece in enumerate(_split_text(page_text, chunk_size, chunk_overlap)):
                all_chunks.append(
                    {
                        "text": header + piece,
                        "metadata": {
                            "experiment_name": title,
                            "source": f"{doc_id}.md",
                            "doc_id": doc_id,
                            "page": page_num,
                            "section": str(page_obj.get("section") or ""),
                            "investigation": str(inv),
                            "category": str(doc.get("source_type") or "ntrs"),
                            "url": str(url or ""),
                            "chunk_index": idx,
                            "cite_tag": f"[{doc_id} p.{page_num}]",
                        },
                    }
                )

    # 3. Structured NASA Test Runs (EXP-0001 .. EXP-0050)
    runs = test_runs if test_runs is not None else load_test_runs()
    for run in runs:
        exp_id = str(run.get("experiment_id") or "")
        if not exp_id:
            continue
        extra = run.get("extra_telemetry") or {}
        text = (
            f"[{exp_id}] NASA {run.get('program')} test run — Material: {run.get('fuel_material')} "
            f"({run.get('fuel_geometry')}). Gravity: {run.get('gravity_g')} g, "
            f"Oxygen: {run.get('oxygen_pct')}%, Pressure: {run.get('pressure_kpa')} kPa, "
            f"Flow: {run.get('flow_velocity_cm_s')} cm/s, Diluent: {run.get('diluent_gas')}. "
            f"Combustion Regime: {run.get('combustion_regime')}. "
            f"Spread/Burn Rate: {run.get('spread_or_burn_rate')}, "
            f"Peak Radiative Flux: {run.get('peak_radiative_flux_kw_m2')} kW/m², "
            f"Measured LOI: {run.get('limiting_oxygen_index_pct')}%, "
            f"Burn Duration: {run.get('burn_duration_s')} s. "
            f"Source Paper: [{run.get('source_doc_id')} p.{run.get('source_page')}]. "
            f"Extra Telemetry: PSI {extra.get('psi_investigation_code')}, "
            f"soot={extra.get('soot_volume_fraction_ppm')} ppm, CO/CO2={extra.get('co_co2_molar_ratio')}."
        )
        all_chunks.append(
            {
                "text": text,
                "metadata": {
                    "experiment_name": f"{exp_id} ({run.get('program')} — {run.get('fuel_material')})",
                    "source": "experiments_proxy.json",
                    "experiment_id": exp_id,
                    "program": str(run.get("program") or ""),
                    "doc_id": str(run.get("source_doc_id") or ""),
                    "page": int(run.get("source_page") or 1),
                    "category": "Test Run",
                    "cite_tag": f"[{exp_id}]",
                    "chunk_index": 0,
                },
            }
        )

    logger.info("Ingested %d total chunks across KB, NASA corpus, and test runs.", len(all_chunks))
    return all_chunks


def _extract_records(data: Any) -> list[dict[str, Any]]:
    if isinstance(data, list):
        return [r for r in data if isinstance(r, dict)]
    if isinstance(data, dict):
        for key in ("experiments", "materials", "findings", "guidelines", "items"):
            if key in data and isinstance(data[key], list):
                return [r for r in data[key] if isinstance(r, dict)]
        return [data]
    return []


def _chunk_record(
    record: dict[str, Any], source_file: str, chunk_size: int, chunk_overlap: int
) -> list[dict[str, Any]]:
    name = (
        record.get("name")
        or record.get("title")
        or record.get("acronym")
        or record.get("id")
        or "unknown"
    )
    category = record.get("category", record.get("environment", "General"))
    full_text = _extract_text(record)
    if not full_text.strip():
        return []

    pieces = _split_text(full_text, chunk_size, chunk_overlap)
    return [
        {
            "text": piece,
            "metadata": {
                "experiment_name": str(name),
                "source": source_file,
                "category": str(category),
                "url": str(record.get("url") or ""),
                "doc_id": "DOC-BRIEF" if source_file == "challenge_brief.json" else "",
                "chunk_index": idx,
                "total_chunks": len(pieces),
            },
        }
        for idx, piece in enumerate(pieces)
    ]


def _extract_text(record: dict[str, Any]) -> str:
    parts: list[str] = []
    name = record.get("name") or record.get("title")
    if name:
        parts.append(f"Entity: {name}")

    simple_keys = [
        "acronym", "category", "platform", "years", "environment",
        "description", "overview", "summary", "objective", "objectives",
        "common_uses", "microgravity_behavior", "earth_vs_micro",
        "safety_recommendation", "recommendation", "rationale",
        "implications_for_spacecraft", "quantitative_result",
    ]
    for key in simple_keys:
        val = record.get(key)
        if val:
            if isinstance(val, list):
                parts.append(f"{key.replace('_', ' ').title()}: {', '.join(str(v) for v in val)}")
            else:
                parts.append(f"{key.replace('_', ' ').title()}: {val}")

    structured_keys = [
        "parameters", "flame_characteristics", "key_findings",
        "safety_implications", "conditions", "materials_tested",
    ]
    for key in structured_keys:
        val = record.get(key)
        if not val:
            continue
        if isinstance(val, list):
            items = [_flatten_item(item) for item in val]
            parts.append(f"{key.replace('_', ' ').title()}:\n" + "\n".join(f"- {i}" for i in items))
        elif isinstance(val, dict):
            parts.append(f"{key.replace('_', ' ').title()}: {_flatten_item(val)}")
        else:
            parts.append(f"{key.replace('_', ' ').title()}: {val}")

    handled = set(["name", "title", "id"] + simple_keys + structured_keys)
    for key, val in record.items():
        if key in handled or not val:
            continue
        if isinstance(val, list):
            items = [_flatten_item(item) for item in val]
            parts.append(f"{key.replace('_', ' ').title()}:\n" + "\n".join(f"- {i}" for i in items))
        elif isinstance(val, dict):
            parts.append(f"{key.replace('_', ' ').title()}: {_flatten_item(val)}")
        else:
            parts.append(f"{key.replace('_', ' ').title()}: {val}")

    return "\n\n".join(parts)


def _flatten_item(item: Any) -> str:
    if isinstance(item, str):
        return item
    if isinstance(item, dict):
        return "; ".join(f"{k}: {v}" for k, v in item.items())
    return str(item)


def _split_text(text: str, chunk_size: int, chunk_overlap: int) -> list[str]:
    if len(text) <= chunk_size:
        return [text]
    chunks: list[str] = []
    start = 0
    while start < len(text):
        end = start + chunk_size
        if end < len(text):
            snap = text[end - chunk_size // 5 : end]
            for sep in [". ", ".\n", "\n\n", "\n"]:
                pos = snap.rfind(sep)
                if pos != -1:
                    end = (end - chunk_size // 5) + pos + len(sep)
                    break
        piece = text[start:end].strip()
        if piece:
            chunks.append(piece)
        start = max(start + 1, end - chunk_overlap)
    return chunks
