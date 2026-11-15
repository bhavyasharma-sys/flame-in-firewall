# Flame in Freefall v3.0 — NASA Spacecraft Fire Safety Intelligence

> **NASA International Space Apps Challenge 2026 — Team Eagle20**
> Unified microgravity combustion digital twin, exact cooperative Shapley cabin fire-risk engine, 50-run NASA telemetry scenario ranker, explainable rankings, interactive Knowledge Graph, NASA Research Library, and citation-audited Hybrid Graph-RAG Co-Pilot.

---

## Key Capabilities

1. **Mission Control Dashboard & AI Mission Brief** (`/api/summary`, `/api/stats`, `/api/search`)
   - Executive KPI telemetry across 12 flagship NASA missions, 50 structured test runs, 16 materials, 25 findings, 15 safety directives, 13 full-text NASA documents, and a 228-node / 342-edge Knowledge Graph.
   - Global search (`Ctrl+K`) spanning experiments, materials, findings, guidelines, test runs, and NASA papers.

2. **3D Microgravity Flame Digital Twin (WebGL2 Volumetric Raymarcher)**
   - Real-time 44-step GLSL 300 es volumetric flame simulator transitioning smoothly between 0g spherical blue diffusion shells, FLEX-2 cool flames (~650 K), Artemis Lunar (0.16g / 34% O₂), Mars Habitat (0.38g), and Earth 1g buoyant soot plumes (with Canvas2D fallback).
   - Interactive fuel geometries (`Droplet`, `Gas Jet`, `PMMA Rod`, `Flat Sheet`), ignition pulse, and live **BASS-II Ventilation Paradox Curve** (minimum LOI at ~8 cm/s).

3. **Cabin Safety Lab & Exact $2^5$ Shapley Attribution** (`/api/evaluate-cabin`, `/api/physics/phase-grid`, `/api/score`)
   - Transparent combustion physics (`buoyant_velocity`, `effective_velocity`, U-shaped `flow_loi_shift`, `pressure_loi_shift`, `DILUENT_SHIFT` for `N2`/`CO2`/`He`/`Ar`, LOI & O₂ margin, regime prediction).
   - Exact $2^5 = 32$-coalition Shapley attributions relative to ISS nominal baseline ($\sum \phi_i = \text{Risk} - \text{Risk}_{\text{ISS}}$).
   - Clickable **2D `(O₂ %, Pressure kPa)` Combustion Phase Diagram** and **Cross-Habitat Material Safety Matrix**.
   - **Shared Active Cabin Scenario** header pill stays synced across the 3D Flame Twin, 50-Run Ranker, and FlameAI Co-Pilot.

4. **50-Run Scenario Ranker, Telemetry Inspector & Explainable Rankings** (`/api/runs/rank`, `/api/telemetry/{id}`, `/api/rank/*`)
   - Ranks 50 NASA proxy test runs against the active cabin scenario with tunable `(similarity, completeness, criticality)` weight sliders and stacked score breakdowns.
   - Interactive 40-point time-series telemetry charts (`flame_radius_mm`, `d_squared_mm2`, `radiative_heat_flux_kw_m2`, `flame_temp_k`) with 2-run comparison overlay.
   - Explainable flagship rankings for Experiments, Materials, Findings, and Safety Guidelines.

5. **Flagship Experiment Explorer & 5-Axis Radar Comparison Studio** (`/api/experiments`, `/api/compare`)
   - Filterable catalog of all 12 NASA fire-safety programs (BASS, BASS-II, SAFFIRE I–VI, SoFIE, FLEX, FLEX-2, ACME, SPICE, etc.) with KG-linked inspection modals and 5-axis radar benchmarks.

6. **FlameAI Co-Pilot — Streaming Hybrid Graph-RAG + Citation Audit** (`/api/chat`, `/api/chat/stream`)
   - Hybrid Cosine + BM25 Reciprocal Rank Fusion over 239 chunks (KB + 13 NASA documents + 50 test runs) enriched by multi-hop Knowledge Graph facts and live Active Cabin Shapley evaluation.
   - Multi-provider LLM chain: **OpenRouter → Gemini → Groq → Offline NASA Grounded Synthesizer** (fully operational out of the box with zero API keys).
   - Token-by-token SSE streaming, clickable `[DOC-XX p.Y]` / `[EXP-XXXX]` inline citations, sentence-level **Citation Audit & Dropped-Claims** verification panel, automatic server-side **Matplotlib scientific charts**, and strict out-of-scope NASA safety guard.

7. **Interactive Force-Directed Knowledge Graph** (`/api/graph`, `/api/graph/node/{id}`)
   - Zoom, pan, drag nodes, toggle 6 NASA entity layers, highlight connected subgraphs, and inspect multi-hop links.

8. **NASA Research Library & Official PDFs** (`/api/documents`, `/papers/*.pdf`)
   - Full-text in-app Document Reader for all 13 indexed NASA papers/briefs (`DOC-01`–`DOC-12` + `DOC-BRIEF`) plus 9 bundled NASA Glenn technical PDFs.
   - Full **Dark / Light Mode** animated slider toggle persisted in `localStorage`.

---

## Quick Start

