const removableElementPattern = /<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/giu;
const htmlCommentPattern = /<!--[\s\S]*?-->/gu;
const htmlTagPattern = /<[^>]+>/gu;
const htmlWhitespacePattern = /\s+/gu;

const namedEntities: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"'
};

export interface ExtractedWebPageText {
  title?: string;
  text: string;
}

export function extractWebPageText(input: {
  contentType: string;
  body: string;
}): ExtractedWebPageText {
  if (!isHtmlContentType(input.contentType)) {
    return {
      text: normalizePlainText(input.body)
    };
  }

  const title = extractHtmlTitle(input.body);
  const withoutHiddenContent = input.body
    .replace(removableElementPattern, " ")
    .replace(htmlCommentPattern, " ");
  const text = decodeHtmlEntities(withoutHiddenContent.replace(htmlTagPattern, " "))
    .replace(htmlWhitespacePattern, " ")
    .trim();

  return {
    ...(title ? { title } : {}),
    text
  };
}

function isHtmlContentType(contentType: string): boolean {
  const mediaType = contentType.split(";")[0]?.trim().toLowerCase();
  return mediaType === "text/html" || mediaType === "application/xhtml+xml";
}

function extractHtmlTitle(html: string): string | undefined {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/iu.exec(html);
  const rawTitle = match?.[1];
  if (!rawTitle) {
    return undefined;
  }
  const title = decodeHtmlEntities(rawTitle.replace(htmlTagPattern, " "))
    .replace(htmlWhitespacePattern, " ")
    .trim();
  return title || undefined;
}

function normalizePlainText(text: string): string {
  return text.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n").trim();
}

function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/giu, (entity, value: string) => {
    const normalized = value.toLowerCase();
    if (normalized.startsWith("#x")) {
      return decodeCodePoint(Number.parseInt(normalized.slice(2), 16), entity);
    }
    if (normalized.startsWith("#")) {
      return decodeCodePoint(Number.parseInt(normalized.slice(1), 10), entity);
    }
    return namedEntities[normalized] ?? entity;
  });
}

function decodeCodePoint(codePoint: number, fallback: string): string {
  if (!Number.isFinite(codePoint)) {
    return fallback;
  }
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return fallback;
  }
}
