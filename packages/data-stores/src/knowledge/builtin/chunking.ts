import type { KnowledgeChunkInput, KnowledgeDocumentFormat } from "@work-shape/catalyst-core";

// How the built-in backend cuts a document's text into passages, by the defaults of the spec
// (Indexing settings on the Knowledge Base): Markdown at its headings, a PDF or DOCX by page,
// every part then by a cap of about 512 tokens with the prefix counted in, no overlap. The
// prefix is a short line of title, path and heading that the embedding of a passage is made
// with (KB-5d); the passage's text is stored without it, and its heading in a column of its
// own. A new cut of the same text needs a new `KNOWLEDGE_CHUNKING_REVISION`, which the skip
// rule compares.

/** The revision of this cut. A content chunked at another revision is chunked again. */
export const KNOWLEDGE_CHUNKING_REVISION = 1;

/** The revision recorded for text read as it is: TXT and Markdown need no extraction. */
export const KNOWLEDGE_TEXT_EXTRACTION_REVISION = 1;

/** The cap of one passage, prefix included, in estimated tokens. */
export const KNOWLEDGE_CHUNK_MAX_TOKENS = 512;

/**
 * The least room a passage keeps for its text, however long the prefix: a title of hundreds of
 * words is cut from the prefix instead.
 */
const MIN_BODY_TOKENS = 128;

/** One page of text: numbered from 1 for an extracted file, none for a text file. */
export interface KnowledgeTextPage {
  page?: number;
  text: string;
}

/**
 * An estimate of the tokens of `text` that errs high for German and English: a run of letters
 * counts one token per four letters, a run of digits one per three, every other sign one, and
 * whitespace none. No tokenizer is shipped; the cap is "about" 512, and an embedding model's
 * limit is far above it.
 */
export function estimateKnowledgeTokens(text: string): number {
  let tokens = 0;
  for (const match of text.matchAll(/(\p{L}+)|(\p{N}+)|(\S)/gu)) {
    if (match[1] !== undefined) tokens += Math.ceil(match[1].length / 4);
    else if (match[2] !== undefined) tokens += Math.ceil(match[2].length / 3);
    else tokens += 1;
  }
  return tokens;
}

/** The prefix line of a passage: title, path and heading, each once. */
export function knowledgeChunkPrefix(input: {
  title: string;
  fileName: string;
  heading?: string;
}): string {
  const parts = [input.title, input.fileName, input.heading].filter(
    (part): part is string => part !== undefined && part.trim().length > 0
  );
  return [...new Set(parts.map((part) => part.trim()))].join(" · ");
}

/** A section of the text: what follows one heading, on one page. */
interface Section {
  page?: number;
  heading?: string;
  text: string;
}

/**
 * The passages of a document's text, in order. `title` and `fileName` are those of a
 * document that holds the content, for the room the prefix takes.
 */
