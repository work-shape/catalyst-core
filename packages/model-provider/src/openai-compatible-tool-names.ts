import { createHash } from "node:crypto";

const PROVIDER_TOOL_NAME_MAX_CHARS = 64;
const PROVIDER_TOOL_NAME_PREFIX_CHARS = 55;
const PROVIDER_TOOL_NAME_HASH_CHARS = 8;
const PROVIDER_TOOL_NAME_LAST_LEVEL = 2;
const UNKNOWN_WIRE_TOOL_NAME_PREFIX = "unknown:";

interface ProviderToolName {
  productName: string;
  base: string;
  hash: string;
  level: number;
}

function createToolName(productName: string): ProviderToolName {
  return {
    productName,
    base: productName.replace(/[^a-zA-Z0-9_-]/gu, "_"),
    hash: createHash("sha256").update(productName, "utf8").digest("hex"),
    level: productName.length === 0 ? 1 : 0
  };
}

function wireNameAtLevel({ base, hash, level }: ProviderToolName): string {
  if (level >= PROVIDER_TOOL_NAME_LAST_LEVEL)
    return `t_${hash.slice(0, PROVIDER_TOOL_NAME_MAX_CHARS - 2)}`;
  if (level === 0 && base.length > 0 && base.length <= PROVIDER_TOOL_NAME_MAX_CHARS) {
    return base;
  }
  const suffix = hash.slice(0, PROVIDER_TOOL_NAME_HASH_CHARS);
  return base ? `${base.slice(0, PROVIDER_TOOL_NAME_PREFIX_CHARS)}_${suffix}` : suffix;
}

/** The wire names of one request: the offered tools, and a valid name for any other tool. */
export interface ProviderToolNames {
  wireNameFor: (productName: string) => string;
  productNameFor: (wireName: string) => string;
  toolNameMap: Map<string, string>;
}

// A wire name depends only on its product name and the set of product names offered in the
// request, because prompt caching depends on stable names. The order of the tools does not
// matter: while two or more offered names share a wire name, every one of them moves up one
// level together, so none of them keeps the plain name. The last level is the hash alone.
// The way back is the table built here, never a decoding of the wire name.
export function createProviderToolNames(productNames: readonly string[]): ProviderToolNames {
  const names = [...new Set(productNames)].map(createToolName);
  for (;;) {
    const groups = new Map<string, ProviderToolName[]>();
    for (const name of names) {
      const wireName = wireNameAtLevel(name);
      groups.set(wireName, [...(groups.get(wireName) ?? []), name]);
    }
    // A name at the last level stays there. Each name moves at most twice, so this ends.
    const promoted = [...groups.values()]
      .filter((group) => group.length > 1)
      .flat()
      .filter((name) => name.level < PROVIDER_TOOL_NAME_LAST_LEVEL);
    if (promoted.length === 0) break;
    for (const name of promoted) {
      name.level += 1;
    }
  }

  const forwardNames = new Map(names.map((name) => [name.productName, wireNameAtLevel(name)]));
  const toolNameMap = new Map(
    [...forwardNames].map(([productName, wireName]) => [wireName, productName])
  );
  function wireNameFor(productName: string): string {
    const offeredName = forwardNames.get(productName);
    if (offeredName !== undefined) return offeredName;
    const name = createToolName(productName);
    for (let level = 0; level <= PROVIDER_TOOL_NAME_LAST_LEVEL; level += 1) {
      const wireName = wireNameAtLevel({ ...name, level });
      if (!toolNameMap.has(wireName)) return wireName;
    }
    for (let n = 1; ; n += 1) {
      const wireName = wireNameAtLevel({
        ...createToolName(`${productName}#${n}`),
        level: PROVIDER_TOOL_NAME_LAST_LEVEL
      });
      if (!toolNameMap.has(wireName)) return wireName;
    }
  }
  function productNameFor(wireName: string): string {
    // The tool registry only accepts names matching ^[A-Za-z][A-Za-z0-9_.-]*$.
    // A name with a colon can never be registered, so dispatch returns its ordinary
    // not registered failure for a wire name outside this request's table.
    return toolNameMap.get(wireName) ?? UNKNOWN_WIRE_TOOL_NAME_PREFIX + wireName;
  }
  return { toolNameMap, wireNameFor, productNameFor };
}
