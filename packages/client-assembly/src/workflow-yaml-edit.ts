import { isDeepStrictEqual } from "node:util";
import { readYamlData } from "@work-shape/catalyst-core";
import { writeWorkflowManifest } from "@work-shape/catalyst-workflows";
import {
  isMap,
  isNode,
  isScalar,
  isSeq,
  parseDocument,
  visit,
  type Document,
  type Node
} from "yaml";

/** An annotation-preserving edit, or undefined when the caller must use the full render. */
export function editWorkflowManifest(original: string, manifest: unknown): string | undefined {
  try {
    const source = original.replaceAll("\r\n", "\n");
    const document: Document = parseDocument(source);
    const originals = new WeakSet<Node>();
    visit(document, {
      Node: (_key, node) => {
        originals.add(node);
      }
    });
    const desired = parseDocument(writeWorkflowManifest(manifest));
    if (document.errors.length || desired.errors.length) return undefined;
    const before = readYamlData(original, "workflow.yaml", { refuseAliases: true });
    if (!before.ok) return undefined;
    if (isDeepStrictEqual(before.value, manifest)) return original;
    document.contents = edit(document.contents, desired.contents);
    const rendered = document.toString({ lineWidth: 0 });
    const spaced = preserveBlankLines(document.contents, rendered, source, originals);
    const text = original.includes("\r\n") ? spaced.replaceAll("\n", "\r\n") : spaced;
    const read = readYamlData(text, "workflow.yaml", { refuseAliases: true });
    return read.ok && isDeepStrictEqual(read.value, manifest) ? text : undefined;
  } catch {
    // Do not pass parser errors or source content into the fallback log.
    return undefined;
  }
}

/** Match steps/branches by id so deleting or moving one does not move another's comments. */
function idOf(node: unknown): string | undefined {
  if (!isMap(node)) return undefined;
  const id: unknown = node.get("id");
  return typeof id === "string" ? id : undefined;
}

function edit(before: unknown, next: unknown): Node | null {
  if (!isNode(next)) return null;
  if (isMap(before) && isMap(next)) {
    const keys = new Set(next.items.map((pair) => String(pair.key)));
    before.items = before.items.filter((pair) => keys.has(String(pair.key)));
    for (const pair of next.items) {
      const key = String(pair.key);
      const held = before.items.find((candidate) => String(candidate.key) === key);
      if (held) held.value = edit(held.value, pair.value);
      else before.items.push(pair);
    }
    return before;
  }
  if (isSeq(before) && isSeq(next)) {
    const byId = next.items.every((item) => idOf(item) !== undefined);
    const held = before.items;
    before.items = next.items.map((item, index) => {
      const id = idOf(item);
      const previous = byId ? held.find((candidate) => idOf(candidate) === id) : held[index];
      return previous === undefined ? item : edit(previous, item);
    });
    return before;
  }
  if (isScalar(before) && isScalar(next)) {
    before.value = next.value;
    return before;
  }
  if (isNode(before)) {
    next.comment = before.comment;
    next.commentBefore = before.commentBefore;
    next.spaceBefore = before.spaceBefore;
  }
  return next;
}

/** Document serialization keeps one blank line; retain longer runs around surviving nodes. */
function preserveBlankLines(
  edited: Node | null,
  rendered: string,
  source: string,
  originals: WeakSet<Node>
): string {
  const patches = new Map<number, { end: number; text: string }>();
  const prefix = (text: string, offset: number) => {
    const end = text.lastIndexOf("\n", offset - 1) + 1;
    let start = end;
    while (start > 0) {
      const previous = start < 2 ? 0 : text.lastIndexOf("\n", start - 2) + 1;
      const line = text.slice(previous, start).trim();
      if (line !== "" && !line.startsWith("#")) break;
      start = previous;
    }
    return { start, end, text: text.slice(start, end) };
  };
  const walk = (old: unknown, next: unknown) => {
    if (!isNode(old) || !isNode(next)) return;
    if (originals.has(old) && old.range && next.range) {
      const held = prefix(source, old.range[0]);
      const written = prefix(rendered, next.range[0]);
      // Only whitespace is restored; a removed annotation never returns with another node.
      const comments = (text: string) =>
        text
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean);
      if (
        isDeepStrictEqual(comments(held.text), comments(written.text)) &&
        held.text !== written.text
      )
        patches.set(written.start, { end: written.end, text: held.text });
    }
    if (isMap(old) && isMap(next)) {
      old.items.forEach((pair, index) => {
        walk(pair.key, next.items[index]?.key);
        walk(pair.value, next.items[index]?.value);
      });
    } else if (isSeq(old) && isSeq(next)) {
      old.items.forEach((item, index) => walk(item, next.items[index]));
    }
  };
  walk(edited, parseDocument(rendered).contents);
  let text = rendered;
  for (const [start, patch] of [...patches].sort(([a], [b]) => b - a))
    text = text.slice(0, start) + patch.text + text.slice(patch.end);
  return text;
}