export function chunkKnowledgeText(input: {
  format: KnowledgeDocumentFormat;
  pages: readonly KnowledgeTextPage[];
  title: string;
  fileName: string;
}): KnowledgeChunkInput[] {
  const sections: Section[] =
    input.format === "markdown"
      ? input.pages.flatMap((page) => markdownSections(page))
      : input.pages.map((page) => ({ ...page }));
  const chunks: KnowledgeChunkInput[] = [];
  for (const section of sections) {
    const prefix = knowledgeChunkPrefix({
      title: input.title,
      fileName: input.fileName,
      ...(section.heading === undefined ? {} : { heading: section.heading })
    });
    const budget = Math.max(
      MIN_BODY_TOKENS,
      KNOWLEDGE_CHUNK_MAX_TOKENS - estimateKnowledgeTokens(prefix)
    );
    for (const text of pack(section.text, budget)) {
      chunks.push({
        position: chunks.length,
        ...(section.page === undefined ? {} : { page: section.page }),
        ...(section.heading === undefined ? {} : { heading: section.heading }),
        text,
        tokenCount: estimateKnowledgeTokens(text)
      });
    }
  }
  return chunks;
}

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t#]*$/u;
const FENCE = /^ {0,3}(```|~~~)/u;

/**
 * Markdown cut at its ATX headings, outside code fences. A section's heading is the trail of
 * headings above it, `Kapitel > Abschnitt`; the heading line stays in the text, so its words
 * are found.
 */
function markdownSections(page: KnowledgeTextPage): Section[] {
  const sections: Section[] = [];
  const trail: string[] = [];
  let lines: string[] = [];
  let heading: string | undefined;
  let fence: string | undefined;
  const flush = () => {
    const text = lines.join("\n");
    if (text.trim().length > 0) {
      sections.push({
        ...(page.page === undefined ? {} : { page: page.page }),
        ...(heading === undefined ? {} : { heading }),
        text
      });
    }
    lines = [];
  };
  for (const line of page.text.split("\n")) {
    const fenceMark = FENCE.exec(line)?.[1];
    if (fenceMark !== undefined) {
      if (fence === undefined) fence = fenceMark;
      else if (fence === fenceMark) fence = undefined;
    }
    const match = fence === undefined && fenceMark === undefined ? HEADING.exec(line) : null;
    if (match?.[1] !== undefined && match[2] !== undefined) {
      flush();
      const level = match[1].length;
      trail.splice(level - 1, trail.length, match[2].trim());
      heading = trail.filter((part) => part.length > 0).join(" > ");
    }
    lines.push(line);
  }
  flush();
  return sections;
}

/** The text in pieces of at most `budget` tokens, cut at the largest unit that fits. */
function pack(text: string, budget: number): string[] {
  const pieces = splitToFit(text.trim(), budget, 0);
  const chunks: string[] = [];
  let current = "";
  let tokens = 0;
  for (const piece of pieces) {
    const size = estimateKnowledgeTokens(piece.text);
    if (current.length > 0 && tokens + size <= budget) {
      current += piece.separator + piece.text;
      tokens += size;
      continue;
    }
    if (current.length > 0) chunks.push(current);
    current = piece.text;
    tokens = size;
  }
  if (current.trim().length > 0) chunks.push(current);
  return chunks;
}

/** From the largest unit to the smallest: paragraphs, lines, sentences, words. */
const UNITS: readonly { split: RegExp; separator: string }[] = [
  { split: /\n[ \t]*\n+/u, separator: "\n\n" },
  { split: /\n/u, separator: "\n" },
  { split: /(?<=[.!?…:;])\s+/u, separator: " " },
  { split: /\s+/u, separator: " " }
];

interface Piece {
  text: string;
  /** What joins it to the piece before it in one passage. */
  separator: string;
}

/** `text` as pieces that each fit `budget`, each split at the largest unit it needs. */
function splitToFit(text: string, budget: number, unit: number): Piece[] {
  const level = UNITS[unit];
  if (!level) return splitCharacters(text, budget);
  const pieces: Piece[] = [];
  for (const part of text.split(level.split)) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    if (estimateKnowledgeTokens(trimmed) <= budget) {
      pieces.push({ text: trimmed, separator: level.separator });
      continue;
    }
    const inner = splitToFit(trimmed, budget, unit + 1);
    // The first inner piece follows the previous part as this level does.
    pieces.push(
      ...inner.map((piece, index) =>
        index === 0 ? { ...piece, separator: level.separator } : piece
      )
    );
  }
  return pieces;
}

/** A word longer than a passage, cut into runs of characters. */
function splitCharacters(text: string, budget: number): Piece[] {
  const pieces: Piece[] = [];
  const characters = [...text];
  // A run of letters counts a token per four, the most a character can cost is one.
  for (let start = 0; start < characters.length; start += budget) {
    pieces.push({ text: characters.slice(start, start + budget).join(""), separator: "" });
  }
  return pieces;
}

/**
 * The text of a TXT or Markdown file: UTF-8, and where the bytes are no UTF-8, Windows-1252,
 * which German text files from older tools are in. Nothing where the bytes are no text: they
 * hold a NUL.
 */
export function decodeKnowledgeText(bytes: Uint8Array): string | undefined {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    text = new TextDecoder("windows-1252").decode(bytes);
  }
  if (text.includes("\u0000")) return undefined;
  return normalizeKnowledgeText(text.replace(/^﻿/u, ""));
}

/** Line ends as `\n`, and no NUL, which Postgres text cannot hold. */
export function normalizeKnowledgeText(text: string): string {
  return text.replace(/\r\n?/gu, "\n").replaceAll("\u0000", "");
}
