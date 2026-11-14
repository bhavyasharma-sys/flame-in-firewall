"""Semantic embedding utilities with local zero-cost deterministic vectors
and optional Gemini embedding backend.
"""

from __future__ import annotations

import hashlib
import logging
import math
import re
from collections import Counter
from typing import Optional

from config import EMBEDDING_DIMENSION

logger = logging.getLogger(__name__)

_STOP_WORDS = frozenset(
    {
        "the", "and", "in", "of", "to", "a", "is", "for", "on", "that", "by", "this",
        "with", "i", "you", "it", "not", "or", "be", "are", "from", "at", "as", "your",
        "all", "have", "new", "more", "an", "was", "we", "will", "can", "us", "if",
        "about", "into", "what", "why", "how", "does", "do", "does", "they", "their",
        "which", "when", "where", "there", "these", "those", "also", "been", "being",
    }
)


def tokenize(text: str) -> list[str]:
    """Tokenize text preserving hyphenated NASA identifiers (BASS-II, EXP-0001, NASA-STD-6001B)."""
    raw = re.findall(r"\b[a-zA-Z0-9][a-zA-Z0-9_\-]{1,}\b", text.lower())
    tokens: list[str] = []
    for tok in raw:
        if tok in _STOP_WORDS:
            continue
        tokens.append(tok)
        # Also add split parts of hyphenated identifiers for flexible matching
        if "-" in tok:
            for part in tok.split("-"):
                if len(part) >= 2 and part not in _STOP_WORDS:
                    tokens.append(part)
    return tokens


def embed_texts(
    texts: list[str],
    dimension: int = EMBEDDING_DIMENSION,
    idf_weights: Optional[dict[str, float]] = None,
) -> list[list[float]]:
    """Generate L2-normalized local semantic vectors combining unigrams, bigrams, and char trigrams."""
    if not texts:
        return []

    tokenized = [tokenize(t) for t in texts]

    if idf_weights is None:
        doc_freq: Counter[str] = Counter()
        for toks in tokenized:
            doc_freq.update(set(toks))
        n_docs = max(len(texts), 1)
        local_idf = {tok: math.log((1.0 + n_docs) / (1.0 + df)) + 1.0 for tok, df in doc_freq.items()}
    else:
        local_idf = idf_weights

    vectors: list[list[float]] = []
    for toks in tokenized:
        vec = [0.0] * dimension
        tf = Counter(toks)

        for token, count in tf.items():
            weight = (1.0 + math.log(count)) * local_idf.get(token, 1.5)
            h = int(hashlib.blake2b(token.encode("utf-8"), digest_size=8).hexdigest(), 16)
            idx = h % dimension
            sign = 1.0 if ((h >> 16) & 1) == 0 else -1.0
            vec[idx] += sign * weight

            # Character trigram boost for fuzzy / morphological matching
            if len(token) >= 4:
                for i in range(len(token) - 2):
                    tri = f"~{token[i:i+3]}"
                    th = int(hashlib.blake2b(tri.encode("utf-8"), digest_size=4).hexdigest(), 16)
                    tidx = th % dimension
                    tsign = 1.0 if ((th >> 8) & 1) == 0 else -1.0
                    vec[tidx] += tsign * (0.22 * weight)

        # Bigrams for multi-word physics concepts ("cool flame", "ventilation paradox")
        for i in range(len(toks) - 1):
            bg = f"{toks[i]}_{toks[i+1]}"
            bh = int(hashlib.blake2b(bg.encode("utf-8"), digest_size=6).hexdigest(), 16)
            bidx = bh % dimension
            bsign = 1.0 if ((bh >> 12) & 1) == 0 else -1.0
            vec[bidx] += bsign * 1.15

        norm = math.sqrt(sum(x * x for x in vec))
        if norm > 0:
            vec = [x / norm for x in vec]
        else:
            vec[0] = 1.0
        vectors.append(vec)

    return vectors


def get_embedding_backend_name() -> str:
    return "Local Signed-Hash Hybrid Semantic (384-d)"
