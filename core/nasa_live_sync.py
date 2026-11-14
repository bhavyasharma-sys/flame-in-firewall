"""Live NASA Website & NTRS API Sync Engine for Flame in Freefall RAG Pipeline.

Polls official NASA websites (*.nasa.gov) and the NASA Technical Reports Server (NTRS)
public JSON API using conditional HTTP requests (ETag / Last-Modified) and SHA-256
content-hash diffing. Whenever any watched NASA page updates, the engine extracts clean
structured pages, persists a local cache, and invokes the corpus-update callback so the
RAG VectorStore and citation auditor hot-swap atomically with zero downtime.
"""

from __future__ import annotations

import hashlib
import html
import json
import logging
import os
import re
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from html.parser import HTMLParser
from typing import Any, Callable, Optional
from urllib.parse import urlparse

import httpx

from config import (
    LIVE_NASA_CACHE_FILE,
    NASA_LIVE_SYNC_ENABLED,
    NASA_SYNC_INTERVAL_SECONDS,
    NASA_SYNC_TIMEOUT_SECONDS,
)

logger = logging.getLogger(__name__)

USER_AGENT = "FlameInFreefall-NASA-RAG-Sync/3.0 (+https://github.com/bhavyasharma-sys/flame-in-firewall)"
MAX_HTML_BYTES = 2_500_000  # 2.5 MB safety cap per fetched NASA page
MAX_PAGES_PER_SITE = 12
TARGET_PAGE_CHARS = 2200

DEFAULT_NASA_SOURCES: list[dict[str, Any]] = [
    {
        "doc_id": "LIVE-01",
        "title": "NASA Glenn — Combustion Science Program",
        "url": "https://www.nasa.gov/glenn/glenn-expertise-space-exploration/physical-sciences-program/combustion-science/",
        "investigation": "NASA Glenn Combustion Science",
        "kind": "html",
        "builtin": True,
    },
    {
        "doc_id": "LIVE-02",
        "title": "ISS Researcher's Guide to Combustion Science",
        "url": "https://www.nasa.gov/missions/station/a-researchers-guide-to-combustion-science/",
        "investigation": "ISS Combustion Science",
        "kind": "html",
        "builtin": True,
    },
    {
        "doc_id": "LIVE-03",
        "title": "NASA PSI — BASS Investigation Portal",
        "url": "https://psi.nasa.gov/investigation/BASS",
        "investigation": "BASS / BASS-II",
        "kind": "html",
        "builtin": True,
    },
    {
        "doc_id": "LIVE-04",
        "title": "NASA PSI — ACME Investigation Portal",
        "url": "https://psi.nasa.gov/investigation/ACME",
        "investigation": "ACME",
        "kind": "html",
        "builtin": True,
    },
    {
        "doc_id": "LIVE-05",
        "title": "NASA PSI — FLEX Investigation Portal",
        "url": "https://psi.nasa.gov/investigation/FLEX",
        "investigation": "FLEX / FLEX-2",
        "kind": "html",
        "builtin": True,
    },
    {
        "doc_id": "LIVE-06",
        "title": "NASA PSI — SoFIE Investigation Portal",
        "url": "https://psi.nasa.gov/investigation/SoFIE",
        "investigation": "SoFIE",
        "kind": "html",
        "builtin": True,
    },
    {
        "doc_id": "LIVE-07",
        "title": "NASA SMA — Apollo 1 Fire Safety Lesson Learned",
        "url": "https://sma.nasa.gov/sma-disciplines/accllp/apollo-1",
        "investigation": "Apollo 1 Safety Lessons",
        "kind": "html",
        "builtin": True,
    },
    {
        "doc_id": "LIVE-08",
        "title": "NASA SMA — Apollo 13 Oxygen Tank Lesson Learned",
        "url": "https://sma.nasa.gov/sma-disciplines/accllp/apollo-13",
        "investigation": "Apollo 13 Safety Lessons",
        "kind": "html",
        "builtin": True,
    },
    {
        "doc_id": "LIVE-09",
        "title": "NASA History — Fire Aboard Space Station Mir",
        "url": "https://www.nasa.gov/history/25-years-ago-fire-aboard-space-station-mir/",
        "investigation": "Space Station Mir Fire",
        "kind": "html",
        "builtin": True,
    },
    {
        "doc_id": "LIVE-10",
        "title": "NASA Spinoff — Lightweight Composite Firefighting SCBA",
        "url": "https://spinoff.nasa.gov/node/9582",
        "investigation": "NASA Firefighting Spinoffs",
        "kind": "html",
        "builtin": True,
    },
    {
        "doc_id": "LIVE-11",
        "title": "NASA NTRS Live Feed — Microgravity Combustion & Spacecraft Fire Safety",
        "url": "https://ntrs.nasa.gov/api/citations/search?q=microgravity+combustion+spacecraft+fire+safety&page%5Bsize%5D=10",
        "display_url": "https://ntrs.nasa.gov/search?q=microgravity+combustion+spacecraft+fire+safety",
        "investigation": "NASA NTRS Live Reports",
        "kind": "ntrs_api",
        "builtin": True,
    },
]


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def validate_nasa_url(url: str, *, allow_local_test_urls: bool = False) -> str:
    """Validate that a URL targets an official *.nasa.gov host (SSRF safeguard)."""
    cleaned = str(url or "").strip()
    if not cleaned:
        raise ValueError("URL must not be empty.")
    parsed = urlparse(cleaned)
    scheme = (parsed.scheme or "").lower()
    host = (parsed.hostname or "").lower()

    if allow_local_test_urls and scheme in ("http", "https") and host in ("127.0.0.1", "localhost"):
        return cleaned

    if scheme != "https":
        raise ValueError("Live NASA sync URLs must use https://.")
    if not host or not (host == "nasa.gov" or host.endswith(".nasa.gov")):
        raise ValueError(
            f"Only official *.nasa.gov websites are permitted for live RAG sync (got '{host or 'invalid'}')."
        )
    return cleaned


