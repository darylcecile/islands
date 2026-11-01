"""Run from the repository root after installing sdk/python in .venv."""

import asyncio
from pathlib import Path

from islands import Artifact, CallContext, JsonValue, Runtime


async def main() -> None:
    root = Path(__file__).resolve().parents[2]
    artifact = Artifact.from_file(root / "dist/extensions/portable-greeter.json")
    logs = []

    async def log_write(input: JsonValue, caller: CallContext) -> JsonValue:
        assert caller.extension_id == artifact.manifest["id"]
        assert caller.metadata == {"workspaceId": "native-demo"}
        assert isinstance(input, dict) and isinstance(input.get("message"), str)
        await asyncio.sleep(0.001)
        caller.raise_if_cancelled()
        logs.append(input["message"])
        return None

    async with Runtime((root / "dist/islands.wasm").read_bytes(), capabilities={"log.write": log_write}) as runtime:
        extension = await runtime.load(artifact, grants=["log.write"], metadata={"workspaceId": "native-demo"})
        for calls in (1, 2):
            assert await extension.invoke("greet", {"name": "Islands"}) == {"message": "Hello, Islands!", "calls": calls}
        await extension.emit("native.example")
        assert logs == ["Hello, Islands!", "Hello, Islands!"]
        await extension.dispose()
    print("Python: portable-greeter returned two greetings (calls 1, 2); async host logging, metadata, emit and dispose passed")


if __name__ == "__main__":
    asyncio.run(main())
