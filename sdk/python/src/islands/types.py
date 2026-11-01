"""Public boundary types, limits, and machine-readable errors."""

from __future__ import annotations

import asyncio
import json
import math
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable, TypeAlias

JsonValue: TypeAlias = None | bool | int | float | str | list["JsonValue"] | dict[str, "JsonValue"]
MAX_MESSAGE_BYTES = 1 << 20
MAX_CODE_BYTES = 16 << 20
LINEAR_MEMORY_BYTES = 128 << 20


class IslandsError(Exception):
    def __init__(self, code: str, message: str):
        self.code = code
        self.message = message
        super().__init__(f"{code}: {message}")


class EngineError(IslandsError):
    """A core/ABI failure; the affected instance cannot be reused."""


class GuestError(IslandsError):
    """An ordinary extension handler failure; the instance remains usable."""


def valid_name(value: Any) -> bool:
    if not isinstance(value, str) or not value:
        return False
    try:
        return len(value.encode("utf-8")) <= 1024
    except UnicodeError:
        return False


def _validate_json(value: Any, depth: int = 0) -> None:
    if depth > 100:
        raise IslandsError("INVALID_JSON", "JSON nesting exceeds 100 levels (or contains a cycle)")
    kind = type(value)
    if value is None or kind is bool:
        return
    if kind is int:
        if abs(value) > 9007199254740991:
            raise IslandsError("INVALID_JSON", "integer exceeds JavaScript safe integer range")
    elif kind is float:
        if not math.isfinite(value):
            raise IslandsError("INVALID_JSON", "numbers must be finite")
        if value.is_integer() and abs(value) > 9007199254740991:
            raise IslandsError("INVALID_JSON", "integer exceeds JavaScript safe integer range")
    elif kind is str:
        value.encode("utf-8")
    elif kind is list:
        for item in value:
            _validate_json(item, depth + 1)
    elif kind is dict:
        for key, item in value.items():
            if type(key) is not str:
                raise IslandsError("INVALID_JSON", "object keys must be strings")
            _validate_json(key, depth + 1)
            _validate_json(item, depth + 1)
    else:
        raise IslandsError("INVALID_JSON", f"{kind.__name__} is not a JSON value")


def encode_json(value: Any) -> bytes:
    try:
        _validate_json(value)
        data = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
    except (ValueError, UnicodeError, RecursionError) as error:
        raise IslandsError("INVALID_JSON", str(error)) from error
    if len(data) > MAX_MESSAGE_BYTES:
        raise IslandsError("MESSAGE_TOO_LARGE", "JSON message exceeds 1 MiB")
    return data


def json_copy(value: Any) -> JsonValue:
    return json.loads(encode_json(value))


@dataclass(frozen=True)
class Limits:
    memory_bytes: int = 16 << 20
    stack_bytes: int = 512 << 10
    fuel: int = 10_000
    timeout_ms: int = 5_000
    max_pending_calls: int = 64

    def __post_init__(self) -> None:
        for name in self.__dataclass_fields__:
            value = getattr(self, name)
            if type(value) is not int or value <= 0:
                raise IslandsError("INVALID_LIMITS", f"{name} must be a positive integer")
        if self.memory_bytes > LINEAR_MEMORY_BYTES or self.stack_bytes > 1 << 20 or self.fuel > 2147483647:
            raise IslandsError("INVALID_LIMITS", "heap must be <=128 MiB, stack <=1 MiB; fuel must be <=2147483647")


@dataclass(frozen=True)
class Artifact:
    manifest: dict[str, Any]
    code: str
    format_version: int = 1

    @classmethod
    def from_file(cls, path: str | Path) -> Artifact:
        """Read a portable JSON artifact in the host, without evaluating its code."""
        return cls.from_json(Path(path).read_bytes())

    @classmethod
    def from_json(cls, data: str | bytes) -> Artifact:
        if len(data) > MAX_CODE_BYTES * 2:
            raise IslandsError("INVALID_ARTIFACT", "artifact exceeds 32 MiB")
        try:
            value = json.loads(data)
            if not isinstance(value, dict):
                raise ValueError("artifact must be an object")
            artifact = cls(value.get("manifest"), value.get("code"), value.get("formatVersion"))
            artifact.validate()
            return artifact
        except (ValueError, TypeError, UnicodeError) as error:
            raise IslandsError("INVALID_ARTIFACT", str(error)) from error

    def validate(self) -> None:
        if type(self.format_version) is not int or self.format_version != 1 or not isinstance(self.manifest, dict) or not valid_name(self.manifest.get("id")):
            raise IslandsError("INVALID_ARTIFACT", "expected formatVersion 1 and nonempty manifest id")
        try:
            if not isinstance(self.code, str) or not self.code or len(self.code.encode("utf-8")) > MAX_CODE_BYTES:
                raise IslandsError("INVALID_ARTIFACT", "code must be a nonempty UTF-8 string of at most 16 MiB")
        except UnicodeError as error:
            raise IslandsError("INVALID_ARTIFACT", "code must be UTF-8") from error
        for name in ("name", "description", "version"):
            if name in self.manifest and not isinstance(self.manifest[name], str):
                raise IslandsError("INVALID_ARTIFACT", f"manifest {name} must be a string")
        required = self.manifest.get("requires", [])
        if not isinstance(required, list) or not all(valid_name(name) for name in required):
            raise IslandsError("INVALID_ARTIFACT", "manifest requires must contain capability names")


@dataclass(frozen=True)
class CallContext:
    extension_id: str
    metadata: dict[str, JsonValue]
    # Set on callback timeout and instance disposal; also safe for sync handlers in threads.
    cancelled: threading.Event = field(default_factory=threading.Event)
    deadline: float = 0.0  # time.monotonic(), in seconds

    def raise_if_cancelled(self) -> None:
        if self.cancelled.is_set():
            raise asyncio.CancelledError()


Handler: TypeAlias = Callable[[JsonValue, CallContext], JsonValue | Awaitable[JsonValue]]
