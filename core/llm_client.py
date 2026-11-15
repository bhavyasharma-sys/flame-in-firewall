"""Multi-provider LLM client for FlameAI.
Provider order: OpenRouter -> Google Gemini -> Groq -> Offline NASA Grounded Synthesizer.
Supports both synchronous generation and token streaming.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any, Generator, Optional

import requests

from config import (
    GEMINI_API_KEY,
    GEMINI_MODEL,
    GROQ_API_KEY,
    GROQ_MODEL,
    OPENAI_API_KEY,
    OPENAI_MODEL,
    OPENROUTER_API_KEY,
    OPENROUTER_MODEL,
    SYSTEM_PROMPT,
)

logger = logging.getLogger(__name__)


def _is_valid_key(key: str) -> bool:
    k = (key or "").strip()
    return bool(k) and not k.startswith("your_")


def _mask_key(key: str) -> str:
    k = (key or "").strip()
    if not _is_valid_key(k):
        return ""
    if len(k) <= 8:
        return "••••"
    return f"{k[:4]}••••{k[-4:]}"


class LLMClient:
    """Unified provider-resilient LLM client with dynamic user credentials & offline NASA grounding."""

    def __init__(self):
        self.openai_key = OPENAI_API_KEY
        self.openrouter_key = OPENROUTER_API_KEY
        self.gemini_key = GEMINI_API_KEY
        self.groq_key = GROQ_API_KEY

        self.openai_model = OPENAI_MODEL
        self.openrouter_model = OPENROUTER_MODEL
        self.gemini_model = GEMINI_MODEL
        self.groq_model = GROQ_MODEL

        self.preferred_provider = "auto"
        self._provider = self._detect_provider()
        logger.info("LLMClient active provider: %s", self._provider)

    def _has_provider_key(self, name: str) -> bool:
        return {
            "openai": _is_valid_key(self.openai_key),
            "openrouter": _is_valid_key(self.openrouter_key),
            "gemini": _is_valid_key(self.gemini_key),
            "groq": _is_valid_key(self.groq_key),
        }.get(name, False)

    def _detect_provider(self) -> str:
        pref = (self.preferred_provider or "auto").strip().lower()
        if pref == "offline_grounded":
            return "offline_grounded"
        if pref in ("openai", "openrouter", "gemini", "groq") and self._has_provider_key(pref):
            return pref
        for cand in ("openai", "openrouter", "gemini", "groq"):
            if self._has_provider_key(cand):
                return cand
        return "offline_grounded"

    def update_credentials(
        self,
        *,
        preferred_provider: Optional[str] = None,
        openai_key: Optional[str] = None,
        gemini_key: Optional[str] = None,
        groq_key: Optional[str] = None,
        openrouter_key: Optional[str] = None,
        openai_model: Optional[str] = None,
        gemini_model: Optional[str] = None,
        groq_model: Optional[str] = None,
        openrouter_model: Optional[str] = None,
    ) -> None:
        if preferred_provider is not None:
            cand = preferred_provider.strip().lower()
            if cand in ("auto", "openai", "gemini", "groq", "openrouter", "offline_grounded"):
                self.preferred_provider = cand
        if openai_key is not None:
            self.openai_key = openai_key.strip() or OPENAI_API_KEY
        if gemini_key is not None:
            self.gemini_key = gemini_key.strip() or GEMINI_API_KEY
        if groq_key is not None:
            self.groq_key = groq_key.strip() or GROQ_API_KEY
        if openrouter_key is not None:
            self.openrouter_key = openrouter_key.strip() or OPENROUTER_API_KEY

        if openai_model is not None and openai_model.strip():
            self.openai_model = openai_model.strip()
        if gemini_model is not None and gemini_model.strip():
            self.gemini_model = gemini_model.strip()
        if groq_model is not None and groq_model.strip():
            self.groq_model = groq_model.strip()
        if openrouter_model is not None and openrouter_model.strip():
            self.openrouter_model = openrouter_model.strip()

        self._provider = self._detect_provider()
        logger.info("LLMClient updated -> active provider: %s", self._provider)

    def get_provider_status(self) -> dict[str, Any]:
        return {
            "active_provider": self._provider,
            "display_label": self.display_label,
            "preferred_provider": self.preferred_provider,
            "providers": {
                "openai": {
                    "configured": self._has_provider_key("openai"),
                    "masked_key": _mask_key(self.openai_key),
                    "model": self.openai_model,
                },
                "gemini": {
                    "configured": self._has_provider_key("gemini"),
                    "masked_key": _mask_key(self.gemini_key),
                    "model": self.gemini_model,
                },
                "groq": {
                    "configured": self._has_provider_key("groq"),
                    "masked_key": _mask_key(self.groq_key),
                    "model": self.groq_model,
                },
                "openrouter": {
                    "configured": self._has_provider_key("openrouter"),
                    "masked_key": _mask_key(self.openrouter_key),
                    "model": self.openrouter_model,
                },
            },
        }

    @property
    def active_provider(self) -> str:
        return self._provider

    @property
    def is_configured(self) -> bool:
        return self._provider != "offline_grounded"

    @property
    def display_label(self) -> str:
        return {
            "openai": f"OpenAI ({self.openai_model})",
            "openrouter": f"OpenRouter ({self.openrouter_model})",
            "gemini": f"Google Gemini ({self.gemini_model})",
            "groq": f"Groq ({self.groq_model})",
            "offline_grounded": "Offline NASA Grounded Engine",
        }.get(self._provider, "Offline NASA Grounded Engine")

    def _provider_order(self) -> list[str]:
        pref = (self.preferred_provider or "auto").strip().lower()
        if pref == "offline_grounded":
            return []
        base = ["openai", "openrouter", "gemini", "groq"]
        if pref in base:
            base.remove(pref)
            return [pref] + base
        return base

    def _stream_with_fallback(
        self,
        full_prompt: str,
        *,
        question: str,
        is_out_of_scope: bool,
        is_brief_query: bool,
        search_results: list[dict[str, Any]],
        matched_runs: list[dict[str, Any]],
        cabin_eval: Optional[dict[str, Any]],
        sources: list[dict[str, str]],
    ) -> Generator[str, None, None]:
        for provider in self._provider_order():
            if not self._has_provider_key(provider):
                continue
            emitted_any = False
            try:
                if provider == "openai":
                    gen = self._stream_openai_compat(
                        "https://api.openai.com/v1/chat/completions",
                        self.openai_key,
                        self.openai_model,
                        full_prompt,
                    )
                elif provider == "openrouter":
                    gen = self._stream_openai_compat(
                        "https://openrouter.ai/api/v1/chat/completions",
                        self.openrouter_key,
                        self.openrouter_model,
                        full_prompt,
                        extra_headers={"HTTP-Referer": "http://localhost:8000", "X-Title": "Ignis"},
                    )
                elif provider == "gemini":
                    gen = self._chunk_stream(self._call_gemini_rest(full_prompt))
                elif provider == "groq":
                    gen = self._stream_openai_compat(
                        "https://api.groq.com/openai/v1/chat/completions",
                        self.groq_key,
                        self.groq_model,
                        full_prompt,
                    )
                else:
                    continue

                for chunk in gen:
                    emitted_any = True
                    yield chunk
                if emitted_any:
                    return
            except Exception as exc:
                logger.warning("Streaming provider %s failed (%s); falling back.", provider, exc)
                if emitted_any:
                    return

        offline_text = self._synthesize_offline(
            question=question,
            is_out_of_scope=is_out_of_scope,
            is_brief_query=is_brief_query,
            search_results=search_results,
            matched_runs=matched_runs,
            cabin_eval=cabin_eval,
            sources=sources,
        )
        yield from self._chunk_stream(offline_text)

    def generate(
        self,
        question: str,
        context: str,
        is_out_of_scope: bool = False,
        is_brief_query: bool = False,
        search_results: Optional[list[dict[str, Any]]] = None,
        matched_runs: Optional[list[dict[str, Any]]] = None,
        cabin_eval: Optional[dict[str, Any]] = None,
        sources: Optional[list[dict[str, str]]] = None,
        stream: bool = False,
    ) -> str | Generator[str, None, None]:
        full_prompt = self._build_prompt(question, context, is_out_of_scope)

        if stream:
            return self._stream_with_fallback(
                full_prompt,
                question=question,
                is_out_of_scope=is_out_of_scope,
                is_brief_query=is_brief_query,
                search_results=search_results or [],
                matched_runs=matched_runs or [],
                cabin_eval=cabin_eval,
                sources=sources or [],
            )

        for provider in self._provider_order():
            if not self._has_provider_key(provider):
                continue
            try:
                if provider == "openai":
                    return self._call_openai_compat(
                        "https://api.openai.com/v1/chat/completions",
                        self.openai_key,
                        self.openai_model,
                        full_prompt,
                    )
                if provider == "openrouter":
                    return self._call_openai_compat(
                        "https://openrouter.ai/api/v1/chat/completions",
                        self.openrouter_key,
                        self.openrouter_model,
                        full_prompt,
                        extra_headers={"HTTP-Referer": "http://localhost:8000", "X-Title": "Ignis"},
                    )
                if provider == "gemini":
                    return self._call_gemini_rest(full_prompt)
                if provider == "groq":
                    return self._call_openai_compat(
                        "https://api.groq.com/openai/v1/chat/completions",
                        self.groq_key,
                        self.groq_model,
                        full_prompt,
                    )
            except Exception as exc:
                logger.warning("Provider %s failed (%s); falling back.", provider, exc)

        # Offline NASA Grounded Synthesizer
        return self._synthesize_offline(
            question=question,
            is_out_of_scope=is_out_of_scope,
            is_brief_query=is_brief_query,
            search_results=search_results or [],
            matched_runs=matched_runs or [],
            cabin_eval=cabin_eval,
            sources=sources or [],
        )

    def _build_prompt(self, question: str, context: str, is_out_of_scope: bool) -> str:
        parts = [SYSTEM_PROMPT, "\n\n---\n"]
        if not is_out_of_scope and context.strip():
            parts.extend(["### RETRIEVED NASA CONTEXT, CORPUS PAGES & TEST RUNS:\n", context, "\n\n---\n"])
        if is_out_of_scope:
            parts.append(
                "NOTE: This query has been classified as OUT OF SCOPE of the NASA microgravity combustion database. "
                "Answer generally, attach NO NASA sources, and end with:\nWarning: This answer is not from the database of NASA.\n\n"
            )
        parts.extend(["### USER QUERY:\n", question, "\n\n### RESPONSE:\n"])
        return "".join(parts)

    def _call_openai_compat(
        self,
        url: str,
        api_key: str,
        model: str,
        prompt: str,
        extra_headers: Optional[dict[str, str]] = None,
    ) -> str:
        headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
        if extra_headers:
            headers.update(extra_headers)
        payload = {
            "model": model,
            "max_tokens": 4096,
            "temperature": 0.25,
            "messages": [{"role": "user", "content": prompt}],
        }
        resp = requests.post(url, headers=headers, json=payload, timeout=60)
        resp.raise_for_status()
        return resp.json()["choices"][0]["message"]["content"]

    def _stream_openai_compat(
        self,
        url: str,
        api_key: str,
        model: str,
        prompt: str,
        extra_headers: Optional[dict[str, str]] = None,
    ) -> Generator[str, None, None]:
        headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
        if extra_headers:
            headers.update(extra_headers)
        payload = {
            "model": model,
            "max_tokens": 4096,
            "temperature": 0.25,
            "stream": True,
            "messages": [{"role": "user", "content": prompt}],
        }
        with requests.post(url, headers=headers, json=payload, timeout=60, stream=True) as resp:
            resp.raise_for_status()
            for raw_line in resp.iter_lines(decode_unicode=True):
                if not raw_line or not raw_line.startswith("data:"):
                    continue
                data_str = raw_line[5:].strip()
                if data_str == "[DONE]":
                    break
                try:
                    chunk = json.loads(data_str)
                    delta = chunk["choices"][0].get("delta", {}).get("content", "")
                    if delta:
                        yield delta
                except Exception:
                    continue

    def _call_gemini_rest(self, prompt: str) -> str:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{self.gemini_model}:generateContent?key={self.gemini_key}"
        payload = {
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {"temperature": 0.25, "maxOutputTokens": 4096},
        }
        resp = requests.post(url, headers={"Content-Type": "application/json"}, json=payload, timeout=60)
        resp.raise_for_status()
        candidates = resp.json().get("candidates") or []
        if not candidates:
            raise RuntimeError("Empty Gemini candidates")
        return "".join(p.get("text", "") for p in candidates[0].get("content", {}).get("parts", []))

    @staticmethod
    def _chunk_stream(text: str, words_per_chunk: int = 8) -> Generator[str, None, None]:
        tokens = re.findall(r"\S+\s*|\n+", text)
        for i in range(0, len(tokens), words_per_chunk):
            yield "".join(tokens[i : i + words_per_chunk])

    # ── Rich Offline NASA Grounded Synthesizer ────────────────────────────────

    def _synthesize_offline(
        self,
        question: str,
        is_out_of_scope: bool,
        is_brief_query: bool,
        search_results: list[dict[str, Any]],
        matched_runs: list[dict[str, Any]],
        cabin_eval: Optional[dict[str, Any]],
        sources: list[dict[str, str]],
    ) -> str:
        if is_out_of_scope:
            return (
                f"Your question **\"{question}\"** falls outside NASA's microgravity combustion and spacecraft fire safety database.\n\n"
                f"I am currently operating in **Offline NASA Grounded Mode** without a live external LLM key configured, so I can only provide deep scientific synthesis on microgravity combustion physics, NASA experiments (BASS, ACME, SAFFIRE, FLEX, SoFIE, SPICE), spacecraft materials, historical spaceflight fires (Apollo 1, Apollo 13, Mir), firefighting spinoffs, and lunar/Martian habitat safety. "
                f"To enable general open-domain answers alongside NASA grounding, configure an `OPENROUTER_API_KEY`, `GEMINI_API_KEY`, or `GROQ_API_KEY` in `.env`.\n\n"
                f"Warning: This answer is not from the database of NASA."
            )

        if is_brief_query:
            return self._synthesize_brief_exhaustive(search_results)

        lines: list[str] = [f"### FlameAI Grounded Synthesis — *{question}*\n"]

        # 1. Active Cabin Scenario Interpretation (if attached)
        if cabin_eval:
            cfg = cabin_eval.get("config", {})
            top_driver = (cabin_eval.get("contributions") or [{}])[0]
            lines.append(
                f"**Active Habitat Scenario Evaluation:** `{cfg.get('fuel_material')}` in "
                f"**{cfg.get('oxygen_pct')}% O₂ / {cfg.get('pressure_kpa')} kPa** at **{cfg.get('gravity_g')} g** "
                f"and **{cfg.get('flow_velocity_cm_s')} cm/s** ventilation ({cfg.get('diluent_gas')} diluent) yields a "
                f"**Fire Risk Index of {cabin_eval.get('risk_index')}/100 ({cabin_eval.get('risk_band')})**, "
                f"estimated **LOI = {cabin_eval.get('estimated_loi_pct')}%** "
                f"(margin `{cabin_eval.get('oxygen_margin_pct'):+.2f}%`), predicted regime **{cabin_eval.get('predicted_regime')}**. "
                f"The dominant Shapley risk driver relative to the ISS baseline is **{top_driver.get('label', 'Oxygen concentration')}** "
                f"(`{top_driver.get('value', 0):+.2f}` risk pts) [DOC-02 p.1] [DOC-05 p.1].\n"
            )

        # 2. Grounded Excerpts from Retrieved NASA Corpus & KB Chunks
        evidence_bullets: list[str] = []
        seen_snippets: set[str] = set()
        for hit in search_results[:6]:
            meta = hit.get("metadata", {})
            cite_tag = meta.get("cite_tag") or (
                f"[{meta['doc_id']} p.{meta.get('page', 1)}]" if meta.get("doc_id") else ""
            )
            raw_text = hit.get("text", "")
            # Pull the sharpest informative sentences from the chunk
            cleaned_lines = [
                ln.strip()
                for ln in raw_text.split("\n")
                if ln.strip()
                and not ln.strip().startswith("#")
                and not ln.strip().startswith(">")
                and not re.match(r"^\[[A-Za-z0-9_-]+\s+p\.\d+\]", ln.strip())
                and not ln.strip().lower().startswith("entity:")
            ]
            snippet = " ".join(cleaned_lines)[:310].strip()
            if snippet and snippet[:70] not in seen_snippets:
                seen_snippets.add(snippet[:70])
                # Ensure ends cleanly
                if not snippet.endswith("."):
                    last_dot = snippet.rfind(".")
                    if last_dot > 100:
                        snippet = snippet[: last_dot + 1]
                    else:
                        snippet = snippet.rstrip(",;:") + "."
                tag_suffix = f" {cite_tag}" if cite_tag and cite_tag not in snippet else ""
                title = meta.get("experiment_name") or "NASA Record"
                evidence_bullets.append(f"- **{title}:** {snippet}{tag_suffix}")
            if len(evidence_bullets) >= 4:
                break

        if evidence_bullets:
            lines.append("#### 1. NASA Empirical Findings & Physics Summary")
            lines.extend(evidence_bullets)
            lines.append("")

        # 3. Matched Structured Test Runs ([EXP-XXXX])
        if matched_runs:
            lines.append("#### 2. Matching Experimental Test Runs")
            for run in matched_runs[:4]:
                eid = run.get("experiment_id")
                lines.append(
                    f"- **[{eid}]** ({run.get('program')}, {run.get('fuel_material')} {run.get('fuel_geometry')}): "
                    f"**{run.get('combustion_regime')}** at {run.get('oxygen_pct')}% O₂, {run.get('pressure_kpa')} kPa, "
                    f"{run.get('flow_velocity_cm_s')} cm/s, {run.get('gravity_g')} g "
                    f"(LOI={run.get('limiting_oxygen_index_pct') or 'N/A'}%, "
                    f"peak flux={run.get('peak_radiative_flux_kw_m2') or 'N/A'} kW/m²) "
                    f"[{run.get('source_doc_id')} p.{run.get('source_page')}] [{eid}]."
                )
            lines.append("")

        # 4. Operational Fire-Safety Interpretation
        lines.append("#### 3. Operational Fire Safety Interpretation (ISS / Moon / Mars)")
        lines.append(
            "- **Immediate Ventilation Cutoff:** In microgravity, low-speed cabin HVAC (~5–12 cm/s) sits at the bottom of the U-shaped LOI curve (the ventilation paradox); shutting down circulation fans removes oxidizer transport and induces radiative quenching [DOC-01 p.1] [DOC-01 p.3]."
        )
        lines.append(
            "- **Exploration Atmosphere Margin (Artemis 34% O₂ / 56.5 kPa):** Enriched oxygen and partial gravity (0.16 g Moon / 0.38 g Mars) significantly lower ignition thresholds; materials qualified at 21% O₂ on Earth must be re-tested under NASA-STD-6001B [DOC-02 p.1] [DOC-05 p.2]."
        )
        lines.append(
            "- **Detection & Post-Extinction Watch:** Microgravity fires generate larger soot aggregates (>300 nm) and can persist as invisible ~650 K cool flames; use dual-wavelength photoelectric smoke detectors inside return ducts and maintain thermal-camera quarantine before restoring airflow [DOC-03 p.2] [DOC-06 p.2]."
        )

        return "\n".join(lines)

    @staticmethod
    def _synthesize_brief_exhaustive(search_results: list[dict[str, Any]]) -> str:
        lines = [
            "### Exhaustive Extraction — NASA Space Apps 2026 Challenge Brief (`Flame in Freefall`)\n",
            "Below is the complete, non-truncated enumeration of every requirement, mandatory AI job, physics benchmark, and judging criterion in the official Challenge Brief:\n",
        ]
        idx = 1
        for hit in search_results:
            if hit.get("metadata", {}).get("source") != "challenge_brief.json" and hit.get("metadata", {}).get("doc_id") != "DOC-BRIEF":
                continue
            for raw_line in hit.get("text", "").split("\n"):
                cleaned = raw_line.strip().lstrip("-• ").strip()
                if not cleaned or cleaned.startswith("#") or cleaned.lower().startswith("entity:") or cleaned.lower().startswith("key findings:") or cleaned.lower().startswith("safety implications:"):
                    continue
                if len(cleaned) > 15:
                    lines.append(f"{idx}. {cleaned} [DOC-BRIEF p.1]")
                    idx += 1
        return "\n".join(lines)
