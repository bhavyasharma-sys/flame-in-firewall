"""Unified data loader for Flame in Freefall + EMBER NASA datasets,
test runs, time-series telemetry, mission presets, and full-text NASA documents.
"""

from __future__ import annotations

import json
import logging
import os
import re
from typing import Any, Optional

import yaml

from config import EMBER_CORPUS_DIR, EMBER_DATA_DIR, EMBER_ISS_DIR, KNOWLEDGE_BASE_DIR

logger = logging.getLogger(__name__)

_PAGE_SPLIT_RE = re.compile(r"<!--\s*page:\s*(\d+)\s*-->", re.IGNORECASE)
_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n(.*)$", re.DOTALL)


def _load_json(path: str) -> Any:
    if not os.path.isfile(path):
        logger.warning("JSON file not found: %s", path)
        return None
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except Exception as exc:
        logger.error("Failed reading %s: %s", path, exc)
        return None


def load_experiments() -> list[dict[str, Any]]:
    data = _load_json(os.path.join(KNOWLEDGE_BASE_DIR, "experiments.json"))
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        return data.get("experiments", [])
    return []


def load_materials() -> list[dict[str, Any]]:
    data = _load_json(os.path.join(KNOWLEDGE_BASE_DIR, "materials.json"))
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        return data.get("materials", [])
    return []


def load_findings() -> list[dict[str, Any]]:
    data = _load_json(os.path.join(KNOWLEDGE_BASE_DIR, "findings.json"))
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        return data.get("findings", [])
    return []


def load_safety_guidelines() -> list[dict[str, Any]]:
    data = _load_json(os.path.join(KNOWLEDGE_BASE_DIR, "safety_guidelines.json"))
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        return data.get("guidelines", [])
    return []


def load_challenge_brief() -> list[dict[str, Any]]:
    data = _load_json(os.path.join(KNOWLEDGE_BASE_DIR, "challenge_brief.json"))
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        return data.get("items", [data])
    return []


def load_presets() -> list[dict[str, Any]]:
    data = _load_json(os.path.join(EMBER_DATA_DIR, "presets.json"))
    return data if isinstance(data, list) else []


def load_test_runs() -> list[dict[str, Any]]:
    data = _load_json(os.path.join(EMBER_DATA_DIR, "experiments_proxy.json"))
    return data if isinstance(data, list) else []


def load_telemetry_map() -> dict[str, dict[str, Any]]:
    data = _load_json(os.path.join(EMBER_DATA_DIR, "telemetry_proxy.json"))
    if not isinstance(data, list):
        return {}
    return {str(item["experiment_id"]): item for item in data if isinstance(item, dict) and "experiment_id" in item}


_DOC_PDF_MAP: dict[str, tuple[str, list[str], int]] = {
    "DOC-01": ("nasa_glenn_bass.pdf", ["S. L. Olson", "P. V. Ferkul", "NASA Glenn"], 2016),
    "DOC-02": ("nasa_glenn_saffire.pdf", ["D. L. Urban", "G. A. Ruff", "NASA Glenn"], 2021),
    "DOC-03": ("nasa_glenn_flex.pdf", ["F. A. Williams", "D. L. Dietrich", "NASA Glenn"], 2014),
    "DOC-04": ("nasa_glenn_acme.pdf", ["D. P. Stocker", "P. B. Sunderland", "NASA Glenn"], 2020),
    "DOC-05": ("nasa_glenn_slice.pdf", ["S. L. Olson", "F. Miller", "NASA Glenn"], 2022),
    "DOC-06": ("iss_researchers_guide_combustion_science.pdf", ["NASA ISS Program Science Office"], 2023),
    "DOC-07": ("nasa_glenn_same.pdf", ["G. A. Ruff", "D. L. Urban", "NASA Glenn"], 2019),
    "DOC-08": ("nasa_glenn_daft.pdf", ["NASA Technology Transfer Program"], 2024),
    "ISS-ACME": ("nasa_glenn_acme.pdf", ["NASA ISS Combustion Team"], 2022),
    "ISS-BASS-II": ("nasa_glenn_bass.pdf", ["NASA ISS Combustion Team"], 2016),
    "ISS-FLEX": ("nasa_glenn_flex.pdf", ["NASA ISS Combustion Team"], 2017),
    "ISS-SOFIE": ("nasa_glenn_spice.pdf", ["NASA Glenn SoFIE Team"], 2025),
    "DOC-BRIEF": ("iss_researchers_guide_combustion_science.pdf", ["NASA International Space Apps 2026"], 2026),
}


