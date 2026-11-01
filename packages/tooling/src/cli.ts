#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { bundleExtension, generateHostTypes, validateManifest } from "./index.js";
import type { HostContract } from "@islands/protocol";

const usage = `Usage:
  islands build <entry.ts|entry.js> --manifest <manifest.json> --out <artifact.json>
  islands types <contract.json> --out <host-methods.ts> [--name HostMethods]
`;

function flags(args: string[], allowed: string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]!;
    const value = args[index + 1];
    if (!allowed.includes(key) || !value || value.startsWith("--") || result.has(key)) {
      throw new Error(`Invalid or duplicate argument: ${key}\n${usage}`);
    }
    result.set(key, value);
  }
  return result;
}

function required(options: Map<string, string>, key: string): string {
  const value = options.get(key);
  if (!value) throw new Error(`Missing ${key}\n${usage}`);
  return value;
}

async function main(args: string[]): Promise<void> {
  if (args.length === 0 || (args.length === 1 && ["--help", "-h"].includes(args[0]!))) {
    process.stdout.write(usage);
    return;
  }
  const [command, input, ...rest] = args;
  if (!input || input.startsWith("--")) throw new Error(usage);
  if (command === "build") {
    const options = flags(rest, ["--manifest", "--out"]);
    const output = required(options, "--out");
    const manifest = validateManifest(JSON.parse(await readFile(required(options, "--manifest"), "utf8")));
    const artifact = await bundleExtension({ entrypoint: input, manifest });
    await writeFile(output, `${JSON.stringify(artifact, null, 2)}\n`);
    return;
  }
  if (command === "types") {
    const options = flags(rest, ["--out", "--name"]);
    const output = required(options, "--out");
    const contract = JSON.parse(await readFile(input, "utf8")) as HostContract;
    await writeFile(output, await generateHostTypes(contract, { typeName: options.get("--name") }));
    return;
  }
  throw new Error(`Unknown command: ${command}\n${usage}`);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`islands: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
