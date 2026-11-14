"""Hybrid Graph-RAG + RRF + Scenario-Aware + Citation-Audited Pipeline for FlameAI."""

from __future__ import annotations

import logging
import re
from typing import Any, Generator, Optional

import networkx as nx

from config import BRIEF_MAX_CONTEXT_CHARS, MAX_CONTEXT_CHARS, TOP_K_RESULTS
from core.chart_generator import detect_and_generate_chart
from core.citations import audit_citations
from core.knowledge_graph import KnowledgeGraph
from core.llm_client import LLMClient
from core.memory import ConversationMemory
from core.vectorstore import VectorStore
from domain.fire_risk import evaluate_cabin
from domain.scenario_ranker import rank_runs
from domain.types import CabinParams

logger = logging.getLogger(__name__)

# Word-boundary domain keywords so "bass guitar" or "flexible schedule" are NOT misclassified!
_DOMAIN_PATTERNS = [
    re.compile(r"\b(microgravity|zero[\s\-]?g|0[\s\-]?g|partial[\s\-]?gravity|reduced[\s\-]?gravity|freefall|buoyancy|buoyant)\b", re.I),
    re.compile(r"\b(flame|flames|fire|combustion|ignition|extinction|extinguish|quench|quenching|smoulder|smolder|pyrolysis|soot|smoke|burn|burning|flammability|flammable|loi|limiting\s+oxygen)\b", re.I),
    re.compile(r"\b(spacecraft|habitat|iss|lunar|moon|mars|martian|artemis|cygnus|shuttle|skylab|mir|apollo\s*1|apollo\s*13|astronaut|crew|eclss|spacesuit|cabin|ventilation|hvac|airflow)\b", re.I),
    re.compile(r"\b(saffire|sofie|acme|spice|same|daft|slice|nasa|ntrs|psi|std[\s\-]?6001|6001b|glenn)\b", re.I),
    re.compile(r"\b(bass[\s\-]?ii|bass\s+(?:experiment|investigation|solid|flame|test)|flex[\s\-]?2|flex\s+(?:experiment|droplet|cool|flame))\b", re.I),
    re.compile(r"\b(pmma|plexiglass|nomex|kapton|teflon|ptfe|sibal|cotton[\s\-]?fiberglass|silicone|polyethylene|velcro|nylon[\s\-]?6|heptane|methanol|diluent|radiative|cool[\s\-]?flame|droplet)\b", re.I),
    re.compile(r"\b(exp[\s\-]?\d{4}|doc[\s\-]?\d{2}|shapley|spinoff|scba|turnout\s+gear|challenge\s+brief|space\s+apps|1gnufsb96)\b", re.I),
    re.compile(r"\b(oxygen|o2|co2|kpa|psia|pressure|detector|photoelectric|ionization|suppress|suppression|extinguisher|water\s+mist|electrostatic|e[\s\-]?field)\b", re.I),
]

_ANTI_DOMAIN_RE = re.compile(r"\b(bass\s+guitar|sea\s+bass|bass\s+fishing|bass\s+player|flexible\s+(?:work|schedule|hours|diet))\b", re.I)

_BRIEF_TRIGGERS = (
    "1gnufsb96",
    "challenge brief",
    "challenge_brief",
    "docs.google.com",
    "challenge document",
    "judging criteria",
    "mandatory ai jobs",
    "three mandatory",
)


