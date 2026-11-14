"""NetworkX Knowledge Graph built across ALL Flame in Freefall & EMBER datasets.
Links Experiments, Canonical Materials, Findings, Safety Implications, Safety Guidelines,
and NASA Research Papers with inbound/outbound inspection.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

import networkx as nx

from domain.combustion import canonical_material

logger = logging.getLogger(__name__)


class KnowledgeGraph:
    """Directed knowledge graph of microgravity combustion entities & relationships."""

    NODE_TYPES = {
        "experiment",
        "material",
        "finding",
        "safety_implication",
        "guideline",
        "paper",
    }

    def __init__(self):
        self.graph = nx.DiGraph()

    def build_from_all_data(self, all_data: dict[str, Any]) -> None:
        self.graph.clear()

        experiments = all_data.get("experiments") or []
        materials = all_data.get("materials") or []
        findings = all_data.get("findings") or []
        guidelines = all_data.get("guidelines") or []
        documents = all_data.get("documents") or []

        # Map canonical experiment acronyms/names so findings & guidelines connect cleanly
        exp_lookup: dict[str, str] = {}

        # 1. Materials (canonicalized)
        for mat in materials:
            raw_name = str(mat.get("name") or "").strip()
            if not raw_name:
                continue
            canon = canonical_material(raw_name)
            self._add_node(
                canon,
                "material",
                {
                    "display_name": raw_name,
                    "category": mat.get("category", "Material"),
                    "flammability_rating": mat.get("flammability_rating", ""),
                    "toxicity_rating": mat.get("toxicity_rating", ""),
                    "extinction_o2_threshold": mat.get("extinction_o2_threshold"),
                    "smoke_production": mat.get("smoke_production", ""),
                    "safety_recommendation": mat.get("safety_recommendation", ""),
                },
            )

        # 2. Experiments
        for exp in experiments:
            exp_name = str(exp.get("acronym") or exp.get("name") or "").strip()
            if not exp_name:
                continue
            full_name = str(exp.get("name") or exp_name)
            exp_lookup[exp_name.lower()] = exp_name
            exp_lookup[full_name.lower()] = exp_name
            if exp.get("id"):
                exp_lookup[str(exp["id"]).lower()] = exp_name

            self._add_node(
                exp_name,
                "experiment",
                {
                    "full_name": full_name,
                    "category": exp.get("category", "General"),
                    "platform": exp.get("platform", "ISS"),
                    "years": exp.get("years", ""),
                    "description": str(exp.get("description") or "")[:240],
                },
            )

            # Tested materials
            for raw_mat in exp.get("materials_tested") or []:
                m_str = raw_mat if isinstance(raw_mat, str) else str(raw_mat.get("name", ""))
                if not m_str.strip():
                    continue
                canon_m = canonical_material(m_str)
                if canon_m not in self.graph:
                    self._add_node(canon_m, "material", {"display_name": m_str, "category": "Fuel / Material"})
                self.graph.add_edge(exp_name, canon_m, relationship="tests_material")

            # Experiment findings
            for kf in exp.get("key_findings") or []:
                txt = str(kf).strip()
                if not txt:
                    continue
                node_id = txt[:100] + ("…" if len(txt) > 100 else "")
                self._add_node(node_id, "finding", {"full_text": txt, "source_experiment": exp_name})
                self.graph.add_edge(exp_name, node_id, relationship="produces_finding")

            # Experiment safety implications
            for si in exp.get("safety_implications") or []:
                txt = str(si).strip()
                if not txt:
                    continue
                node_id = txt[:100] + ("…" if len(txt) > 100 else "")
                self._add_node(node_id, "safety_implication", {"full_text": txt, "source_experiment": exp_name})
                self.graph.add_edge(exp_name, node_id, relationship="implies_safety")
                for raw_mat in (exp.get("materials_tested") or [])[:2]:
                    m_str = raw_mat if isinstance(raw_mat, str) else str(raw_mat.get("name", ""))
                    if m_str.strip():
                        self.graph.add_edge(canonical_material(m_str), node_id, relationship="implies_safety")

        # 3. Empirical Findings records
        for f in findings:
            title = str(f.get("title") or "").strip()
            if not title:
                continue
            self._add_node(
                title,
                "finding",
                {
                    "id": f.get("id", ""),
                    "category": f.get("category", ""),
                    "source_experiment": f.get("source_experiment", ""),
                    "safety_relevance": f.get("safety_relevance", "High"),
                    "quantitative_result": f.get("quantitative_result", ""),
                    "implications_for_spacecraft": f.get("implications_for_spacecraft", ""),
                },
            )
            src = str(f.get("source_experiment") or "").strip()
            resolved_exp = self._resolve_exp(src, exp_lookup)
            if resolved_exp:
                self.graph.add_edge(resolved_exp, title, relationship="produces_finding")

            imp = str(f.get("implications_for_spacecraft") or "").strip()
            if imp:
                imp_id = imp[:100] + ("…" if len(imp) > 100 else "")
                self._add_node(imp_id, "safety_implication", {"full_text": imp, "source_experiment": src})
                self.graph.add_edge(title, imp_id, relationship="implies_safety")

        # 4. Safety Guidelines
        for g in guidelines:
            title = str(g.get("title") or "").strip()
            if not title:
                continue
            self._add_node(
                title,
                "guideline",
                {
                    "id": g.get("id", ""),
                    "environment": g.get("environment", "All Environments"),
                    "category": g.get("category", "Safety"),
                    "risk_level": g.get("risk_level", "High"),
                    "priority": g.get("priority", 2),
                    "recommendation": g.get("recommendation", ""),
                },
            )
            for rel_exp in g.get("related_experiments") or []:
                resolved_exp = self._resolve_exp(str(rel_exp), exp_lookup)
                if resolved_exp:
                    self.graph.add_edge(resolved_exp, title, relationship="informs_guideline")

        # 5. NASA Corpus Papers & ISS Summaries
        for doc in documents:
            doc_id = str(doc.get("doc_id") or "")
            if not doc_id:
                continue
            label = f"{doc_id}: {str(doc.get('title') or '')[:55]}"
            self._add_node(
                label,
                "paper",
                {
                    "doc_id": doc_id,
                    "title": doc.get("title", ""),
                    "source_type": doc.get("source_type", "ntrs"),
                    "investigation": doc.get("investigation", ""),
                    "page_count": doc.get("page_count", 1),
                    "url": doc.get("url", ""),
                },
            )
            inv = str(doc.get("investigation") or "")
            resolved_exp = self._resolve_exp(inv, exp_lookup)
            if resolved_exp:
                self.graph.add_edge(label, resolved_exp, relationship="documents_investigation")
            for fuel in doc.get("fuel") or []:
                canon_f = canonical_material(str(fuel))
                if canon_f in self.graph:
                    self.graph.add_edge(label, canon_f, relationship="analyzes_material")

        logger.info(
            "KnowledgeGraph built — %d nodes, %d edges",
            self.graph.number_of_nodes(),
            self.graph.number_of_edges(),
        )

    def _resolve_exp(self, name: str, exp_lookup: dict[str, str]) -> Optional[str]:
        if not name:
            return None
        low = name.strip().lower()
        if low in exp_lookup:
            return exp_lookup[low]
        for k, v in exp_lookup.items():
            if low in k or k in low:
                return v
        return None

    def _add_node(self, name: str, node_type: str, attrs: dict[str, Any] | None = None) -> None:
        extra: dict[str, Any] = {}
        if isinstance(attrs, dict):
            for k, v in attrs.items():
                if isinstance(v, (str, int, float, bool)):
                    extra[k] = v
        if name in self.graph:
            self.graph.nodes[name].update(extra)
        else:
            self.graph.add_node(name, node_type=node_type, **extra)

    def query_related(self, node_name: str, depth: int = 2) -> Optional[nx.DiGraph]:
        resolved = node_name if node_name in self.graph else self._fuzzy_find(node_name)
        if resolved is None:
            return None
        undirected = self.graph.to_undirected()
        related = set(nx.single_source_shortest_path_length(undirected, resolved, cutoff=depth).keys())
        return self.graph.subgraph(related).copy()

    def get_node_connections(self, node_name: str) -> dict[str, Any]:
        resolved = node_name if node_name in self.graph else self._fuzzy_find(node_name)
        if resolved is None:
            return {"id": node_name, "found": False, "inbound": [], "outbound": []}
        attrs = dict(self.graph.nodes[resolved])
        outbound = [
            {"target": v, "relationship": d.get("relationship", "related"), "node_type": self.graph.nodes[v].get("node_type", "")}
            for _, v, d in self.graph.out_edges(resolved, data=True)
        ]
        inbound = [
            {"source": u, "relationship": d.get("relationship", "related"), "node_type": self.graph.nodes[u].get("node_type", "")}
            for u, _, d in self.graph.in_edges(resolved, data=True)
        ]
        return {
            "id": resolved,
            "found": True,
            "attributes": attrs,
            "inbound": inbound,
            "outbound": outbound,
        }

    def get_graph_data(self) -> dict[str, Any]:
        nodes = [
            {"id": n, "degree": self.graph.degree(n), **{k: v for k, v in attrs.items()}}
            for n, attrs in self.graph.nodes(data=True)
        ]
        edges = [
            {"source": u, "target": v, **{k: val for k, val in d.items()}}
            for u, v, d in self.graph.edges(data=True)
        ]
        type_counts: dict[str, int] = {}
        for n in nodes:
            t = n.get("node_type", "other")
            type_counts[t] = type_counts.get(t, 0) + 1
        return {
            "nodes": nodes,
            "edges": edges,
            "stats": {
                "node_count": len(nodes),
                "edge_count": len(edges),
                "type_counts": type_counts,
            },
        }

    def to_context_string(self, subgraph: Optional[nx.DiGraph] = None, max_edges: int = 25) -> str:
        g = subgraph if subgraph is not None else self.graph
        if g.number_of_nodes() == 0:
            return ""
        lines: list[str] = ["## Knowledge Graph Relationships:"]
        for u, v, d in list(g.edges(data=True))[:max_edges]:
            rel = str(d.get("relationship", "related_to")).replace("_", " ")
            lines.append(f"- {u} -> ({rel}) -> {v}")
        return "\n".join(lines)

    def _fuzzy_find(self, name: str) -> Optional[str]:
        low = name.strip().lower()
        for node in self.graph.nodes:
            if low == node.lower():
                return node
        for node in self.graph.nodes:
            if low in node.lower():
                return node
        return None
