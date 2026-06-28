from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Iterable

from .models import Candidate, RunContext


class Stage(ABC):
    name: str

    @abstractmethod
    def run(self, candidates: list[Candidate], context: RunContext) -> list[Candidate]:
        """Return the updated candidate list."""


class Pipeline:
    def __init__(self, stages: Iterable[Stage]) -> None:
        self.stages = list(stages)

    def run(self, candidates: list[Candidate], context: RunContext) -> list[Candidate]:
        for stage in self.stages:
            candidates = stage.run(candidates, context)
        return candidates

