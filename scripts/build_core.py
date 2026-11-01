#!/usr/bin/env python3
"""Build the pinned QuickJS/WASI Preview 1 reactor (Python 3.10+, no packages)."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
QUICKJS_VERSION = "2026-06-04"
QUICKJS_SHA256 = "b376e839b322978313d929fd20663b11ba58b75df5a46c126dd19ea2fa70ad2a"
SDK_VERSION = "34.0"
# Official GitHub release asset digests, pinned rather than trusted at build time.
SDK_SHA256 = {
    "arm64-macos": "9c59398106b417f8f14913380fdf0097a8cc0ff4af9eb3ce0065a859e88d49e9",
    "x86_64-macos": "87d27fa8adc68dee59bfbf2e22a6d34ef717c34d6bf1d8af2a56fc929d9ce0eb",
    "arm64-linux": "f7e243dff54d60bcc576e94d6166b69f410f2500ae4a9ceef34315be10e77971",
    "x86_64-linux": "b761e3a0721dbae9c09a0059e5fdb2bf917d1b4a8a7b430fb3b5aafb0984b2c4",
}
EXPORTS = [
    "islands_abi_version", "islands_alloc", "islands_free", "islands_init",
    "islands_eval", "islands_dispatch", "islands_step", "islands_output_ptr",
    "islands_output_len", "islands_output_clear", "islands_error_ptr",
    "islands_error_len", "islands_destroy",
]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download(url: str, checksum: str, cache: Path) -> Path:
    archive = cache / url.rsplit("/", 1)[1]
    if not archive.exists():
        print(f"Downloading {url}", flush=True)
        request = urllib.request.Request(url, headers={"User-Agent": "islands-core-build/1"})
        with tempfile.NamedTemporaryFile(dir=cache, delete=False) as temporary:
            temporary_path = Path(temporary.name)
            try:
                with urllib.request.urlopen(request, timeout=120) as response:
                    shutil.copyfileobj(response, temporary)
                temporary.close()
                if sha256(temporary_path) != checksum:
                    raise RuntimeError(f"SHA-256 mismatch for {url}")
                temporary_path.replace(archive)
            finally:
                temporary_path.unlink(missing_ok=True)
    if sha256(archive) != checksum:
        raise RuntimeError(f"SHA-256 mismatch for cached {archive}; remove it and retry")
    return archive


def unpack(archive: Path, destination: Path) -> None:
    # Extract only verified archives and reject members escaping the destination.
    with tarfile.open(archive) as source:
        for member in source.getmembers():
            path = (destination / member.name).resolve()
            if not path.is_relative_to(destination.resolve()):
                raise RuntimeError(f"Unsafe archive member: {member.name}")
        if hasattr(tarfile, "data_filter"):
            source.extractall(destination, filter="data")
        else:
            source.extractall(destination)


def sdk_platform() -> str:
    system = {"Darwin": "macos", "Linux": "linux"}.get(platform.system())
    arch = {"aarch64": "arm64", "arm64": "arm64", "x86_64": "x86_64"}.get(platform.machine())
    key = f"{arch}-{system}"
    if key not in SDK_SHA256:
        raise RuntimeError("Automatic SDK download supports macOS/Linux arm64/x86_64; use --wasi-sdk")
    return key


def prepare_sdk(cache: Path, override: str | None) -> tuple[Path, str | None]:
    if override:
        sdk = Path(override).expanduser().resolve()
        if not (sdk / "bin/clang").is_file():
            raise RuntimeError(f"No bin/clang in WASI SDK: {sdk}")
        return sdk, None
    target = sdk_platform()
    name = f"wasi-sdk-{SDK_VERSION}-{target}"
    url = f"https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-34/{name}.tar.gz"
    archive = download(url, SDK_SHA256[target], cache)
    sdk = cache / name
    marker = sdk / ".islands-archive-sha256"
    if not marker.exists() or marker.read_text().strip() != SDK_SHA256[target]:
        # Extraction into a fresh temporary tree avoids partial installs.
        with tempfile.TemporaryDirectory(dir=cache) as temporary:
            unpack(archive, Path(temporary))
            if sdk.exists():
                shutil.rmtree(sdk)
            (Path(temporary) / name).replace(sdk)
        marker.write_text(SDK_SHA256[target] + "\n")
    return sdk, SDK_SHA256[target]


def replace_once(source: str, old: str, new: str) -> str:
    if source.count(old) != 1:
        raise RuntimeError(f"QuickJS portability patch no longer matches: {old!r}")
    return source.replace(old, new, 1)


def prepare_quickjs(cache: Path, work: Path) -> Path:
    name = f"quickjs-{QUICKJS_VERSION}"
    archive = download(f"https://bellard.org/quickjs/{name}.tar.xz", QUICKJS_SHA256, cache)
    unpack(archive, work)
    directory = work / name
    path = directory / "quickjs.c"
    source = path.read_text()
    # Keep genuine WASI stack checking; defining __EMSCRIPTEN__ would disable it.
    source = replace_once(source, "#if defined(__EMSCRIPTEN__)\n#define DIRECT_DISPATCH",
                          "#if defined(__EMSCRIPTEN__) || defined(__wasi__)\n#define DIRECT_DISPATCH")
    source = replace_once(source, "#if !defined(__EMSCRIPTEN__)\n#define CONFIG_ATOMICS",
                          "#if !defined(__EMSCRIPTEN__) && !defined(__wasi__)\n#define CONFIG_ATOMICS")
    source = replace_once(source, "#elif defined(__linux__) || defined(__GLIBC__)\n#include <malloc.h>",
                          "#elif defined(__linux__) || defined(__GLIBC__) || defined(__wasi__)\n#include <malloc.h>")
    path.write_text(source)
    dtoa = directory / "dtoa.c"
    dtoa.write_text(replace_once(dtoa.read_text(), "#include <setjmp.h>\n", ""))
    return directory


def embed_guest(work: Path) -> str:
    guest = ROOT / "core/guest.js"
    data = guest.read_bytes()
    data.decode("utf-8")
    if not data or b"\0" in data:
        raise RuntimeError("core/guest.js must contain nonempty UTF-8 source without NUL bytes")
    values = data + b"\0"
    lines = [", ".join(str(byte) for byte in values[start:start + 24])
             for start in range(0, len(values), 24)]
    (work / "guest.h").write_text("static const unsigned char islands_guest[] = {\n" +
                                 ",\n".join(lines) + "\n};\n")
    return hashlib.sha256(data).hexdigest()


def build(args: argparse.Namespace) -> None:
    cache = args.cache.resolve()
    cache.mkdir(parents=True, exist_ok=True)
    sdk, sdk_hash = prepare_sdk(cache, args.wasi_sdk)
    output = args.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="islands-core-", dir=cache) as temporary:
        work = Path(temporary)
        source = prepare_quickjs(cache, work)
        guest_hash = embed_guest(work)
        # Relative source names and prefix maps make diagnostics/embedded paths stable.
        shutil.copyfile(ROOT / "core/islands.c", work / "islands.c")
        command = [
            str(sdk / "bin/clang"), "--target=wasm32-wasip1",
            f"--sysroot={sdk / 'share/wasi-sysroot'}", "-mexec-model=reactor",
            "-std=gnu11", "-O2", "-flto", "-fwrapv", "-funsigned-char",
            "-fvisibility=hidden", "-ffunction-sections", "-fdata-sections",
            "-Wall", "-Wextra", "-Wno-unused-parameter", "-Wno-sign-compare",
            "-Wno-missing-field-initializers", "-D_GNU_SOURCE", "-DNDEBUG",
            f'-DCONFIG_VERSION="{QUICKJS_VERSION}"',
            f"-ffile-prefix-map={work}=.", f"-ffile-prefix-map={sdk}=wasi-sdk",
            f"-I{source.name}", "-I.", "islands.c",
            *[f"{source.name}/{name}.c" for name in ["quickjs", "dtoa", "libregexp", "libunicode", "cutils"]],
            "-lm", "-Wl,-z,stack-size=2097152", "-Wl,--stack-first",
            "-Wl,--initial-memory=4194304", "-Wl,--max-memory=134217728",
            "-Wl,--strip-all", "-Wl,--export-memory",
            *[f"-Wl,--export={name}" for name in EXPORTS],
            "-o", "islands.wasm",
        ]
        print(f"Building QuickJS {QUICKJS_VERSION} with {sdk.name}", flush=True)
        environment = {**os.environ, "SOURCE_DATE_EPOCH": "1780531200", "LC_ALL": "C", "TZ": "UTC"}
        subprocess.run(command, cwd=work, env=environment, check=True)
        compiler = subprocess.check_output([str(sdk / "bin/clang"), "--version"], text=True).splitlines()[0]
        metadata = {
            "abiVersion": 1,
            "quickjsVersion": QUICKJS_VERSION,
            "quickjsArchiveSha256": QUICKJS_SHA256,
            "wasiSdkVersion": SDK_VERSION if sdk_hash else "custom",
            "wasiSdkArchiveSha256": sdk_hash,
            "compiler": compiler,
            "guestSha256": guest_hash,
            "coreSha256": sha256(ROOT / "core/islands.c"),
            "buildScriptSha256": sha256(Path(__file__)),
            "wasmSha256": sha256(work / "islands.wasm"),
            "linearMemoryMaxBytes": 134217728,
            "cStackBytes": 2097152,
            "exports": ["memory", "_initialize", *EXPORTS],
        }
        shutil.copyfile(work / "islands.wasm", output)
        output.with_suffix(".build.json").write_text(json.dumps(metadata, indent=2) + "\n")
        shutil.copyfile(ROOT / "core/THIRD_PARTY_NOTICES.md", output.parent / "THIRD_PARTY_NOTICES.md")
        print(f"Built {output} ({output.stat().st_size:,} bytes)\nSHA-256 {metadata['wasmSha256']}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, default=ROOT / "build", help="verified archive and SDK cache")
    parser.add_argument("--output", type=Path, default=ROOT / "dist/islands.wasm")
    parser.add_argument("--wasi-sdk", default=os.environ.get("WASI_SDK_PATH"), help="explicit custom SDK (not checksum-pinned)")
    args = parser.parse_args()
    try:
        build(args)
    except (OSError, RuntimeError, tarfile.TarError, subprocess.CalledProcessError, UnicodeError) as error:
        print(f"Core build failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
