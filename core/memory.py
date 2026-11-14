"""Thread-safe, bounded, atomic conversation memory for FlameAI."""

from __future__ import annotations

import json
import logging
import os
import threading
from datetime import datetime
from typing import Any

from config import MEMORY_FILE, MEMORY_MAX_TURNS

logger = logging.getLogger(__name__)


class ConversationMemory:
    """Persistent multi-turn conversation memory with atomic writes."""

    def __init__(self, filepath: str | None = None, max_turns: int = MEMORY_MAX_TURNS):
        self.filepath = filepath or MEMORY_FILE
        self.max_turns = max_turns
        self._lock = threading.Lock()
        self.history: list[dict[str, Any]] = []
        self._load()

    def _load(self) -> None:
        if not os.path.exists(self.filepath):
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
