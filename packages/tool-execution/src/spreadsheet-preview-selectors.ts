export function parseSpreadsheetRangeSelector(input: string) {
  const trimmed = input.trim();
  let inQuotedSheet = false;
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (char === "'") {
      if (inQuotedSheet && trimmed[index + 1] === "'") {
        index += 1;
        continue;
      }
      inQuotedSheet = !inQuotedSheet;
      continue;
    }
    if (char === "!" && !inQuotedSheet) {
      return {
        sheetName: unquoteSpreadsheetSheetName(trimmed.slice(0, index)),
        rangeText: trimmed.slice(index + 1).trim()
      };
    }
  }
  return { rangeText: trimmed };
}

export function formatSpreadsheetRangeSelector(sheetName: string, rangeText: string): string {
  return `${quoteSpreadsheetSheetName(sheetName)}!${rangeText}`;
}

export function spreadsheetSelectorKey(value: string): string {
  return value.trim().toLowerCase();
}

export function resolveSpreadsheetSheetName(
  sheetNames: readonly string[],
  requestedSheetName: string | undefined
): string | undefined {
  const requested = requestedSheetName?.trim() || sheetNames[0];
  return requested
    ? sheetNames.find((sheetName) => sheetName.toLowerCase() === requested.toLowerCase())
    : undefined;
}

function unquoteSpreadsheetSheetName(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  return trimmed;
}

function quoteSpreadsheetSheetName(sheetName: string): string {
  return /^[A-Za-z0-9_]+$/u.test(sheetName) ? sheetName : `'${sheetName.replaceAll("'", "''")}'`;
}
