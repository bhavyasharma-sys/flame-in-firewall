"""Citation tag parser, citation-aware sentence splitter, and verification audit.
Ported & adapted from EMBER's strict sentence-level citation verification.
"""

from __future__ import annotations

import re
from typing import Any, Final

DOC_CITE: Final = re.compile(r"\[([A-Za-z0-9_-]+)\s+p\.(\d+)\]")
EXP_CITE: Final = re.compile(r"\[(EXP-\d{4})\]")

_TERMINATORS: Final = ".!?"
_CLOSERS: Final = "*_\"')”’"
_BULLET: Final = re.compile(r"[ \t]*(?:[-*•][ \t]+|\d{1,3}[.)][ \t]+)")
_TRAILING_TAG: Final = re.compile(r"[ \t,;]*\[(?:[A-Za-z0-9_-]+\s+p\.\d+|EXP-\d{4})\]")


def format_doc_tag(doc_id: str, page: int) -> str:
    return f"[{doc_id} p.{page}]"


def format_exp_tag(experiment_id: str) -> str:
    return f"[{experiment_id}]"


def extract_tags(text: str) -> tuple[list[tuple[str, int]], list[str]]:
    """Return (doc_tags, experiment_ids) in order of first appearance, deduplicated."""
    docs = list(dict.fromkeys((doc_id.upper(), int(page)) for doc_id, page in DOC_CITE.findall(text)))
    exps = list(dict.fromkeys(exp_id.upper() for exp_id in EXP_CITE.findall(text)))
    return docs, exps


def _absorb_trailing_tags(text: str, pos: int) -> int:
    while m := _TRAILING_TAG.match(text, pos):
        pos = m.end()
    return pos


def _ends_sentence(text: str, nxt: int) -> bool:
    return nxt == len(text) or text[nxt].isspace() or text[nxt] == "["


def split_sentences(text: str) -> list[str]:
    """Split markdown/LLM output into sentences without breaking inside citation tags."""
    sentences: list[str] = []
    buf: list[str] = []

    def flush() -> None:
        sentence = "".join(buf).strip()
        if sentence:
            sentences.append(sentence)
        buf.clear()

    n, i, depth, line_start = len(text), 0, 0, True
    while i < n:
        if line_start:
            line_start = False
            if depth == 0 and (m := _BULLET.match(text, i)):
                i = m.end()
                continue
        ch = text[i]
        if ch == "[":
            depth += 1
        elif ch == "]":
            depth = max(0, depth - 1)
        elif depth == 0 and ch == "\n":
            flush()
            line_start = True
            i += 1
            continue
        elif depth == 0 and ch in _TERMINATORS:
            after = i + 1
            while after < n and text[after] in _CLOSERS:
                after += 1
            if _ends_sentence(text, after):
                end = _absorb_trailing_tags(text, after)
                buf.append(text[i:end])
                flush()
                i = end
                continue
        buf.append(ch)
        i += 1
    flush()
    return sentences


def audit_citations(
    answer_text: str,
    valid_doc_pages: set[tuple[str, int]],
    valid_doc_ids: set[str],
    valid_exp_ids: set[str],
    strict_drop: bool = False,
) -> dict[str, Any]:
    """Audit inline [DOC-XX p.Y] and [EXP-XXXX] citations against retrieved evidence.

    Returns verified citation tags, any unverified/dropped claims, and grounding metrics.
    """
    sentences = split_sentences(answer_text)
    verified_docs: list[dict[str, Any]] = []
    verified_exps: list[str] = []
    seen_doc: set[tuple[str, int]] = set()
    seen_exp: set[str] = set()
    dropped_claims: list[str] = []
    kept_sentences: list[str] = []
    cited_claim_count = 0
    substantive_claim_count = 0

    for s in sentences:
        # Skip structural headings, source footers, or short labels
        stripped = s.strip()
        if (
            stripped.startswith("#")
            or stripped.lower().startswith("cited nasa sources")
            or stripped.lower().startswith("warning:")
            or stripped.startswith("[Mode:")
            or len(stripped) < 25
        ):
            kept_sentences.append(s)
            continue

        doc_tags, exp_tags = extract_tags(stripped)
        valid_tags_in_sentence = False

        for doc_id, page in doc_tags:
            if (doc_id, page) in valid_doc_pages or doc_id in valid_doc_ids:
                valid_tags_in_sentence = True
                if (doc_id, page) not in seen_doc:
                    seen_doc.add((doc_id, page))
                    verified_docs.append({"doc_id": doc_id, "page": page, "tag": format_doc_tag(doc_id, page)})

        for exp_id in exp_tags:
            if exp_id in valid_exp_ids:
                valid_tags_in_sentence = True
                if exp_id not in seen_exp:
                    seen_exp.add(exp_id)
                    verified_exps.append(exp_id)

        # Also recognize named NASA markdown links as grounded
        has_md_link = bool(re.search(r"\[[^\]]+\]\((?:https?://|/papers/)[^)]+\)", stripped))
        substantive_claim_count += 1

        if valid_tags_in_sentence or has_md_link:
            cited_claim_count += 1
            kept_sentences.append(s)
        else:
            if doc_tags or exp_tags:
                # Hallucinated/unmatched citation tag — flag as unverified!
                dropped_claims.append(stripped)
                if not strict_drop:
                    kept_sentences.append(s)
            else:
                kept_sentences.append(s)

    grounding_score = (
        round((cited_claim_count / substantive_claim_count) * 100.0, 1)
        if substantive_claim_count > 0
        else 100.0
    )

    return {
        "verified_doc_citations": verified_docs,
        "verified_exp_citations": verified_exps,
        "dropped_claims": dropped_claims,
        "grounding_pct": grounding_score,
        "checked_sentences": substantive_claim_count,
        "cited_sentences": cited_claim_count,
        "filtered_text": "\n\n".join(kept_sentences) if strict_drop and dropped_claims else answer_text,
    }
