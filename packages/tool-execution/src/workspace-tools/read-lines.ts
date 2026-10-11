const LINE_FEED = "\n";

export interface LineRangeRequest {
  /** First line to return, counted from 1. */
  offset: number;
  /** Most lines to return. */
  limit: number;
  /** Most UTF-8 bytes to return. */
  maxBytes: number;
}

export type LineRange =
  | {
      status: "read";
      /** An exact part of the text: whole lines with their own line endings. */
      content: string;
      /** 0 when the text is empty. */
      startLine: number;
      /** 0 when the text is empty. */
      endLine: number;
      totalLines: number;
      /** The line to continue with, when lines remain after `endLine`. */
      nextOffset?: number;
      /** Set when one line alone is larger than `maxBytes` and was cut inside the line. */
      cutLine?: { line: number; lineBytes: number; returnedBytes: number };
    }
  | { status: "past_end"; totalLines: number };

/**
 * Takes lines `offset` to `offset + limit - 1` out of a text, and fewer when they would be more
 * than `maxBytes`. The answer ends at a whole line, so no character is split. One exception: a
 * first line that alone is larger than `maxBytes` is cut inside the line, at a whole character.
 *
 * A line ends at its line feed. A last line without one counts as a line; a line feed at the end
 * of the text does not start another one. The text is scanned once and no list of its lines is
 * built, so the cost grows with the length of the text and not with the number of lines.
 */
export function readLineRange(text: string, request: LineRangeRequest): LineRange {
  const totalLines = countLines(text);
  if (totalLines === 0 && request.offset === 1) {
    return { status: "read", content: "", startLine: 0, endLine: 0, totalLines };
  }
  if (request.offset > totalLines) {
    return { status: "past_end", totalLines };
  }

  let start = 0;
  for (let line = 1; line < request.offset; line += 1) {
    start = text.indexOf(LINE_FEED, start) + 1;
  }

  let end = start;
  let lines = 0;
  let bytes = 0;
  while (lines < request.limit && end < text.length) {
    const lineEnd = endOfLine(text, end);
    const lineBytes = Buffer.byteLength(text.slice(end, lineEnd), "utf8");
    if (bytes + lineBytes > request.maxBytes) {
      break;
    }
    bytes += lineBytes;
    lines += 1;
    end = lineEnd;
  }

  if (lines === 0) {
    const lineEnd = endOfLine(text, start);
    const line = Buffer.from(text.slice(start, lineEnd), "utf8");
    const cut = line.subarray(0, wholeCharacterLength(line, request.maxBytes));
    return {
      status: "read",
      content: cut.toString("utf8"),
      startLine: request.offset,
      endLine: request.offset,
      totalLines,
      ...(request.offset < totalLines ? { nextOffset: request.offset + 1 } : {}),
      cutLine: { line: request.offset, lineBytes: line.byteLength, returnedBytes: cut.byteLength }
    };
  }

  const endLine = request.offset + lines - 1;
  return {
    status: "read",
    content: text.slice(start, end),
    startLine: request.offset,
    endLine,
    totalLines,
    ...(endLine < totalLines ? { nextOffset: endLine + 1 } : {})
  };
}

function countLines(text: string): number {
  let lines = 0;
  let position = 0;
  while (position < text.length) {
    position = endOfLine(text, position);
    lines += 1;
  }
  return lines;
}

/** The index after the line that starts at `position`, its line feed included. */
function endOfLine(text: string, position: number): number {
  const lineFeed = text.indexOf(LINE_FEED, position);
  return lineFeed === -1 ? text.length : lineFeed + 1;
}

/** The longest length up to `maxBytes` that does not end inside a UTF-8 character. */
function wholeCharacterLength(bytes: Uint8Array, maxBytes: number): number {
  let length = Math.min(maxBytes, bytes.byteLength);
  while (length > 0 && length < bytes.byteLength && isContinuationByte(bytes[length])) {
    length -= 1;
  }
  return length;
}

function isContinuationByte(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}
