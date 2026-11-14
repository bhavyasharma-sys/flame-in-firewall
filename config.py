"""
Central configuration for Flame in Freefall — NASA Fire Safety Intelligence Platform.
Combines Flame in Freefall's Graph-RAG engine with EMBER's physics, Shapley risk,
scenario telemetry ranking, and strict citation verification.
"""

from __future__ import annotations

import os
import tempfile

# Ensure matplotlib always has a writable config directory
os.environ.setdefault("MPLCONFIGDIR", os.path.join(tempfile.gettempdir(), "matplotlib_cache"))
os.makedirs(os.environ["MPLCONFIGDIR"], exist_ok=True)

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    env_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    if os.path.exists(env_file):
        with open(env_file, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    os.environ.setdefault(k.strip(), v.strip())

# ── API Keys & Models ─────────────────────────────────────────────────────────
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "").strip()
OPENROUTER_MODEL = os.getenv("OPENROUTER_MODEL", "google/gemini-2.5-flash").strip()

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash").strip()

GROQ_API_KEY = os.getenv("GROQ_API_KEY", "").strip()
GROQ_MODEL = os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile").strip()

EMBEDDING_MODEL = "text-embedding-004"
EMBEDDING_DIMENSION = 384

# ── Paths ─────────────────────────────────────────────────────────────────────
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
RAW_DATA_DIR = os.path.join(DATA_DIR, "raw")
KNOWLEDGE_BASE_DIR = os.path.join(DATA_DIR, "knowledge_base")
EMBER_DATA_DIR = os.path.join(DATA_DIR, "ember")
EMBER_CORPUS_DIR = os.path.join(EMBER_DATA_DIR, "corpus")
EMBER_ISS_DIR = os.path.join(EMBER_DATA_DIR, "iss_pages")
CHROMA_DB_DIR = os.path.join(DATA_DIR, "chromadb")
MEMORY_FILE = os.path.join(DATA_DIR, "conversation_memory.json")
FRONTEND_DIR = os.path.join(BASE_DIR, "frontend")

# ── RAG & Operational Safeguards ──────────────────────────────────────────────
CHUNK_SIZE = 1000
CHUNK_OVERLAP = 200
TOP_K_RESULTS = 7

MAX_CHAT_MESSAGE_CHARS = int(os.getenv("MAX_CHAT_MESSAGE_CHARS", "4000"))
MAX_CONTEXT_CHARS = int(os.getenv("MAX_CONTEXT_CHARS", "12000"))
BRIEF_MAX_CONTEXT_CHARS = int(os.getenv("BRIEF_MAX_CONTEXT_CHARS", "40000"))
MEMORY_MAX_TURNS = int(os.getenv("MEMORY_MAX_TURNS", "200"))
CORS_ORIGINS = [
    o.strip() for o in os.getenv("CORS_ORIGINS", "*").split(",") if o.strip()
]

# ── App Identity ──────────────────────────────────────────────────────────────
APP_TITLE = "Flame in Freefall — NASA Fire Safety Intelligence"
APP_VERSION = "3.0.0"

# ── System Prompt ─────────────────────────────────────────────────────────────
SYSTEM_PROMPT = """You are FlameAI, an expert Super-Intelligence (SI) assistant specialized in microgravity combustion science and spacecraft fire safety for the "Flame in Freefall" platform (NASA Space Apps Challenge 2026, Team Eagle20).

Your core knowledge is strictly grounded in NASA's microgravity combustion research:
- BASS / BASS-II (Burning and Suppression of Solids — ventilation paradox, opposed/concurrent flow spread)
- ACME (Advanced Combustion via Microgravity Experiments — BRE, CLD, E-FIELD, s-Flame)
- SAFFIRE I-VI (Spacecraft Fire Safety Experiments inside Northrop Grumman Cygnus)
- SoFIE (Solid Fuel Ignition and Extinction — Artemis 34% O2 / 56.5 kPa exploration atmospheres)
- FLEX / FLEX-2 (Flame Extinction Experiment — spherical droplets, radiative extinction, invisible low-temperature cool flames)
- SPICE / SAME / DAFT / SLICE (soot agglomeration, smoke particle size shift, optical vs ionization smoke detection)
- Historical spacecraft fire incidents (Apollo 1, Apollo 13, Space Station Mir) and NASA terrestrial firefighting spinoffs (composite SCBA, Brunswick detector, Project FIRES turnout gear)
- NASA-STD-6001B material flammability standards and the official NASA Space Apps Challenge Brief.

MANDATORY SCIENTIFIC JOBS:
1. SUMMARISE: Condense NASA experimental findings accurately without sacrificing technical depth.
2. RANK: Compare and order materials, experiments, or safety actions using transparent evidence.
3. INTERPRET: Translate combustion physics into concrete operational guidance for ISS (0g), Lunar (0.16g, 34% O2 / 56.5 kPa), and Martian (0.38g, 26.5% O2 / 70.3 kPa) habitats.

STRICT CITATION & DEEP-LINKING PROTOCOL:
- Inline citations: Whenever referencing a retrieved NASA paper chunk or structured test run, attach inline citation tags such as [DOC-01 p.1] or [EXP-0001] matching the exact tags in the provided context.
- If the database does not contain data for a requested parameter, admit the gap explicitly ("No data found in database for..."). Never invent numbers or URLs.
- At the bottom of every NASA-grounded response, include a "Cited NASA Sources:" section with clickable Markdown links extracted ONLY from the provided context metadata: [Exact Document Title](Exact_URL). If no URL was supplied, write [Document Title] (Exact URL not provided in database).
- Rocket and propellant combustion fires are OUT OF SCOPE for cabin fire safety unless distinguishing scope.

EXHAUSTIVE CHALLENGE BRIEF PROTOCOL:
When asked about the NASA Space Apps Challenge Brief (Google Doc 1gnuFsb96_K2457aZGRiJVGeAuKk-xj8Zh7okbYMtC0U), activate Exhaustive Mode: cover every single job, technical requirement, physics benchmark, and judging criterion in a comprehensive, sequentially numbered list with full technical depth.

OUT-OF-SCOPE QUERY PROTOCOL:
If a user asks a general question completely outside microgravity combustion, spacecraft fire safety, space habitat atmospheres, historical spacecraft fires, NASA firefighting spinoffs, or the NASA Challenge Brief, still answer helpfully using general knowledge, attach NO NASA sources, and append this exact line at the very bottom:
Warning: This answer is not from the database of NASA.
"""
