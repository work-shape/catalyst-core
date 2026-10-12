/** A tool's rows as an MCP result: structured, and the same as text for a client that reads only text. */
export function toolResult(structuredContent: Record<string, unknown>) {
  return {
    structuredContent,
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }]
  };
}

/** A refusal the caller can act on, as one plain sentence. */
export function toolError(sentence: string) {
  return { isError: true, content: [{ type: "text" as const, text: sentence }] };
}