def _enrich_doc_metadata(doc: dict[str, Any]) -> dict[str, Any]:
    doc_id = str(doc.get("doc_id", "")).upper()
    pdf_file, authors, year = _DOC_PDF_MAP.get(doc_id, (None, ["NASA Research Team"], 2024))
    src_type = str(doc.get("source_type") or "ntrs")
    if src_type == "iss_page":
        category = "iss_investigation"
    elif src_type == "challenge_brief":
        category = "challenge_brief"
    else:
        category = "nasa_paper"
    doc["pdf_file"] = pdf_file
    doc["authors"] = doc.get("authors") or authors
    doc["year"] = doc.get("year") or year
    doc["category"] = category
    doc["source_url"] = doc.get("url") or ((doc.get("sources") or [None])[0])
    return doc


def _parse_markdown_doc(filepath: str, default_type: str = "ntrs") -> Optional[dict[str, Any]]:
    try:
        with open(filepath, "r", encoding="utf-8") as fh:
            raw = fh.read()
    except OSError as exc:
        logger.error("Failed reading markdown doc %s: %s", filepath, exc)
        return None

    meta: dict[str, Any] = {}
    body = raw
    m = _FRONTMATTER_RE.match(raw)
    if m:
        try:
            meta = yaml.safe_load(m.group(1)) or {}
        except yaml.YAMLError as exc:
            logger.warning("Frontmatter parse warning in %s: %s", filepath, exc)
        body = m.group(2)

    doc_id = str(meta.get("doc_id") or os.path.splitext(os.path.basename(filepath))[0]).upper()
    title = str(meta.get("title") or doc_id)
    source_type = str(meta.get("source_type") or default_type)
    investigation = meta.get("investigation")
    url = meta.get("url")
    sources = list(meta.get("sources") or ([] if not url else [url]))

    # Split into pages using <!-- page: N -->
    parts = _PAGE_SPLIT_RE.split(body)
    pages: list[dict[str, Any]] = []
    if len(parts) >= 3:
        # parts = [preamble, page_num_1, content_1, page_num_2, content_2, ...]
        for idx in range(1, len(parts), 2):
            page_num = int(parts[idx])
            page_text = parts[idx + 1].strip() if idx + 1 < len(parts) else ""
            # Extract section headings
            headings = re.findall(r"^#{1,3}\s+(.+)$", page_text, flags=re.MULTILINE)
            section = headings[0].strip() if headings else f"Page {page_num}"
            pages.append(
                {
                    "page": page_num,
                    "section": section,
                    "headings": headings,
                    "text": page_text,
                }
            )
    else:
        headings = re.findall(r"^#{1,3}\s+(.+)$", body, flags=re.MULTILINE)
        pages.append(
            {
                "page": 1,
                "section": headings[0].strip() if headings else title,
                "headings": headings,
                "text": body.strip(),
            }
        )

    return {
        "doc_id": doc_id,
        "title": title,
        "source_type": source_type,
        "investigation": investigation,
        "fuel": meta.get("fuel") or [],
        "o2_range": meta.get("o2_range") or [],
        "pressure_kpa": meta.get("pressure_kpa") or [],
        "gravity": meta.get("gravity") or [],
        "proxy": bool(meta.get("proxy", False)),
        "url": url,
        "sources": sources,
        "page_count": len(pages),
        "pages": pages,
        "related_experiment_ids": [],
    }