class RAGPipeline:
    """End-to-end Graph-RAG + Hybrid RRF + Structured Run Lookup + Citation Audit pipeline."""

    def __init__(
        self,
        vectorstore: VectorStore,
        knowledge_graph: KnowledgeGraph,
        llm_client: LLMClient,
        memory: ConversationMemory,
        all_data: dict[str, Any],
    ):
        self.vectorstore = vectorstore
        self.knowledge_graph = knowledge_graph
        self.llm = llm_client
        self.memory = memory
        self.all_data = all_data

        # Precompute valid citation sets for sentence-level verification
        self._valid_doc_pages: set[tuple[str, int]] = set()
        self._valid_doc_ids: set[str] = set()
        self._valid_exp_ids: set[str] = set()
        self.refresh_valid_citations()

    def refresh_valid_citations(self, all_data: Optional[dict[str, Any]] = None) -> None:
        """Refresh valid [DOC-XX p.Y] / [LIVE-XX p.Y] / [EXP-XXXX] citation sets after corpus updates."""
        if all_data is not None:
            self.all_data = all_data
        valid_pages: set[tuple[str, int]] = set()
        valid_ids: set[str] = set()
        for doc in self.all_data.get("documents") or []:
            did = str(doc.get("doc_id") or "").upper()
            if did:
                valid_ids.add(did)
                for p in doc.get("pages") or []:
                    valid_pages.add((did, int(p.get("page", 1))))
        valid_exps: set[str] = {
            str(r.get("experiment_id") or "").upper()
            for r in (self.all_data.get("test_runs") or [])
            if r.get("experiment_id")
        }
        self._valid_doc_pages = valid_pages
        self._valid_doc_ids = valid_ids
        self._valid_exp_ids = valid_exps

    # ── Domain & Intent Classification ────────────────────────────────────────

    def _is_in_domain(self, question: str) -> bool:
        if _ANTI_DOMAIN_RE.search(question):
            # Only in domain if another unmistakable space/combustion cue is also present
            if not re.search(r"\b(nasa|microgravity|spacecraft|combustion|flame|fire|iss)\b", question, re.I):
                return False
        return any(p.search(question) for p in _DOMAIN_PATTERNS)

    def _evaluate_conversational_intent(self, question: str) -> Optional[dict[str, Any]]:
        q_clean = re.sub(r"[^\w\s]", "", question.strip().lower()).strip()
        greetings = {
            "hi", "helo", "hello", "hey", "hiya", "howdy", "sup", "yo", "greetings",
            "good morning", "good afternoon", "good evening", "hey there", "hello there",
        }
        if q_clean in greetings or re.match(r"^(hi|helo|hello|hey|howdy)(\s+(there|flameai|bot|assistant))?$", q_clean):
            answer = (
                "Hello! I am **FlameAI**, your NASA Space Apps 2026 Super-Intelligence assistant for microgravity combustion science and spacecraft fire safety.\n\n"
                "Here is what I can do right now:\n"
                "- **Summarise & Cite:** Grounded insights from NASA PSI/NTRS papers (`[DOC-01 p.1]`…`[DOC-08 p.2]`) and 50 test runs (`[EXP-0001]`…`[EXP-0050]`).\n"
                "- **Interpret Active Cabins:** Toggle **Attach Active Cabin Scenario** to get Shapley risk analysis for your live O₂, pressure, airflow, and gravity settings.\n"
                "- **Generate Scientific Charts:** Ask me to *plot the ventilation paradox*, *chart FLEX-2 cool flames*, *plot material flammability*, or *graph EXP-0031*.\n"
                "- **Explore Incidents & Spinoffs:** Ask about Apollo 1, Apollo 13, Mir fire lessons, or NASA firefighting spinoffs.\n\n"
                "What would you like to investigate?"
            )
            return self._empty_response(answer, intent="greeting")

        if q_clean in {"who are you", "what are you", "what can you do", "help", "about", "what is flame in freefall"}:
            answer = (
                "I am **FlameAI** inside **Flame in Freefall v3.0** — unifying Team Eagle20's Graph-RAG dashboard with 3D WebGL2 volumetric flame simulation, exact Shapley fire-risk attribution, 50-run telemetry ranking, and sentence-level citation verification.\n\n"
                "Try asking:\n"
                "- *Why does the BASS-II ventilation paradox make weak airflow dangerous?*\n"
                "- *Plot the ventilation paradox curve and explain fan shutdown.*\n"
                "- *Compare PMMA and Nomex in an Artemis 34% O₂ lunar habitat.*\n"
                "- *What lessons came from Apollo 1, Apollo 13, and Space Station Mir?*"
            )
            return self._empty_response(answer, intent="help")

        if q_clean in {"thanks", "thank you", "thx", "bye", "goodbye", "ok", "okay", "great", "awesome", "got it"}:
            return self._empty_response(
                "You're welcome! Let me know if you want to explore another NASA combustion investigation, telemetry trace, or cabin atmosphere.",
                intent="closing",
            )
        return None

    @staticmethod
    def _empty_response(answer: str, intent: str = "conversational") -> dict[str, Any]:
        return {
            "answer": answer,
            "sources": [],
            "evidence": [],
            "kg_context": "",
            "chart": None,
            "citations": {
                "verified_doc_citations": [],
                "verified_exp_citations": [],
                "dropped_claims": [],
                "grounding_pct": 100.0,
                "checked_sentences": 0,
                "cited_sentences": 0,
            },
            "out_of_scope": False,
            "intent": intent,
        }

    # ── Structured Test-Run Lookup (SQL-tool equivalent) ──────────────────────

    def _lookup_relevant_runs(
        self, question: str, scenario: Optional[dict[str, Any]] = None
    ) -> list[dict[str, Any]]:
        runs = self.all_data.get("test_runs") or []
        if not runs:
            return []

        q = question.lower()
        explicit_ids = {m.upper() for m in re.findall(r"\b(EXP-\d{4})\b", question, re.I)}
        if explicit_ids:
            exact = [r for r in runs if str(r.get("experiment_id", "")).upper() in explicit_ids]
            if exact:
                return exact[:6]

        # If a cabin scenario is attached, use the scenario ranker!
        if scenario:
            ranked = rank_runs(runs, scenario, limit=5)
            return [r.record for r in ranked]

        # Keyword filter by program / material / regime
        filtered = []
        for r in runs:
            score = 0
            prog = str(r.get("program") or "").lower()
            mat = str(r.get("fuel_material") or "").lower()
            reg = str(r.get("combustion_regime") or "").lower()
            if prog and prog in q:
                score += 3
            if mat and any(tok in q for tok in mat.split("-")):
                score += 3
            if "cool" in q and "cool" in reg:
                score += 4
            if "lunar" in q and abs(float(r.get("gravity_g") or 0) - 0.16) < 0.05:
                score += 3
            if "mars" in q and abs(float(r.get("gravity_g") or 0) - 0.38) < 0.05:
                score += 3
            if "34%" in q and float(r.get("oxygen_pct") or 0) >= 30:
                score += 2
            if score > 0:
                filtered.append((score, r))

        filtered.sort(key=lambda x: x[0], reverse=True)
        return [r for _, r in filtered[:5]]

    # ── Prepare Retrieval Context ─────────────────────────────────────────────

    def _prepare_query(
        self,
        user_question: str,
        top_k: int = TOP_K_RESULTS,
        scenario: Optional[dict[str, Any]] = None,
        memory_override: Optional[ConversationMemory] = None,
    ) -> dict[str, Any]:
        active_memory = memory_override or self.memory
        is_brief = any(t in user_question.lower() for t in _BRIEF_TRIGGERS)
        in_domain = is_brief or bool(scenario) or self._is_in_domain(user_question)

        # If a brand-new NASA topic/payload appeared via live NASA web sync, allow strong live lexical hits
        if not in_domain and not _ANTI_DOMAIN_RE.search(user_question):
            probe = self.vectorstore.search(user_question, top_k=3)
            if any(
                hit.get("metadata", {}).get("is_live") and float(hit.get("bm25_score") or 0.0) >= 6.5
                for hit in probe
            ):
                in_domain = True

        if not in_domain:
            return {
                "out_of_scope": True,
                "is_brief": False,
                "search_results": [],
                "matched_runs": [],
                "kg_context": "",
                "kg_fact_count": 0,
                "cabin_eval": None,
                "context": "",
                "sources": [],
                "evidence": [],
                "chart": None,
            }

        # 1. Hybrid vector + BM25 RRF retrieval
        eff_k = max(top_k, 12) if is_brief else top_k
        search_results = self.vectorstore.search(user_question, top_k=eff_k)
        if is_brief:
            brief_chunks = self.vectorstore.get_documents_by_source("challenge_brief.json")
            seen = {b["text"] for b in brief_chunks}
            search_results = brief_chunks + [r for r in search_results if r["text"] not in seen]

        # 2. Knowledge Graph traversal
        kg_subgraph = self._query_knowledge_graph(user_question)
        kg_context = self.knowledge_graph.to_context_string(kg_subgraph) if kg_subgraph else ""
        kg_fact_count = min(kg_subgraph.number_of_edges(), 25) if kg_subgraph else 0

        # 3. Structured run lookup
        matched_runs = self._lookup_relevant_runs(user_question, scenario=scenario)

        # 4. Active Cabin Scenario physics + Shapley
        cabin_eval = None
        cabin_ctx = ""
        if scenario:
            try:
                cp = CabinParams(
                    oxygen_pct=float(scenario.get("oxygen_pct", 21.0)),
                    pressure_kpa=float(scenario.get("pressure_kpa", 101.3)),
                    flow_velocity_cm_s=float(scenario.get("flow_velocity_cm_s", 10.0)),
                    gravity_g=float(scenario.get("gravity_g", 0.0)),
                    fuel_material=str(scenario.get("fuel_material", "Cotton-Fiberglass")),
                    diluent_gas=str(scenario.get("diluent_gas", "N2")),
                )
                res = evaluate_cabin(cp)
                cabin_eval = {"config": cp.to_dict(), **res.to_dict()}
                contrib_str = ", ".join(f"{c.label}: {c.value:+.2f}" for c in res.contributions)
                cabin_ctx = (
                    f"## Active Habitat Cabin Scenario:\n"
                    f"Config: {cp.fuel_material}, {cp.oxygen_pct}% O2, {cp.pressure_kpa} kPa, "
                    f"{cp.flow_velocity_cm_s} cm/s, {cp.gravity_g} g, diluent={cp.diluent_gas}\n"
                    f"Physics: LOI={res.estimated_loi_pct}%, O2 Margin={res.oxygen_margin_pct:+.2f}%, "
                    f"Regime={res.predicted_regime}, Fire Risk Index={res.risk_index}/100 ({res.risk_band}), "
                    f"u_eff={res.u_eff_cm_s} cm/s\n"
                    f"Exact Shapley Drivers vs ISS Baseline: {contrib_str}"
                )
            except Exception as exc:
                logger.warning("Failed evaluating attached scenario: %s", exc)

        # 5. Format combined context bounded by operational safeguard
        vs_ctx = self._format_vector_results(search_results)
        runs_ctx = self._format_runs_context(matched_runs)
        mem_ctx = active_memory.get_recent_context(n=4)
        sections = [s for s in (cabin_ctx, vs_ctx, runs_ctx, kg_context, mem_ctx) if s]
        combined = "\n\n".join(sections)
        limit = BRIEF_MAX_CONTEXT_CHARS if is_brief else MAX_CONTEXT_CHARS
        if len(combined) > limit:
            combined = combined[:limit]

        # 6. Sources, structured evidence cards, and optional in-chat Matplotlib chart
        sources = self._extract_sources(search_results, matched_runs)
        evidence = self._extract_evidence(search_results, matched_runs)
        chart = detect_and_generate_chart(
            user_question,
            self.all_data.get("experiments") or [],
            self.all_data.get("test_runs") or [],
            self.all_data.get("telemetry") or {},
        )

        return {
            "out_of_scope": False,
            "is_brief": is_brief,
            "search_results": search_results,
            "matched_runs": matched_runs,
            "kg_context": kg_context,
            "kg_fact_count": kg_fact_count,
            "cabin_eval": cabin_eval,
            "context": combined,
            "sources": sources,
            "evidence": evidence,
            "chart": chart,
        }

    # ── Sync Query ────────────────────────────────────────────────────────────

    def query(
        self,
        user_question: str,
        top_k: int = TOP_K_RESULTS,
        scenario: Optional[dict[str, Any]] = None,
        memory_override: Optional[ConversationMemory] = None,
    ) -> dict[str, Any]:
        active_memory = memory_override or self.memory
        conv = self._evaluate_conversational_intent(user_question)
        if conv is not None:
            active_memory.add_turn(user_question, conv["answer"], [])
            conv["provider"] = self.llm.display_label
            return conv

        prep = self._prepare_query(
            user_question, top_k=top_k, scenario=scenario, memory_override=active_memory
        )
        answer = str(
            self.llm.generate(
                question=user_question,
                context=prep["context"],
                is_out_of_scope=prep["out_of_scope"],
                is_brief_query=prep["is_brief"],
                search_results=prep["search_results"],
                matched_runs=prep["matched_runs"],
                cabin_eval=prep["cabin_eval"],
                sources=prep["sources"],
                stream=False,
            )
        )

        # Enforce mandatory out-of-scope disclaimer if an LLM forgot it
        if prep["out_of_scope"] and "Warning: This answer is not from the database of NASA." not in answer:
            answer = answer.rstrip() + "\n\nWarning: This answer is not from the database of NASA."

        citations = (
            {
                "verified_doc_citations": [],
                "verified_exp_citations": [],
                "dropped_claims": [],
                "grounding_pct": 0.0,
                "checked_sentences": 0,
                "cited_sentences": 0,
            }
            if prep["out_of_scope"]
            else audit_citations(answer, self._valid_doc_pages, self._valid_doc_ids, self._valid_exp_ids)
        )

        active_memory.add_turn(user_question, answer, prep["sources"])

        return {
            "answer": answer,
            "sources": prep["sources"],
            "evidence": prep["evidence"],
            "kg_context": prep["kg_context"],
            "kg_fact_count": prep["kg_fact_count"],
            "chart": prep["chart"],
            "citations": citations,
            "cabin_eval": prep["cabin_eval"],
            "out_of_scope": prep["out_of_scope"],
            "provider": self.llm.display_label,
        }

    # ── SSE Streaming Query ───────────────────────────────────────────────────

    def stream_query(
        self,
        user_question: str,
        top_k: int = TOP_K_RESULTS,
        scenario: Optional[dict[str, Any]] = None,
        memory_override: Optional[ConversationMemory] = None,
    ) -> Generator[dict[str, Any], None, None]:
        """Yield SSE event dictionaries: sources -> chart -> token* -> audit -> done."""
        active_memory = memory_override or self.memory
        conv = self._evaluate_conversational_intent(user_question)
        if conv is not None:
            yield {
                "event": "sources",
                "data": {"sources": [], "evidence": [], "out_of_scope": False, "kg_fact_count": 0},
            }
            yield {"event": "token", "data": {"token": conv["answer"]}}
            yield {
                "event": "audit",
                "data": {
                    **conv["citations"],
                    "provider": self.llm.display_label,
                    "out_of_scope": False,
                },
            }
            yield {
                "event": "done",
                "data": {"provider": self.llm.display_label, "final_answer": conv["answer"]},
            }
            active_memory.add_turn(user_question, conv["answer"], [])
            return

        prep = self._prepare_query(
            user_question, top_k=top_k, scenario=scenario, memory_override=active_memory
        )
        yield {
            "event": "sources",
            "data": {
                "sources": prep["sources"],
                "evidence": prep["evidence"],
                "out_of_scope": prep["out_of_scope"],
                "kg_fact_count": prep["kg_fact_count"],
                "cabin_eval": prep["cabin_eval"],
            },
        }
        if prep["chart"]:
            yield {"event": "chart", "data": prep["chart"]}

        token_gen = self.llm.generate(
            question=user_question,
            context=prep["context"],
            is_out_of_scope=prep["out_of_scope"],
            is_brief_query=prep["is_brief"],
            search_results=prep["search_results"],
            matched_runs=prep["matched_runs"],
            cabin_eval=prep["cabin_eval"],
            sources=prep["sources"],
            stream=True,
        )

        collected: list[str] = []
        if isinstance(token_gen, str):
            collected.append(token_gen)
            yield {"event": "token", "data": {"token": token_gen}}
        else:
            for piece in token_gen:
                collected.append(piece)
                yield {"event": "token", "data": {"token": piece}}

        full_answer = "".join(collected)
        if prep["out_of_scope"] and "Warning: This answer is not from the database of NASA." not in full_answer:
            suffix = "\n\nWarning: This answer is not from the database of NASA."
            full_answer += suffix
            yield {"event": "token", "data": {"token": suffix}}

        citations = (
            {
                "verified_doc_citations": [],
                "verified_exp_citations": [],
                "dropped_claims": [],
                "grounding_pct": 0.0,
                "checked_sentences": 0,
                "cited_sentences": 0,
            }
            if prep["out_of_scope"]
            else audit_citations(full_answer, self._valid_doc_pages, self._valid_doc_ids, self._valid_exp_ids)
        )
        yield {
            "event": "audit",
            "data": {
                **citations,
                "provider": self.llm.display_label,
                "out_of_scope": prep["out_of_scope"],
            },
        }
        yield {
            "event": "done",
            "data": {"provider": self.llm.display_label, "final_answer": full_answer},
        }
        active_memory.add_turn(user_question, full_answer, prep["sources"])

    # ── Helpers ───────────────────────────────────────────────────────────────

    def _query_knowledge_graph(self, question: str) -> Optional[nx.DiGraph]:
        q_low = question.lower()
        matched: list[str] = []
        for node in self.knowledge_graph.graph.nodes:
            nl = str(node).lower()
            if 3 <= len(nl) <= 45 and re.search(rf"\b{re.escape(nl)}\b", q_low):
                matched.append(node)
        if not matched:
            return None
        combined = nx.DiGraph()
        for node in matched[:4]:
            sg = self.knowledge_graph.query_related(node, depth=2)
            if sg:
                combined = nx.compose(combined, sg)
        return combined if combined.number_of_nodes() > 0 else None

    @staticmethod
    def get_source_url(name: str = "", source: str = "", extra: str = "") -> str:
        combined = f"{name} {source} {extra}".lower()
        if any(w in combined for w in ("1gnufsb96", "challenge_brief", "challenge brief", "doc-brief")):
            return "https://docs.google.com/document/d/1gnuFsb96_K2457aZGRiJVGeAuKk-xj8Zh7okbYMtC0U/edit"
        if "bass" in combined or "opposed-flow" in combined or "opposed flow" in combined or "ventilation paradox" in combined:
            return "https://psi.nasa.gov/investigation/BASS"
        if "acme" in combined or "spherical gaseous" in combined:
            return "https://psi.nasa.gov/investigation/ACME"
        if "saffire" in combined:
            return "https://ntrs.nasa.gov/citations/20160005234"
        if "flex" in combined or "cool flame" in combined or "droplet" in combined:
            return "https://psi.nasa.gov/investigation/FLEX"
        if "sofie" in combined:
            return "https://psi.nasa.gov/investigation/SoFIE"
        if "spice" in combined or "same" in combined or "smoke" in combined or "soot" in combined:
            return "https://psi.nasa.gov/investigation/SPICE"
        if "apollo" in combined or "mir" in combined or "incident" in combined:
            return "https://sma.nasa.gov/sma-disciplines/accllp/apollo-1"
        if "spinoff" in combined or "scba" in combined or "firefighting" in combined or "daft" in combined:
            return "https://spinoff.nasa.gov/node/9582"
        if any(w in combined for w in ("partial gravity", "lunar", "martian", "mars", "artemis", "slice", "researcher", "iss")):
            return "https://www.nasa.gov/missions/station/a-researchers-guide-to-combustion-science/"
        if any(w in combined for w in ("material", "polymer", "acrylic", "pmma", "nomex", "teflon", "kapton", "kevlar", "flammability", "std-6001", "guideline", "safety", "oxygen", "co2", "diluent")):
            return "https://standards.nasa.gov/standard/nasa/nasa-std-6001"
        return "https://www.nasa.gov/glenn/glenn-expertise-space-exploration/physical-sciences-program/combustion-science/"

    @staticmethod
    def get_source_pdf(doc_id: str = "", name: str = "", source: str = "", extra: str = "") -> Optional[str]:
        doc_pdf_map = {
            "DOC-01": "nasa_glenn_bass.pdf",
            "DOC-02": "nasa_glenn_saffire.pdf",
            "DOC-03": "nasa_glenn_flex.pdf",
            "DOC-04": "nasa_glenn_acme.pdf",
            "DOC-05": "nasa_glenn_slice.pdf",
            "DOC-06": "iss_researchers_guide_combustion_science.pdf",
            "DOC-07": "nasa_glenn_same.pdf",
            "DOC-08": "nasa_glenn_daft.pdf",
            "ISS-ACME": "nasa_glenn_acme.pdf",
            "ISS-BASS-II": "nasa_glenn_bass.pdf",
            "ISS-FLEX": "nasa_glenn_flex.pdf",
            "ISS-SOFIE": "nasa_glenn_spice.pdf",
            "DOC-BRIEF": "iss_researchers_guide_combustion_science.pdf",
        }
        did = str(doc_id or "").upper().strip()
        if did in doc_pdf_map:
            return f"/papers/{doc_pdf_map[did]}"
        combined = f"{name} {source} {extra}".lower()
        if "bass" in combined or "opposed-flow" in combined or "opposed flow" in combined or "ventilation" in combined:
            return "/papers/nasa_glenn_bass.pdf"
        if "saffire" in combined or "cygnus" in combined:
            return "/papers/nasa_glenn_saffire.pdf"
        if "flex" in combined or "cool flame" in combined or "droplet" in combined:
            return "/papers/nasa_glenn_flex.pdf"
        if "acme" in combined or "gaseous" in combined:
            return "/papers/nasa_glenn_acme.pdf"
        if "spice" in combined or "sofie" in combined:
            return "/papers/nasa_glenn_spice.pdf"
        if "slice" in combined or "partial gravity" in combined or "lunar" in combined or "mars" in combined or "martian" in combined:
            return "/papers/nasa_glenn_slice.pdf"
        if "same" in combined or "smoke" in combined or "soot" in combined or "detector" in combined or "apollo" in combined or "mir" in combined:
            return "/papers/nasa_glenn_same.pdf"
        if "daft" in combined or "spinoff" in combined or "firefighting" in combined:
            return "/papers/nasa_glenn_daft.pdf"
        return "/papers/iss_researchers_guide_combustion_science.pdf"

    @staticmethod
    def _format_vector_results(results: list[dict[str, Any]]) -> str:
        if not results:
            return ""
        parts = ["## Retrieved NASA Research Chunks:\n"]
        for doc in results:
            meta = doc.get("metadata", {})
            title = meta.get("experiment_name") or "NASA Record"
            raw_url = str(meta.get("url") or "")
            extra = f"{meta.get('source_experiment', '')} {meta.get('investigation', '')}"
            url = raw_url if raw_url.startswith("http") else RAGPipeline.get_source_url(str(title), str(meta.get("source", "")), extra)
            tag = meta.get("cite_tag") or ""
            parts.append(f"Tag: {tag}\nSource Title: {title}\nSource URL: {url}\nContent: {doc.get('text', '').strip()}\n")
        return "\n".join(parts)

    @staticmethod
    def _format_runs_context(runs: list[dict[str, Any]]) -> str:
        if not runs:
            return ""
        lines = ["## Matched Structured NASA Test Runs:"]
        for r in runs:
            lines.append(
                f"- [{r['experiment_id']}] {r['program']} | {r['fuel_material']} ({r.get('fuel_geometry')}) | "
                f"{r['oxygen_pct']}% O2, {r['pressure_kpa']} kPa, {r['flow_velocity_cm_s']} cm/s, {r['gravity_g']} g | "
                f"Regime: {r['combustion_regime']} | LOI: {r.get('limiting_oxygen_index_pct')}% | "
                f"Flux: {r.get('peak_radiative_flux_kw_m2')} kW/m2 | Source: [{r.get('source_doc_id')} p.{r.get('source_page')}]"
            )
        return "\n".join(lines)

    @staticmethod
    def _extract_sources(
        results: list[dict[str, Any]], matched_runs: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        sources: list[dict[str, Any]] = []
        seen: set[str] = set()
        for r in results:
            meta = r.get("metadata", {})
            title = str(meta.get("experiment_name") or "NASA Combustion Record")
            doc_id = str(meta.get("doc_id") or "")
            page = meta.get("page")
            extra = f"{meta.get('source_experiment', '')} {meta.get('investigation', '')}"
            raw_url = str(meta.get("url") or "").strip()

            pdf_file = str(meta.get("pdf_file") or "").strip()
            is_live = bool(meta.get("is_live") or meta.get("category") == "live_web")
            if raw_url.startswith("/papers/"):
                pdf_url = raw_url
                web_url = RAGPipeline.get_source_url(title, str(meta.get("source", "")), extra)
            else:
                web_url = raw_url if raw_url.startswith("http") else RAGPipeline.get_source_url(title, str(meta.get("source", "")), extra)
                if pdf_file:
                    pdf_url = f"/papers/{pdf_file}"
                elif is_live:
                    pdf_url = None
                else:
                    pdf_url = RAGPipeline.get_source_pdf(doc_id, title, str(meta.get("source", "")), extra)

            pdf_name = pdf_url.rsplit("/", 1)[-1] if pdf_url else None
            key = f"{doc_id or title}:{page or ''}"
            if key in seen:
                continue
            seen.add(key)
            sources.append(
                {
                    "title": title,
                    "url": web_url,
                    "pdf_url": pdf_url,
                    "pdf_name": pdf_name,
                    "doc_id": doc_id or None,
                    "page": int(page) if page else None,
                    "is_live": is_live,
                    "last_synced_at": meta.get("last_synced_at") or None,
                    "cite_tag": meta.get("cite_tag") or (f"[{doc_id} p.{page}]" if doc_id and page else None),
                }
            )
        for run in matched_runs[:3]:
            eid = str(run.get("experiment_id") or "")
            if eid and eid not in seen:
                seen.add(eid)
                prog = str(run.get("program") or "")
                sdoc = str(run.get("source_doc_id") or "")
                pdf_url = RAGPipeline.get_source_pdf(sdoc, prog)
                sources.append(
                    {
                        "title": f"{eid} ({prog} — {run.get('fuel_material')})",
                        "url": RAGPipeline.get_source_url(prog),
                        "pdf_url": pdf_url,
                        "pdf_name": pdf_url.rsplit("/", 1)[-1] if pdf_url else None,
                        "doc_id": sdoc or None,
                        "page": run.get("source_page"),
                        "experiment_id": eid,
                        "cite_tag": f"[{eid}]",
                    }
                )
        return sources[:8]

    @staticmethod
    def _extract_evidence(
        results: list[dict[str, Any]], matched_runs: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        for r in results[:5]:
            meta = r.get("metadata", {})
            items.append(
                {
                    "cite_tag": meta.get("cite_tag") or meta.get("source", "NASA"),
                    "title": meta.get("experiment_name") or "NASA Record",
                    "doc_id": meta.get("doc_id") or None,
                    "page": meta.get("page") or None,
                    "experiment_id": meta.get("experiment_id") or None,
                    "score": r.get("score", 0.0),
                    "snippet": str(r.get("text") or "")[:240].strip(),
                }
            )
        return items
