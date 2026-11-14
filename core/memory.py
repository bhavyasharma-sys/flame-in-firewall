"""Thread-safe, bounded, atomic conversation memory & per-session LRU store for FlameAI."""

from __future__ import annotations

from collections import OrderedDict
import json
import logging
import os
import threading
from datetime import datetime
from typing import Any

from config import MEMORY_FILE, MEMORY_MAX_TURNS

logger = logging.getLogger(__name__)


class ConversationMemory:
    """Multi-turn conversation memory with optional atomic disk persistence."""

    def __init__(
        self,
        filepath: str | None = None,
        max_turns: int = MEMORY_MAX_TURNS,
        persist: bool = True,
    ):
        self.persist = persist
        self.filepath = (filepath or MEMORY_FILE) if persist else None
        self.max_turns = max_turns
        self._lock = threading.Lock()
        self.history: list[dict[str, Any]] = []
        if self.persist:
            self._load()

    def _load(self) -> None:
        if not self.filepath or not os.path.exists(self.filepath):
            return
        try:
            with open(self.filepath, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            if isinstance(data, list):
                self.history = data[-self.max_turns :]
        except Exception as exc:
            logger.warning("Could not load conversation memory: %s", exc)
            self.history = []

    def _save_atomic(self) -> None:
        if not self.persist or not self.filepath:
            return
        parent = os.path.dirname(self.filepath)
        if parent:
            os.makedirs(parent, exist_ok=True)
        tmp_path = f"{self.filepath}.tmp"
        try:
            with open(tmp_path, "w", encoding="utf-8") as fh:
                json.dump(self.history[-self.max_turns :], fh, indent=2, ensure_ascii=False)
            os.replace(tmp_path, self.filepath)
        except Exception as exc:
            logger.warning("Failed saving conversation memory: %s", exc)

    def add_turn(self, user_msg: str, assistant_msg: str, sources: list[Any] | None = None) -> None:
        with self._lock:
            self.history.append(
                {
                    "timestamp": datetime.now().isoformat(timespec="seconds"),
                    "user": user_msg,
                    "assistant": assistant_msg,
                    "sources": sources or [],
                }
            )
            if len(self.history) > self.max_turns:
                self.history = self.history[-self.max_turns :]
            self._save_atomic()

    def get_recent_context(self, n: int = 5) -> str:
        with self._lock:
            recent = self.history[-n:]
        if not recent:
            return ""
        lines = ["## Recent Conversation History:"]
        for turn in recent:
            lines.append(f"User: {turn.get('user', '')[:300]}")
            lines.append(f"FlameAI: {turn.get('assistant', '')[:400]}")
        return "\n".join(lines)

    def get_full_history(self) -> list[dict[str, Any]]:
        with self._lock:
            return list(self.history)

    def clear(self) -> None:
        with self._lock:
            self.history = []
            self._save_atomic()


class SessionMemoryStore:
    """Thread-safe LRU-capped dictionary of ConversationMemory instances keyed by session ID."""

    def __init__(
        self,
        default_memory: ConversationMemory | None = None,
        max_sessions: int = 256,
        max_turns: int = MEMORY_MAX_TURNS,
    ):
        self._lock = threading.Lock()
        self.max_sessions = max(1, max_sessions)
        self.max_turns = max_turns
        self._default_memory = default_memory or ConversationMemory(max_turns=max_turns, persist=True)
        self._sessions: OrderedDict[str, ConversationMemory] = OrderedDict()

    @staticmethod
    def normalize_session_id(session_id: str | None) -> str:
        sid = (session_id or "").strip()
        return sid[:128] if sid else "default"

    def get(self, session_id: str | None = None) -> ConversationMemory:
        sid = self.normalize_session_id(session_id)
        if sid == "default":
            return self._default_memory
        with self._lock:
            mem = self._sessions.get(sid)
            if mem is not None:
                self._sessions.move_to_end(sid)
                return mem
            mem = ConversationMemory(filepath=None, max_turns=self.max_turns, persist=False)
            self._sessions[sid] = mem
            while len(self._sessions) > self.max_sessions:
                self._sessions.popitem(last=False)
            return mem

    def clear(self, session_id: str | None = None) -> None:
        sid = self.normalize_session_id(session_id)
        if sid == "default":
            self._default_memory.clear()
            return
        with self._lock:
            mem = self._sessions.get(sid)
            if mem is not None:
                mem.clear()
