import { z } from "zod";
import {
  KNOWLEDGE_DOCUMENT_FORMATS,
  KNOWLEDGE_FIRST_PASS_STOP,
  type KnowledgeDocumentFormat
} from "@work-shape/catalyst-core";

// One confirmation before a large first import (KB-ISO-1b). Spec: data-stores-and-knowledge-
// bases.md, Usage and limits, check 99.
//
// A source's first pass, a connector's first sync or a Workflow's first `ingest`, fetches and
// indexes its first 10,000 items while it lists the rest. Where it holds more, it stops there
// and keeps on its run, as `stop` of the run's progress, what the whole pass holds: its items
// and their bytes by format. The run waits as "Wartet auf Bestätigung" until a holder of
// `knowledge_base.publish` confirms with `sync({ source, confirm: true })`; that sets
// `confirmed` and wakes the pass. A smaller source never waits, and neither does a later pass.
//
// The estimate is read from `stop` when it is shown: tokens from the bytes with a factor per
// format, as a range, priced from the rate card as KB-8's re-index statement is.

/** What a stopped first pass keeps on its run: never a name, only counts and bytes. */
export const firstPassStopSchema = z.object({
  /** How many items it fetches and indexes before it waits. */
  at: z.number().int().min(1),
  items: z.number().int().min(0),
  bytes: z.number().min(0),
  /** The listed bytes by the format they will be read as. */
  formats: z.partialRecord(z.enum(KNOWLEDGE_DOCUMENT_FORMATS), z.number().min(0)),
  /** A person let it go on. */
  confirmed: z.boolean().optional()
});

export type FirstPassStop = z.infer<typeof firstPassStopSchema>;

/** A stop's tally before its first item. */
export function emptyFirstPassStop(at: number): FirstPassStop {
  return { at, items: 0, bytes: 0, formats: {} };
}

/**
 * Where a first pass of this process stops: the constant. Only a test makes it smaller, through
 * the source jobs' input, to cross it with a small fixture; release config never sets it.
 */
export function firstPassStopOf(input: { firstPassStop?: number }): number {
  return input.firstPassStop ?? KNOWLEDGE_FIRST_PASS_STOP;
}

/**
 * The bytes a stop counts for an item its source listed without a size (CS-16),
 * by format, so the estimate is not zero. Estimates until MD-5 measures real sources; an empty
 * file listed with size 0 is counted the same way.
 */
export const UNSIZED_ITEM_BYTES: Record<KnowledgeDocumentFormat, number> = {
  txt: 8_000,
  markdown: 8_000,
  pdf: 250_000,
  docx: 60_000
};

/** Adds `items` of `format` and their bytes to a stop's tally. */
export function tallyFirstPass(
  stop: FirstPassStop,
  format: KnowledgeDocumentFormat,
  bytes: number,
  items = 1
): void {
  stop.items += items;
  stop.bytes += bytes;
  stop.formats[format] = (stop.formats[format] ?? 0) + bytes;
}