```bash
# 1. Create virtual environment & install dependencies
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt

# 2. (Optional) Configure LLM API keys for cloud synthesis
cp .env.example .env
# Edit .env with OPENROUTER_API_KEY, GEMINI_API_KEY, or GROQ_API_KEY
# (Works fully offline with the NASA Grounded Synthesizer if no key is set!)

# 3. Start the unified FastAPI server
uvicorn server:app --host 0.0.0.0 --port 8000
```

Open `http://localhost:8000` in your browser.

---

## Testing

```bash
NASA_SYNC_ON_STARTUP=false python -m unittest discover -s tests -v
node --test tests/test_frontend_api.mjs
```

---

## Vercel Deployment

The Vercel project is `flame-in-firewall` in **EAGLE** (`eagle-c01a`, team ID
`team_gODppsnm57QGb9rRyYTIGkAe`), linked to this repository with `main` as its
production branch. Merge the deployment configuration into `main` before relying
on deployments from that branch; a manual production deployment can also use the
working branch containing these files.

- `api/index.py` re-exports **the same** `server.app` used by local Uvicorn.
- `vercel.json` uses the **Other** framework preset and routes every request directly
  to that one Python function, before filesystem routing can expose repository files.
  FastAPI retains the original path and handles
  `/api/*`, `/papers/*.pdf`, `/css/*`, `/js/*`, `/icons/*`, `/`, `/manifest.json`,
  `/favicon.ico`, and `/sw.js`. No separate frontend build or output directory is needed.
- `.python-version` selects Python **3.12**. Vercel installs `requirements.txt`;
  all listed packages are needed, including NumPy/Matplotlib for scientific charts.
  Leave the optional ChromaDB/Google SDK accelerators commented out unless needed.
- `includeFiles` explicitly includes the knowledge-base JSON, EMBER JSON/Markdown,
  and the complete `frontend/` tree (including the nine PDFs and vendored charts).
  `excludeFiles` and `.vercelignore` keep virtual environments, `tests/`, the unused
  TypeScript `src/`, build caches, `.env` files, and mutable local data out of the upload/function.
- Set **`NASA_SYNC_ON_STARTUP=false`** in Vercel project environment variables
  for **Production, Preview, and Development**, then deploy/redeploy. This skips
  the initial NASA network poll without changing local defaults or disabling manual sync.
  Optional provider API keys should also be project environment variables, never committed files.

### Function size check

A clean Linux x86-64 / CPython 3.12 binary-wheel install of the full requirements
measured **169.2 MiB** uncompressed on 2026-11-15. Applying the actual Vercel glob
rules yielded **4.7 MiB** of application/data/frontend files, or **173.9 MiB**
combined before Vercel runtime wrappers and any generated bytecode. This leaves
about **76 MiB** against a conservative **250 MiB uncompressed** function budget
(and stays below the Python builder's 225 MiB pre-optimization threshold). There
is no need to remove scientific features or bundle a local `.venv`. Dependency
minimums are not a lockfile, so recheck the actual cloud build size after upgrades.

### Deploy and verify

Use the existing EAGLE project in the Vercel dashboard, or link this checkout with
`npx vercel link --project flame-in-firewall --scope eagle-c01a` and deploy with
`npx vercel --prod --scope eagle-c01a`. The generated `.vercel/` link is ignored.
Ensure the production URL is public in the project's Deployment Protection settings
if Vercel authentication is enabled by the team's defaults.

After Vercel reports **Ready**, check the returned public production URL:

```bash
python tests/smoke_deployment.py https://YOUR-PRODUCTION-URL.vercel.app
```

The smoke check validates health and data counts, stats, runs, documents,
40-point telemetry, every shipped static asset/PDF (including body integrity),
HEAD requests, and POST `/api/chat/suggestions` with and without an active scenario.
Without an LLM key, suggestions correctly return `{"available": false, "queries": []}`.

Serverless instances have ephemeral filesystems and independent in-memory state.
Conversation history, saved settings, and live NASA caches are **not durable or
shared** on Vercel; use external storage for persistence. A periodic in-process
NASA polling loop is not a reliable serverless scheduler.

---

## Repository Structure

```text
├── config.py                 # Central settings, env keys, safeguards & system prompt
├── server.py                 # Unified FastAPI REST + SSE + static frontend server
├── domain/                   # Combustion physics, exact 2^5 Shapley, scenario & entity rankers
├── core/                     # Hybrid RRF vectorstore, NetworkX KG, citations, charts, LLM & RAG
├── utils/                    # Unified KB/EMBER/Markdown data loader & formatting helpers
├── data/
│   ├── knowledge_base/       # Structured NASA JSON datasets (experiments, materials, findings, guidelines, brief)
│   └── ember/                # 50 proxy runs, telemetry curves, 5 habitat presets, 12 NASA Markdown papers
├── frontend/
│   ├── index.html            # 8-view responsive Mission-Control UI
│   ├── css/styles.css        # Orbital Telemetry Dark & Technical Paper Light design system
│   ├── js/                   # Modular ES-module frontend (WebGL2 Flame Twin, Cabin/Shapley, Ranker, Chat, KG, Library)
│   └── papers/               # 9 official NASA Glenn / ISS PDF documents
└── tests/
    └── test_api.py           # End-to-end REST, SSE, physics, Shapley, KG & citation audit tests
```
