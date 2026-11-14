"""Exact Shapley values by full coalition enumeration (2^n coalitions).

Guarantees exact additivity: sum(phi.values()) == v(all) - v(empty).
"""

from __future__ import annotations

import itertools
import math
from collections.abc import Callable, Hashable, Sequence
from typing import TypeVar

P = TypeVar("P", bound=Hashable)


def exact_shapley(
    value_fn: Callable[[frozenset[P]], float], players: Sequence[P]
) -> dict[P, float]:
    names = list(players)
    n = len(names)
    cache: dict[frozenset[P], float] = {}

    def v(s: frozenset[P]) -> float:
        if s not in cache:
            cache[s] = value_fn(s)
        return cache[s]

    phi: dict[P, float] = {k: 0.0 for k in names}
    for i in names:
        others = [k for k in names if k != i]
        for r in range(n):
            w = math.factorial(r) * math.factorial(n - r - 1) / math.factorial(n)
            for subset in itertools.combinations(others, r):
                s = frozenset(subset)
                phi[i] += w * (v(s | {i}) - v(s))
    return phi


__all__ = ["exact_shapley"]
