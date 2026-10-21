// Inline citation markers some OpenAI models write into their text when they search the web,
// such as U+E200 `cite` U+E202 `turn1view2` U+E202 `turn1view4` U+E201: a private-use character opens the
// marker, another separates its parts and a third closes it. They point into the model's own
// search turns, which no reader has; the sources of the answer reach the interface as sources
// and citations of the completion. So the text a person reads, streamed and stored, holds no
// marker, and a citation's range counts the characters of that text.

const MARKER_OPEN = "\uE200";
const MARKER_CLOSE = "\uE201";
/** A marker character, also one left over where a marker was cut or never closed. */
const MARKER_CHARACTER = /[\uE200-\uE202]/u;
/**
 * The longest an open marker is held back while streaming. A marker is a few dozen characters;
 * text held longer than this was no marker, and is let through without the marker characters.
 */
const MARKER_MAX_CHARS = 512;

/** The text without markers, and where each character of the given text ends up in it. */
export function stripCitationMarkers(text: string): {
  text: string;
  /** The index in the stripped text of the character at `index` of the given text. */
  indexOf(index: number): number;
} {
  if (!MARKER_CHARACTER.test(text)) return { text, indexOf: (index) => index };
  // The positions of the given text that are removed, in order.
  const removed: number[] = [];
  let kept = "";
  let index = 0;
  while (index < text.length) {
    const character = text.charAt(index);
    if (character === MARKER_OPEN) {
      const close = text.indexOf(MARKER_CLOSE, index + 1);
      const nextOpen = text.indexOf(MARKER_OPEN, index + 1);
      if (close >= 0 && (nextOpen < 0 || close < nextOpen)) {
        for (let position = index; position <= close; position += 1) removed.push(position);
        index = close + 1;
        continue;
      }
    }
    if (MARKER_CHARACTER.test(character)) removed.push(index);
    else kept += character;
    index += 1;
  }
  return {
    text: kept,
    indexOf(position) {
      let before = 0;
      while (before < removed.length && (removed[before] ?? position) < position) before += 1;
      return position - before;
    }
  };
}

/**
 * A filter of streamed text: each delta goes in, and what may be shown of it comes out. Text
 * from an opening marker character is held until the marker closes, and the marker is dropped.
 */
export function createCitationMarkerFilter(): {
  push(delta: string): string;
  /** What is still held when the stream ends, without marker characters. */
  flush(): string;
} {
  let held = "";
  const release = (text: string): string => {
    const open = text.lastIndexOf(MARKER_OPEN);
    const closedAfter = open >= 0 && text.indexOf(MARKER_CLOSE, open) >= 0;
    if (open >= 0 && !closedAfter && text.length - open <= MARKER_MAX_CHARS) {
      held = text.slice(open);
      return stripCitationMarkers(text.slice(0, open)).text;
    }
    held = "";
    return stripCitationMarkers(text).text;
  };
  return {
    push: (delta) => release(held + delta),
    flush() {
      const rest = held;
      held = "";
      return stripCitationMarkers(rest).text;
    }
  };
}
