export function createConversationTitle(text: string): string {
  return truncateConversationTitle(normalizeConversationTitle(text));
}

export function normalizeGeneratedConversationTitle(text: string): string {
  return truncateConversationTitle(
    normalizeConversationTitle(text)
      .replace(/^title:\s*/iu, "")
      .replace(/^["'`]+|["'`]+$/gu, "")
      .replace(/[.!?:;,-]+$/u, "")
  );
}

export function isTemporaryConversationTitle(
  title: string,
  firstUserText: string,
  additionalTemporaryTitles: readonly string[] = []
): boolean {
  const firstLine = firstUserText.split(/\r?\n/u)[0] ?? firstUserText;
  const temporaryTitles = new Set([
    "New conversation",
    createConversationTitle(firstUserText),
    createConversationTitle(firstLine),
    legacyFirstLineTitle(firstUserText)
  ]);

  for (const temporaryTitle of additionalTemporaryTitles) {
    temporaryTitles.add(temporaryTitle);
    temporaryTitles.add(createConversationTitle(temporaryTitle));
  }

  return temporaryTitles.has(title);
}

function normalizeConversationTitle(text: string): string {
  const normalized = text
    .split(/\s+/u)
    .filter(Boolean)
    .join(" ")
    .replace(/[.!?]+$/u, "");
  if (!normalized) {
    return "New conversation";
  }
  return normalized;
}

function truncateConversationTitle(text: string): string {
  const firstLine = text.split(/\r?\n/u)[0]?.trim() ?? "";
  if (!firstLine) {
    return "New conversation";
  }
  return firstLine.length > 60 ? `${firstLine.slice(0, 57).trimEnd()}...` : firstLine;
}

function legacyFirstLineTitle(text: string): string {
  const firstLine = text.split("\n")[0]?.trim() ?? "New conversation";
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine || "New conversation";
}
