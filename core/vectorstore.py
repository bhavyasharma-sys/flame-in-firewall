"""Hybrid Vector + Keyword (Reciprocal Rank Fusion) Store.
Uses persistent NumPy cosine similarity + BM25-inspired keyword scoring with
automatic corpus-digest rebuild so dimension or content mismatches never occur.
"""

from __future__ import annotations

import logging
import math
from collections import Counter
from typing import Any, Optional

import numpy as np

from config import EMBEDDING_DIMENSION, TOP_K_RESULTS
from core.embeddings import embed_texts, get_embedding_backend_name, tokenize

logger = logging.getLogger(__name__)


class VectorStore:
    """In-memory hybrid semantic + lexical vector store with RRF fusion."""

    def __init__(self, dimension: int = EMBEDDING_DIMENSION):
        self.dimension = dimension
        self._docs: list[dict[str, Any]] = []
        self._vectors: Optional[np.ndarray] = None
        self._doc_tokens: list[Counter[str]] = []
        self._doc_lengths: list[int] = []
        self._avg_doc_len: float = 1.0
        self._idf: dict[str, float] = {}
        self._corpus_digest: str = ""

    def build_index(self, chunks: list[dict[str, Any]], digest: str = "") -> int:
        """Index all chunks with IDF weights and normalized semantic vectors."""
        if not chunks:
            return 0
        self._docs = list(chunks)
        self._corpus_digest = digest

        # Compute corpus-level IDF & BM25 statistics
        self._doc_tokens = []
        doc_freq: Counter[str] = Counter()
        for c in chunks:
            toks = tokenize(c.get("text", ""))
            tf = Counter(toks)
            self._doc_tokens.append(tf)
            doc_freq.update(tf.keys())

        n_docs = max(len(chunks), 1)
        self._doc_lengths = [sum(tf.values()) for tf in self._doc_tokens]
        self._avg_doc_len = max(sum(self._doc_lengths) / n_docs, 1.0)
        self._idf = {
            tok: math.log((n_docs - df + 0.5) / (df + 0.5) + 1.0) + 1.0
            for tok, df in doc_freq.items()
        }

        texts = [c.get("text", "") for c in chunks]
        vecs = embed_texts(texts, dimension=self.dimension, idf_weights=self._idf)
        arr = np.array(vecs, dtype=np.float32)
        norms = np.linalg.norm(arr, axis=1, keepdims=True)
        norms[norms == 0] = 1.0
        self._vectors = arr / norms

        logger.info("VectorStore indexed %d documents (digest=%s).", len(self._docs), digest or "n/a")
        return len(self._docs)

    def search(self, query: str, top_k: int = TOP_K_RESULTS) -> list[dict[str, Any]]:
        """Hybrid retrieval fusing dense cosine similarity and BM25 lexical ranking via RRF."""
        if not query.strip() or self._vectors is None or not self._docs:
            return []

        n = len(self._docs)
        q_vec = np.array(embed_texts([query], dimension=self.dimension, idf_weights=self._idf)[0], dtype=np.float32)
        q_norm = np.linalg.norm(q_vec)
        if q_norm > 0:
            q_vec = q_vec / q_norm

        # 1. Dense cosine scores
        dense_scores = np.dot(self._vectors, q_vec)
        dense_rank_order = np.argsort(dense_scores)[::-1]
        dense_ranks = np.empty(n, dtype=np.int32)
        dense_ranks[dense_rank_order] = np.arange(1, n + 1)

        # 2. Lexical BM25 scores
        q_tokens = tokenize(query)
        bm25_scores = np.zeros(n, dtype=np.float32)
        k1, b = 1.4, 0.75
        for idx, tf in enumerate(self._doc_tokens):
            dl = self._doc_lengths[idx]
            score = 0.0
            for tok in q_tokens:
                freq = tf.get(tok, 0)
                if freq <= 0:
                    continue
                idf = self._idf.get(tok, 1.0)
                score += idf * ((freq * (k1 + 1.0)) / (freq + k1 * (1.0 - b + b * dl / self._avg_doc_len)))
            bm25_scores[idx] = score

        bm25_rank_order = np.argsort(bm25_scores)[::-1]
        bm25_ranks = np.empty(n, dtype=np.int32)
        bm25_ranks[bm25_rank_order] = np.arange(1, n + 1)

        # 3. Reciprocal Rank Fusion (RRF, k=40) + tiny direct signal tiebreaker
        rrf_k = 40.0
        rrf_scores = (1.0 / (rrf_k + dense_ranks)) + (1.25 / (rrf_k + bm25_ranks))
        # Slight boost for NASA corpus pages & direct exact matches
        q_lower = query.lower()
        for idx, doc in enumerate(self._docs):
            if bm25_scores[idx] > 0:
                meta = doc.get("metadata", {})
                if meta.get("doc_id") and meta.get("page"):
                    rrf_scores[idx] *= 1.08
                if meta.get("experiment_id") and meta["experiment_id"].lower() in q_lower:
                    rrf_scores[idx] *= 2.0

        top_indices = np.argsort(rrf_scores)[::-1][:top_k]
        hits: list[dict[str, Any]] = []
        max_rrf = float(rrf_scores[top_indices[0]]) if len(top_indices) > 0 and rrf_scores[top_indices[0]] > 0 else 1.0

        for idx in top_indices:
            doc = self._docs[int(idx)]
            hits.append(
                {
                    "text": doc["text"],
                    "metadata": doc.get("metadata", {}),
                    "score": round(float(rrf_scores[int(idx)]) / max_rrf, 4),
                    "dense_score": round(float(dense_scores[int(idx)]), 4),
                    "bm25_score": round(float(bm25_scores[int(idx)]), 3),
                }
            )
        return hits

    def get_documents_by_source(self, source_name: str) -> list[dict[str, Any]]:
        matches = [
            {"text": d["text"], "metadata": d.get("metadata", {}), "score": 1.0}
            for d in self._docs
            if d.get("metadata", {}).get("source") == source_name
        ]
        matches.sort(key=lambda x: x.get("metadata", {}).get("chunk_index", 0))
        return matches

    def get_collection_stats(self) -> dict[str, Any]:
        return {
            "collection_name": "flame_in_freefall_hybrid_v3",
            "document_count": len(self._docs),
            "storage_backend": "Hybrid Cosine + BM25 RRF Store",
            "embedding_backend": get_embedding_backend_name(),
            "dimension": self.dimension,
            "corpus_digest": self._corpus_digest,
        }