def load_nasa_documents(test_runs: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    """Load all EMBER NASA NTRS/PSI corpus papers, ISS investigation summaries,
    and synthesize the official NASA Space Apps Challenge Brief as a readable document.
    """
    docs: list[dict[str, Any]] = []

    for directory, default_type in [(EMBER_CORPUS_DIR, "ntrs"), (EMBER_ISS_DIR, "iss_page")]:
        if not os.path.isdir(directory):
            continue
        for fname in sorted(os.listdir(directory)):
            if not fname.endswith(".md"):
                continue
            parsed = _parse_markdown_doc(os.path.join(directory, fname), default_type=default_type)
            if parsed:
                docs.append(parsed)

    # Also expose the Challenge Brief as DOC-BRIEF in the library & reader
    brief_items = load_challenge_brief()
    if brief_items:
        brief_pages = []
        for idx, item in enumerate(brief_items, start=1):
            lines = [f"# {item.get('title', item.get('name', 'Challenge Brief'))}", "", item.get("description", "")]
            if item.get("key_findings"):
                lines.append("\n## Key Requirements & Benchmarks\n")
                for kf in item["key_findings"]:
                    lines.append(f"- {kf}")
            if item.get("safety_implications"):
                lines.append("\n## Safety & Operational Implications\n")
                for si in item["safety_implications"]:
                    lines.append(f"- {si}")
            brief_pages.append(
                {
                    "page": idx,
                    "section": item.get("category", f"Section {idx}"),
                    "headings": [item.get("title", "Challenge Brief")],
                    "text": "\n".join(lines).strip(),
                }
            )
        docs.append(
            {
                "doc_id": "DOC-BRIEF",
                "title": "NASA Space Apps 2026 Challenge Brief — Flame in Freefall (Official Document)",
                "source_type": "challenge_brief",
                "investigation": "Space Apps 2026",
                "fuel": ["PMMA", "Cotton-Fiberglass", "Nomex"],
                "o2_range": [16, 100],
                "pressure_kpa": [30, 101.3],
                "gravity": [0.0, 0.16, 0.38, 1.0],
                "proxy": False,
                "url": "https://docs.google.com/document/d/1gnuFsb96_K2457aZGRiJVGeAuKk-xj8Zh7okbYMtC0U/edit",
                "sources": [
                    "https://docs.google.com/document/d/1gnuFsb96_K2457aZGRiJVGeAuKk-xj8Zh7okbYMtC0U/edit",
                    "/papers/iss_researchers_guide_combustion_science.pdf",
                ],
                "page_count": len(brief_pages),
                "pages": brief_pages,
                "related_experiment_ids": [],
            }
        )

    # Attach related test-run IDs from the 50-run matrix
    runs = test_runs if test_runs is not None else load_test_runs()
    by_doc: dict[str, list[str]] = {}
    by_prog: dict[str, list[str]] = {}
    for run in runs:
        exp_id = str(run.get("experiment_id") or "")
        sdoc = str(run.get("source_doc_id") or "").upper()
        prog = str(run.get("program") or "").upper()
        if sdoc and exp_id:
            by_doc.setdefault(sdoc, []).append(exp_id)
        if prog and exp_id:
            by_prog.setdefault(prog, []).append(exp_id)

    for doc in docs:
        related = list(by_doc.get(doc["doc_id"], []))
        inv = str(doc.get("investigation") or "").upper()
        if not related and inv and inv in by_prog:
            related = list(by_prog[inv])
        doc["related_experiment_ids"] = related
        _enrich_doc_metadata(doc)

    return docs


def load_all_data() -> dict[str, Any]:
    runs = load_test_runs()
    docs = load_nasa_documents(runs)
    return {
        "experiments": load_experiments(),
        "materials": load_materials(),
        "findings": load_findings(),
        "guidelines": load_safety_guidelines(),
        "challenge_brief": load_challenge_brief(),
        "presets": load_presets(),
        "test_runs": runs,
        "telemetry": load_telemetry_map(),
        "documents": docs,
    }


def get_experiment_by_id(exp_id: str, experiments: list[dict[str, Any]] | None = None) -> Optional[dict[str, Any]]:
    target = exp_id.strip().lower()
    exps = experiments if experiments is not None else load_experiments()
    for exp in exps:
        if (
            str(exp.get("id", "")).lower() == target
            or str(exp.get("acronym", "")).lower() == target
            or str(exp.get("name", "")).lower() == target
        ):
            return exp
    for exp in exps:
        if target in str(exp.get("name", "")).lower() or target in str(exp.get("acronym", "")).lower():
            return exp
    return None


def get_material_by_name(name: str, materials: list[dict[str, Any]] | None = None) -> Optional[dict[str, Any]]:
    target = name.strip().lower()
    mats = materials if materials is not None else load_materials()
    for mat in mats:
        mname = str(mat.get("name", "")).lower()
        if target == mname or target in mname or mname in target:
            return mat
    return None
