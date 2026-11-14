"""Hybrid Vector + Keyword (Reciprocal Rank Fusion) Store.
Uses persistent NumPy cosine similarity + BM25-inspired keyword scoring with
thread-safe atomic hot-swap so live NASA corpus updates never interrupt in-flight queries.
"""

from __future__ import annotations

import logging
import math
import threading
from collections import Counter
from typing import Any, Optional

import numpy as np

from config import EMBEDDING_DIMENSION, TOP_K_RESULTS
from core.embeddings import embed_texts, get_embedding_backend_name, tokenize

logger = logging.getLogger(__name__)


class VectorStore:
    """Thread-safe in-memory hybrid semantic + lexical vector store with RRF fusion."""

    def __init__(self, dimension: int = EMBEDDING_DIMENSION):
        self.dimension = dimension
        self._lock = threading.RLock()
        self._docs: list[dict[str, Any]] = []
        self._vectors: Optional[np.ndarray] = None
        self._doc_tokens: list[Counter[str]] = []
        self._doc_lengths: list[int] = []
        self._avg_doc_len: float = 1.0
        self._idf: dict[str, float] = {}
        self._corpus_digest: str = ""

    def build_index(self, chunks: list[dict[str, Any]], digest: str = "") -> int:
        """Build dense + BM25 index off-lock and atomically swap into place."""
        if not chunks:
            return 0
        new_docs = list(chunks)

        # Compute corpus-level IDF & BM25 statistics outside the lock
        new_doc_tokens: list[Counter[str]] = []
        doc_freq: Counter[str] = Counter()
        for c in new_docs:
            toks = tokenize(c.get("text", ""))
            tf = Counter(toks)
            new_doc_tokens.append(tf)
            doc_freq.update(tf.keys())

        n_docs = max(len(new_docs), 1)
        new_doc_lengths = [sum(tf.values()) for tf in new_doc_tokens]
        new_avg_doc_len = max(sum(new_doc_lengths) / n_docs, 1.0)
        new_idf = {
            tok: math.log((n_docs - df + 0.5) / (df + 0.5) + 1.0) + 1.0
            for tok, df in doc_freq.items()
        }

        texts = [c.get("text", "") for c in new_docs]
        vecs = embed_texts(texts, dimension=self.dimension, idf_weights=new_idf)
        arr = np.array(vecs, dtype=np.float32)
        norms = np.linalg.norm(arr, axis=1, keepdims=True)
        norms[norms == 0] = 1.0
        new_vectors = arr / norms

        # Atomic reference swap so concurrent searches never see a partial index
        with self._lock:
            self._docs = new_docs
            self._doc_tokens = new_doc_tokens
            self._doc_lengths = new_doc_lengths
            self._avg_doc_len = new_avg_doc_len
            self._idf = new_idf
            self._vectors = new_vectors
            self._corpus_digest = digest

        logger.info("VectorStore indexed %d documents (digest=%s).", len(new_docs), digest or "n/a")
        return len(new_docs)

    def search(self, query: str, top_k: int = TOP_K_RESULTS) -> list[dict[str, Any]]:
        """Hybrid retrieval fusing dense cosine similarity and BM25 lexical ranking via RRF."""
        if not query.strip():
            return []

        with self._lock:
            docs = self._docs
            vectors = self._vectors
            doc_tokens = self._doc_tokens
            doc_lengths = self._doc_lengths
            avg_doc_len = self._avg_doc_len
            idf_map = self._idf

        if vectors is None or not docs:
            return []

        n = len(docs)
        q_vec = np.array(embed_texts([query], dimension=self.dimension, idf_weights=idf_map)[0], dtype=np.float32)
        q_norm = np.linalg.norm(q_vec)
        if q_norm > 0:
            q_vec = q_vec / q_norm

        # 1. Dense cosine scores
        dense_scores = np.dot(vectors, q_vec)
        dense_rank_order = np.argsort(dense_scores)[::-1]
        dense_ranks = np.empty(n, dtype=np.int32)
        dense_ranks[dense_rank_order] = np.arange(1, n + 1)

        # 2. Lexical BM25 scores
        q_tokens = tokenize(query)
        bm25_scores = np.zeros(n, dtype=np.float32)
        k1, b = 1.4, 0.75
        for idx, tf in enumerate(doc_tokens):
            dl = doc_lengths[idx]
            score = 0.0
            for tok in q_tokens:
                freq = tf.get(tok, 0)
                if freq <= 0:
                    continue
                idf = idf_map.get(tok, 1.0)
                score += idf * ((freq * (k1 + 1.0)) / (freq + k1 * (1.0 - b + b * dl / avg_doc_len)))
            bm25_scores[idx] = score

        bm25_rank_order = np.argsort(bm25_scores)[::-1]
        bm25_ranks = np.empty(n, dtype=np.int32)
        bm25_ranks[bm25_rank_order] = np.arange(1, n + 1)

        # 3. Reciprocal Rank Fusion (RRF, k=40) + tiny direct signal tiebreaker
        rrf_k = 40.0
        rrf_scores = (1.0 / (rrf_k + dense_ranks)) + (1.25 / (rrf_k + bm25_ranks))
        # Slight boost for NASA corpus pages, live-synced NASA pages & direct exact matches
        q_lower = query.lower()
        for idx, doc in enumerate(docs):
            if bm25_scores[idx] > 0:
                meta = doc.get("metadata", {})
                if meta.get("doc_id") and meta.get("page"):
                    rrf_scores[idx] *= 1.12 if meta.get("is_live") else 1.08
                if meta.get("experiment_id") and meta["experiment_id"].lower() in q_lower:
                    rrf_scores[idx] *= 2.0

        top_indices = np.argsort(rrf_scores)[::-1][:top_k]
        hits: list[dict[str, Any]] = []
        max_rrf = float(rrf_scores[top_indices[0]]) if len(top_indices) > 0 and rrf_scores[top_indices[0]] > 0 else 1.0

        for idx in top_indices:
            doc = docs[int(idx)]
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
        with self._lock:
            docs = list(self._docs)
        matches = [
            {"text": d["text"], "metadata": d.get("metadata", {}), "score": 1.0}
            for d in docs
            if d.get("metadata", {}).get("source") == source_name
        ]
        matches.sort(key=lambda x: x.get("metadata", {}).get("chunk_index", 0))
        return matches

    def get_collection_stats(self) -> dict[str, Any]:
        with self._lock:
            doc_count = len(self._docs)
            digest = self._corpus_digest
        return {
            "collection_name": "flame_in_freefall_hybrid_v3",
            "document_count": doc_count,
            "storage_backend": "Hybrid Cosine + BM25 RRF Store",
            "embedding_backend": get_embedding_backend_name(),
            "dimension": self.dimension,
            "corpus_digest": digest,
        }
