// A fresh consumer must resolve the chat runtime exactly as core's lock does.
// @assistant-ui/react 0.14.29 with tap 0.9.23 loops in tap's useSyncExternalStore on the
// workspace start page ("Maximum update depth exceeded"), and nothing in core's lock ever ran
// those versions. chat-ui pins every package below exactly; this check proves that a lock-free
// install honours the pins: one version of each, the one core tested.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

/** Pinned exactly in chat-ui (or server, for ai) and checked in every fresh consumer. */
export const CHAT_RUNTIME = [
  "@assistant-ui/react",
  "@assistant-ui/core",
  "@assistant-ui/store",
  "@assistant-ui/tap",
  "ai",
  "@ai-sdk/react"
];

/** Every version of `name` a lockfile resolves, from its `packages` keys. */
export function resolvedVersions(lock, name) {
  const versions = new Set();
  for (const key of Object.keys(lock.packages ?? {})) {
    if (!key.startsWith(`${name}@`)) continue;
    versions.add(key.slice(name.length + 1).split("(")[0]);
  }
  return [...versions].sort();
}

export function checkRuntimePins(consumerLockPath, coreLockPath) {
  const consumer = parse(readFileSync(consumerLockPath, "utf8"));
  const core = parse(readFileSync(coreLockPath, "utf8"));
  const problems = [];
  for (const name of CHAT_RUNTIME) {
    const tested = resolvedVersions(core, name);
    const resolved = resolvedVersions(consumer, name);
    if (tested.length !== 1) {
      problems.push(`${name}: core's lock resolves ${tested.join(", ") || "nothing"}`);
    } else if (resolved.length !== 1 || resolved[0] !== tested[0]) {
      problems.push(
        `${name}: consumer resolves ${resolved.join(", ") || "nothing"}, core tested ${tested[0]}`
      );
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `fresh-resolution: chat runtime drifted from core's lock\n- ${problems.join("\n- ")}`
    );
  }
  console.log(`Chat runtime resolves core's tested versions: ${CHAT_RUNTIME.join(", ")}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkRuntimePins(
    resolve(process.argv[2], "pnpm-lock.yaml"),
    resolve(process.argv[3], "pnpm-lock.yaml")
  );
}