# ── Pure-Stdlib Structured HTML Extractor ─────────────────────────────────────

_SKIP_TAGS = frozenset(
    {
        "script",
        "style",
        "noscript",
        "svg",
        "nav",
        "header",
        "footer",
        "aside",
        "form",
        "button",
        "iframe",
        "select",
        "option",
        "template",
        "canvas",
    }
)
_HEADING_TAGS = frozenset({"h1", "h2", "h3", "h4"})
_BLOCK_TAGS = frozenset({"p", "li", "blockquote", "tr", "dd", "dt", "figcaption", "pre", "div", "section"})
_NOISE_PATTERNS = (
    re.compile(r"^(skip to main content|an official website of the united states government|here's how you know)$", re.I),
    re.compile(r"^(menu|search|close|back to top|share|print|follow nasa|privacy policy|accessibility)$", re.I),
    re.compile(r"^cookie(s)?\s+(policy|settings|notice)", re.I),
)


class _NASAHTMLParser(HTMLParser):
    """Lightweight HTML parser extracting title, metadata, headings, and body blocks."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.title_parts: list[str] = []
        self.meta_description: str = ""
        self.meta_modified: str = ""
        self._in_title = False
        self._skip_depth = 0
        self._main_depth = 0
        self._current_tag: str = ""
        self._buf: list[str] = []
        self.main_blocks: list[tuple[str, str]] = []
        self.all_blocks: list[tuple[str, str]] = []

    def _flush(self) -> None:
        if not self._buf:
            return
        text = re.sub(r"\s+", " ", "".join(self._buf)).strip()
        self._buf.clear()
        if not text:
            return
        kind = "heading" if self._current_tag in _HEADING_TAGS else "text"
        if kind == "text" and len(text) < 20:
            return
        for pat in _NOISE_PATTERNS:
            if pat.match(text):
                return
        item = (kind, text)
        self.all_blocks.append(item)
        if self._main_depth > 0:
            self.main_blocks.append(item)

    def handle_starttag(self, tag: str, attrs: list[tuple[str, Optional[str]]]) -> None:
        t = tag.lower()
        attr_map = {k.lower(): (v or "") for k, v in attrs}

        if t == "meta":
            name = attr_map.get("name", "").lower()
            prop = attr_map.get("property", "").lower()
            content = attr_map.get("content", "").strip()
            if content:
                if name == "description" or prop == "og:description":
                    if not self.meta_description:
                        self.meta_description = content
                elif prop in ("article:modified_time", "og:updated_time") or name in ("dcterms.modified", "last-modified"):
                    if not self.meta_modified:
                        self.meta_modified = content
            return

        if t == "title":
            self._in_title = True
            return

        if t in _SKIP_TAGS:
            self._flush()
            self._skip_depth += 1
            return

        if self._skip_depth > 0:
            return

        role = attr_map.get("role", "").lower()
        if t in ("main", "article") or role == "main":
            self._main_depth += 1

        if t in _HEADING_TAGS or t in _BLOCK_TAGS:
            self._flush()
            self._current_tag = t
        elif t == "br":
            self._buf.append(" ")

    def handle_endtag(self, tag: str) -> None:
        t = tag.lower()
        if t == "title":
            self._in_title = False
            return
        if t in _SKIP_TAGS:
            self._skip_depth = max(0, self._skip_depth - 1)
            return
        if self._skip_depth > 0:
            return
        if t in _HEADING_TAGS or t in _BLOCK_TAGS:
            self._flush()
            self._current_tag = ""
        if t in ("main", "article"):
            self._main_depth = max(0, self._main_depth - 1)

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self.title_parts.append(data)
            return
        if self._skip_depth > 0:
            return
        if data:
            self._buf.append(data)


def extract_html_document(raw_html: str, fallback_title: str = "NASA Web Page") -> dict[str, Any]:
    """Parse raw NASA HTML into clean structured pages suitable for RAG chunking."""
    parser = _NASAHTMLParser()
    parser.feed(raw_html)
    parser.close()
    parser._flush()

    raw_title = re.sub(r"\s+", " ", html.unescape("".join(parser.title_parts))).strip()
    # Clean trailing "| NASA" or "- NASA" if title is descriptive
    title = re.sub(r"\s*[\|\-–—]\s*NASA\s*$", "", raw_title, flags=re.I).strip() or fallback_title

    # Prefer <main>/<article> if substantial, else full cleaned body
    main_chars = sum(len(t) for _, t in parser.main_blocks)
    blocks = parser.main_blocks if main_chars >= 180 else parser.all_blocks

    # Deduplicate consecutive repeated blocks
    deduped: list[tuple[str, str]] = []
    seen_exact: set[str] = set()
    for kind, text in blocks:
        norm = text.lower()
        if norm in seen_exact:
            continue
        seen_exact.add(norm)
        deduped.append((kind, text))

    # Build section-grouped pages (~TARGET_PAGE_CHARS each)
    pages: list[dict[str, Any]] = []
    current_section = title
    current_parts: list[str] = []
    current_len = 0

    if parser.meta_description and parser.meta_description.lower() not in seen_exact:
        current_parts.append(parser.meta_description)
        current_len += len(parser.meta_description)

    def flush_page() -> None:
        nonlocal current_len
        if not current_parts:
            return
        body = "\n\n".join(current_parts).strip()
        if len(body) >= 40:
            pages.append(
                {
                    "page": len(pages) + 1,
                    "section": current_section[:140],
                    "text": body,
                }
            )
        current_parts.clear()
        current_len = 0

    for kind, text in deduped:
        if len(pages) >= MAX_PAGES_PER_SITE:
            break
        if kind == "heading":
            if current_len >= 600:
                flush_page()
            current_section = text
            current_parts.append(f"## {text}")
            current_len += len(text) + 4
        else:
            if current_len + len(text) > TARGET_PAGE_CHARS and current_parts:
                flush_page()
                if len(pages) >= MAX_PAGES_PER_SITE:
                    break
            current_parts.append(text)
            current_len += len(text) + 2

    if len(pages) < MAX_PAGES_PER_SITE:
        flush_page()

    return {
        "title": title,
        "meta_description": parser.meta_description,
        "meta_modified": parser.meta_modified,
        "pages": pages,
    }


def extract_ntrs_api_document(payload: Any, fallback_title: str = "NASA NTRS Live Feed") -> dict[str, Any]:
    """Parse NASA NTRS public citations search JSON into structured RAG pages."""
    results = []
    if isinstance(payload, dict):
        results = payload.get("results") or payload.get("citations") or []
    elif isinstance(payload, list):
        results = payload

    pages: list[dict[str, Any]] = []
    for item in results[:MAX_PAGES_PER_SITE]:
        if not isinstance(item, dict):
            continue
        cid = item.get("id") or item.get("ntrsId") or ""
        title = str(item.get("title") or f"NASA NTRS Citation {cid}").strip()
        abstract = str(item.get("abstract") or item.get("description") or "").strip()
        pub_date = str(
            item.get("distributionDate")
            or item.get("created")
            or item.get("modified")
            or ""
        )[:10]

        authors: list[str] = []
        for aff in item.get("authorAffiliations") or []:
            if isinstance(aff, dict):
                meta = aff.get("meta") or {}
                author_obj = meta.get("author") if isinstance(meta, dict) else {}
                name = (author_obj or {}).get("name") or aff.get("authorName")
                if name:
                    authors.append(str(name).strip())
        subjects = [str(s).strip() for s in (item.get("subjectCategories") or []) if s]
        ntrs_url = f"https://ntrs.nasa.gov/citations/{cid}" if cid else "https://ntrs.nasa.gov/"

        lines = [f"Title: {title}"]
        if cid:
            lines.append(f"NASA NTRS ID: {cid} ({ntrs_url})")
        if pub_date:
            lines.append(f"Publication Date: {pub_date}")
        if authors:
            lines.append(f"Authors: {', '.join(authors[:6])}")
        if subjects:
            lines.append(f"Subject Categories: {', '.join(subjects[:5])}")
        if abstract:
            lines.append(f"Abstract: {abstract}")

        body = "\n".join(lines).strip()
        if len(body) >= 40:
            pages.append(
                {
                    "page": len(pages) + 1,
                    "section": title[:140],
                    "text": body,
                }
            )

    return {
        "title": fallback_title,
        "meta_description": f"Live NASA Technical Reports Server (NTRS) search feed ({len(pages)} citations).",
        "meta_modified": "",
        "pages": pages,
    }


def _compute_pages_hash(title: str, pages: list[dict[str, Any]]) -> str:
    h = hashlib.sha256()
    h.update(title.strip().encode("utf-8"))
    for p in pages:
        h.update(str(p.get("section") or "").strip().encode("utf-8"))
        h.update(str(p.get("text") or "").strip().encode("utf-8"))
    return h.hexdigest()[:16]


# ── Live NASA Sync Manager ────────────────────────────────────────────────────

class NasaLiveSyncManager:
    """Manages watched NASA websites, live polling, content diffing, and RAG cache."""

    def __init__(
        self,
        *,
        sources: Optional[list[dict[str, Any]]] = None,
        cache_path: str = LIVE_NASA_CACHE_FILE,
        enabled: bool = NASA_LIVE_SYNC_ENABLED,
        interval_seconds: int = NASA_SYNC_INTERVAL_SECONDS,
        timeout_seconds: float = NASA_SYNC_TIMEOUT_SECONDS,
        allow_local_test_urls: bool = False,
        on_corpus_updated: Optional[Callable[[list[dict[str, Any]]], None]] = None,
    ) -> None:
        self.cache_path = cache_path
        self.enabled = enabled
        self.interval_seconds = max(10 if allow_local_test_urls else 60, int(interval_seconds))
        self.timeout_seconds = float(timeout_seconds)
        self.allow_local_test_urls = allow_local_test_urls
        self.on_corpus_updated = on_corpus_updated

        self._state_lock = threading.RLock()
        self._sync_lock = threading.Lock()
        self._syncing = False
        self._last_run_at: Optional[str] = None
        self._last_run_monotonic: float = 0.0
        self._last_update_at: Optional[str] = None
        self._sync_runs: int = 0

        # Initialize source definitions
        base_sources = sources if sources is not None else DEFAULT_NASA_SOURCES
        self._sources: dict[str, dict[str, Any]] = {}
        for s in base_sources:
            did = str(s["doc_id"]).upper()
            self._sources[did] = {
                "doc_id": did,
                "title": str(s.get("title") or did),
                "url": str(s["url"]),
                "display_url": str(s.get("display_url") or s["url"]),
                "investigation": str(s.get("investigation") or "NASA Live Web"),
                "kind": str(s.get("kind") or "html"),
                "builtin": bool(s.get("builtin", True)),
            }

        # Per-source sync records (loaded from persistent cache if available)
        self._records: dict[str, dict[str, Any]] = {}
        self._load_cache()

    # ── Persistent Cache I/O ──────────────────────────────────────────────────

    def _effective_cache_paths(self) -> list[str]:
        fallback = os.path.join(tempfile.gettempdir(), "flame_live_nasa_cache.json")
        return [self.cache_path, fallback] if self.cache_path != fallback else [self.cache_path]

    def _load_cache(self) -> None:
        for path in self._effective_cache_paths():
            if not path or not os.path.isfile(path):
                continue
            try:
                with open(path, "r", encoding="utf-8") as fh:
                    data = json.load(fh)
            except Exception as exc:
                logger.warning("Could not read live NASA cache %s: %s", path, exc)
                continue
            if not isinstance(data, dict):
                continue

            # Restore custom user-added NASA sources
            for custom in data.get("custom_sources") or []:
                if isinstance(custom, dict) and custom.get("doc_id") and custom.get("url"):
                    did = str(custom["doc_id"]).upper()
                    if did not in self._sources:
                        self._sources[did] = {
                            "doc_id": did,
                            "title": str(custom.get("title") or did),
                            "url": str(custom["url"]),
                            "display_url": str(custom.get("display_url") or custom["url"]),
                            "investigation": str(custom.get("investigation") or "NASA Live Web"),
                            "kind": str(custom.get("kind") or "html"),
                            "builtin": False,
                        }

            recs = data.get("records") or {}
            if isinstance(recs, dict):
                for did, rec in recs.items():
                    if did.upper() in self._sources and isinstance(rec, dict):
                        self._records[did.upper()] = rec

            self._last_run_at = data.get("last_run_at")
            self._last_update_at = data.get("last_update_at")
            logger.info(
                "Loaded %d cached live NASA source records from %s.",
                len(self._records),
                path,
            )
            return

    def _save_cache(self) -> None:
        with self._state_lock:
            custom_sources = [s for s in self._sources.values() if not s.get("builtin")]
            payload = {
                "schema_version": 1,
                "last_run_at": self._last_run_at,
                "last_update_at": self._last_update_at,
                "custom_sources": custom_sources,
                "records": self._records,
            }

        for path in self._effective_cache_paths():
            if not path:
                continue
            try:
                parent = os.path.dirname(path)
                if parent:
                    os.makedirs(parent, exist_ok=True)
                tmp_path = f"{path}.tmp.{os.getpid()}"
                with open(tmp_path, "w", encoding="utf-8") as fh:
                    json.dump(payload, fh, ensure_ascii=False, indent=2)
                os.replace(tmp_path, path)
                return
            except OSError as exc:
                logger.debug("Cache write skipped for %s: %s", path, exc)

    # ── Live Documents Projection (Matches data_loader schema) ────────────────

    def get_live_documents(self) -> list[dict[str, Any]]:
        """Return all synced NASA websites with non-empty extracted pages as RAG documents."""
        docs: list[dict[str, Any]] = []
        with self._state_lock:
            for did, src in self._sources.items():
                rec = self._records.get(did)
                if not rec:
                    continue
                pages = rec.get("pages") or []
                if not pages:
                    continue
                synced_at = rec.get("last_synced_at") or rec.get("last_changed_at") or ""
                year = datetime.now(timezone.utc).year
                if len(synced_at) >= 4 and synced_at[:4].isdigit():
                    year = int(synced_at[:4])
                display_url = src.get("display_url") or src["url"]
                docs.append(
                    {
                        "doc_id": did,
                        "title": rec.get("title") or src["title"],
                        "source_type": "live_web",
                        "category": "live_nasa_web",
                        "investigation": src.get("investigation") or "NASA Live Web",
                        "url": display_url,
                        "source_url": display_url,
                        "sources": [display_url],
                        "authors": ["NASA Live Web Sync"],
                        "year": year,
                        "pdf_file": None,
                        "page_count": len(pages),
                        "pages": pages,
                        "related_experiment_ids": [],
                        "is_live": True,
                        "last_synced_at": synced_at,
                        "last_changed_at": rec.get("last_changed_at"),
                        "content_hash": rec.get("content_hash"),
                    }
                )
        return docs

    # ── Watchlist Management ──────────────────────────────────────────────────

    def add_source(
        self,
        url: str,
        *,
        title: Optional[str] = None,
        investigation: Optional[str] = None,
        kind: str = "html",
    ) -> dict[str, Any]:
        """Register an additional official *.nasa.gov URL for live RAG syncing."""
        validated = validate_nasa_url(url, allow_local_test_urls=self.allow_local_test_urls)
        clean_kind = "ntrs_api" if kind == "ntrs_api" else "html"

        with self._state_lock:
            for existing in self._sources.values():
                if existing["url"] == validated:
                    return dict(existing)

            # Allocate next LIVE-XX identifier
            max_num = 0
            for did in self._sources:
                m = re.match(r"^LIVE-(\d+)$", did)
                if m:
                    max_num = max(max_num, int(m.group(1)))
            new_id = f"LIVE-{max_num + 1:02d}"
            parsed = urlparse(validated)
            fallback_title = title.strip() if title and title.strip() else f"NASA Live — {parsed.netloc}{parsed.path[:48]}"

            src = {
                "doc_id": new_id,
                "title": fallback_title,
                "url": validated,
                "display_url": validated,
                "investigation": (investigation or "Custom NASA Live Source").strip(),
                "kind": clean_kind,
                "builtin": False,
            }
            self._sources[new_id] = src
        self._save_cache()
        return dict(src)

    def remove_source(self, doc_id: str) -> bool:
        """Remove a custom watched NASA URL and refresh the RAG index if it held pages."""
        did = str(doc_id or "").upper().strip()
        had_pages = False
        with self._state_lock:
            src = self._sources.get(did)
            if not src:
                return False
            if src.get("builtin"):
                raise ValueError(f"Built-in NASA source '{did}' cannot be deleted.")
            self._sources.pop(did, None)
            rec = self._records.pop(did, None)
            had_pages = bool(rec and rec.get("pages"))

        self._save_cache()
        if had_pages and self.on_corpus_updated:
            self.on_corpus_updated(self.get_live_documents())
        return True

    # ── Single-Source Live Fetch + Diff ───────────────────────────────────────

    def _fetch_one(
        self,
        client: httpx.Client,
        src: dict[str, Any],
        prev: Optional[dict[str, Any]],
        *,
        force: bool = False,
    ) -> dict[str, Any]:
        did = src["doc_id"]
        url = src["url"]
        now_iso = _utc_now_iso()

        headers = {
            "User-Agent": USER_AGENT,
            "Accept": "application/json" if src.get("kind") == "ntrs_api" else "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        }
        if prev and not force:
            if prev.get("etag"):
                headers["If-None-Match"] = str(prev["etag"])
            if prev.get("last_modified"):
                headers["If-Modified-Since"] = str(prev["last_modified"])

        try:
            resp = client.get(url, headers=headers, follow_redirects=True)
        except Exception as exc:
            err_msg = f"{type(exc).__name__}: {str(exc)[:180]}"
            logger.debug("Live NASA fetch failed for %s (%s): %s", did, url, err_msg)
            return {
                "doc_id": did,
                "outcome": "unreachable",
                "changed": False,
                "checked_at": now_iso,
                "http_status": None,
                "error": err_msg,
            }

        if resp.status_code == 304:
            return {
                "doc_id": did,
                "outcome": "unchanged",
                "changed": False,
                "checked_at": now_iso,
                "http_status": 304,
                "etag": resp.headers.get("etag") or (prev or {}).get("etag"),
                "last_modified": resp.headers.get("last-modified") or (prev or {}).get("last_modified"),
                "error": None,
            }

        if resp.status_code >= 400:
            return {
                "doc_id": did,
                "outcome": "unreachable",
                "changed": False,
                "checked_at": now_iso,
                "http_status": resp.status_code,
                "error": f"HTTP {resp.status_code}",
            }

        raw_bytes = resp.content[:MAX_HTML_BYTES]
        etag = resp.headers.get("etag")
        last_mod = resp.headers.get("last-modified")
        content_type = (resp.headers.get("content-type") or "").lower()

        try:
            if src.get("kind") == "ntrs_api" or "application/json" in content_type:
                parsed = extract_ntrs_api_document(resp.json(), fallback_title=src["title"])
            else:
                text_body = raw_bytes.decode(resp.encoding or "utf-8", errors="replace")
                parsed = extract_html_document(text_body, fallback_title=src["title"])
        except Exception as exc:
            return {
                "doc_id": did,
                "outcome": "unreachable",
                "changed": False,
                "checked_at": now_iso,
                "http_status": resp.status_code,
                "error": f"Parse error: {str(exc)[:140]}",
            }

        pages = parsed.get("pages") or []
        if not pages:
            return {
                "doc_id": did,
                "outcome": "unchanged",
                "changed": False,
                "checked_at": now_iso,
                "http_status": resp.status_code,
                "etag": etag,
                "last_modified": last_mod,
                "error": "No extractable body text returned (page may require JS rendering).",
            }

        title = parsed.get("title") or src["title"]
        new_hash = _compute_pages_hash(title, pages)
        prev_hash = (prev or {}).get("content_hash")
        changed = (new_hash != prev_hash) or not (prev or {}).get("pages")

        return {
            "doc_id": did,
            "outcome": "updated" if changed else "unchanged",
            "changed": changed,
            "checked_at": now_iso,
            "http_status": resp.status_code,
            "etag": etag,
            "last_modified": last_mod,
            "title": title,
            "pages": pages,
            "content_hash": new_hash,
            "meta_modified": parsed.get("meta_modified") or "",
            "error": None,
        }

    # ── Full / Targeted Live Sync ─────────────────────────────────────────────

    def sync_all(
        self,
        *,
        force: bool = False,
        doc_id: Optional[str] = None,
    ) -> dict[str, Any]:
        """Poll NASA websites concurrently, update cache, and rebuild RAG index on changes."""
        with self._sync_lock:
            with self._state_lock:
                self._syncing = True
                if doc_id:
                    target_id = str(doc_id).upper().strip()
                    if target_id not in self._sources:
                        self._syncing = False
                        raise KeyError(f"Unknown live NASA source '{doc_id}'.")
                    targets = [dict(self._sources[target_id])]
                else:
                    targets = [dict(s) for s in self._sources.values()]
                prev_snapshot = {did: dict(self._records.get(did) or {}) for did in self._sources}

            started = time.perf_counter()
            results: list[dict[str, Any]] = []
            try:
                max_workers = min(5, max(1, len(targets)))
                with httpx.Client(timeout=self.timeout_seconds, follow_redirects=True) as client:
                    if max_workers == 1:
                        for src in targets:
                            results.append(self._fetch_one(client, src, prev_snapshot.get(src["doc_id"]), force=force))
                    else:
                        with ThreadPoolExecutor(max_workers=max_workers) as pool:
                            futs = {
                                pool.submit(self._fetch_one, client, src, prev_snapshot.get(src["doc_id"]), force=force): src
                                for src in targets
                            }
                            for fut in as_completed(futs):
                                results.append(fut.result())

                any_changed = False
                updated_ids: list[str] = []
                unchanged_ids: list[str] = []
                unreachable_ids: list[str] = []
                now_iso = _utc_now_iso()

                with self._state_lock:
                    for res in results:
                        did = res["doc_id"]
                        rec = dict(self._records.get(did) or {})
                        rec["last_checked_at"] = res["checked_at"]
                        rec["http_status"] = res.get("http_status")
                        rec["status"] = res["outcome"]
                        rec["error"] = res.get("error")

                        if res.get("etag"):
                            rec["etag"] = res["etag"]
                        if res.get("last_modified"):
                            rec["last_modified"] = res["last_modified"]

                        if res["outcome"] == "updated":
                            any_changed = True
                            updated_ids.append(did)
                            rec["title"] = res["title"]
                            rec["pages"] = res["pages"]
                            rec["content_hash"] = res["content_hash"]
                            rec["last_synced_at"] = res["checked_at"]
                            rec["last_changed_at"] = res["checked_at"]
                            rec["meta_modified"] = res.get("meta_modified") or ""
                        elif res["outcome"] == "unchanged":
                            unchanged_ids.append(did)
                            if rec.get("pages"):
                                rec["last_synced_at"] = res["checked_at"]
                        else:
                            unreachable_ids.append(did)

                        self._records[did] = rec

                    self._last_run_at = now_iso
                    self._last_run_monotonic = time.monotonic()
                    self._sync_runs += 1
                    if any_changed:
                        self._last_update_at = now_iso

                self._save_cache()

                rag_rebuilt = False
                if any_changed and self.on_corpus_updated:
                    live_docs = self.get_live_documents()
                    self.on_corpus_updated(live_docs)
                    rag_rebuilt = True
                    logger.info(
                        "Live NASA sync updated %d source(s) (%s) — RAG pipeline rebuilt.",
                        len(updated_ids),
                        ", ".join(sorted(updated_ids)),
                    )

                elapsed_ms = round((time.perf_counter() - started) * 1000.0, 1)
                return {
                    "synced_at": now_iso,
                    "duration_ms": elapsed_ms,
                    "checked_count": len(results),
                    "updated_count": len(updated_ids),
                    "unchanged_count": len(unchanged_ids),
                    "unreachable_count": len(unreachable_ids),
                    "updated_ids": sorted(updated_ids),
                    "unchanged_ids": sorted(unchanged_ids),
                    "unreachable_ids": sorted(unreachable_ids),
                    "rag_rebuilt": rag_rebuilt,
                    "status": self.get_status(),
                }
            finally:
                with self._state_lock:
                    self._syncing = False

    def maybe_trigger_background_sync(self) -> bool:
        """Non-blocking staleness check: triggers a background sync if interval has elapsed."""
        if not self.enabled:
            return False
        with self._state_lock:
            if self._syncing:
                return False
            now_m = time.monotonic()
            if self._last_run_monotonic > 0 and (now_m - self._last_run_monotonic) < self.interval_seconds:
                return False
            self._last_run_monotonic = now_m

        def _worker() -> None:
            try:
                self.sync_all(force=False)
            except Exception as exc:
                logger.warning("Background NASA live sync error: %s", exc)

        t = threading.Thread(target=_worker, name="nasa-live-sync", daemon=True)
        t.start()
        return True

    # ── Status Inspection ─────────────────────────────────────────────────────

    def get_status(self) -> dict[str, Any]:
        with self._state_lock:
            sources_view: list[dict[str, Any]] = []
            counts = {"updated": 0, "unchanged": 0, "unreachable": 0, "pending": 0}
            active_live_docs = 0

            for did in sorted(self._sources.keys()):
                src = self._sources[did]
                rec = self._records.get(did) or {}
                st = str(rec.get("status") or "pending")
                if st not in counts:
                    counts["pending"] += 1
                else:
                    counts[st] += 1
                page_count = len(rec.get("pages") or [])
                if page_count > 0:
                    active_live_docs += 1
                sources_view.append(
                    {
                        "doc_id": did,
                        "title": rec.get("title") or src["title"],
                        "url": src.get("display_url") or src["url"],
                        "fetch_url": src["url"],
                        "investigation": src.get("investigation"),
                        "kind": src.get("kind"),
                        "builtin": bool(src.get("builtin", True)),
                        "status": st,
                        "http_status": rec.get("http_status"),
                        "page_count": page_count,
                        "content_hash": rec.get("content_hash"),
                        "last_checked_at": rec.get("last_checked_at"),
                        "last_synced_at": rec.get("last_synced_at"),
                        "last_changed_at": rec.get("last_changed_at"),
                        "error": rec.get("error"),
                    }
                )

            return {
                "enabled": self.enabled,
                "syncing": self._syncing,
                "interval_seconds": self.interval_seconds,
                "sync_runs": self._sync_runs,
                "last_run_at": self._last_run_at,
                "last_update_at": self._last_update_at,
                "total_watched_sources": len(sources_view),
                "live_documents_active": active_live_docs,
                "counts": counts,
                "sources": sources_view,
            }
