/**
 * The icons an agent's author may give one of the agent's own starters, by name. The interface
 * draws each from its icon registry. A name outside this list is refused when an agent is
 * written; a starter without one shows the icon of an author's request.
 */
export const STARTER_ICON_NAMES = [
  "file-text",
  "file-signature",
  "clipboard-list",
  "list-checks",
  "pencil",
  "book-open",
  "message-square",
  "mail",
  "calendar",
  "search",
  "lightbulb",
  "sparkles",
  "users",
  "home",
  "building",
  "landmark",
  "key",
  "scale",
  "banknote",
  "receipt",
  "calculator",
  "chart",
  "ruler",
  "globe"
] as const;

export type StarterIconName = (typeof STARTER_ICON_NAMES)[number];

export function isStarterIconName(value: unknown): value is StarterIconName {
  return (STARTER_ICON_NAMES as readonly unknown[]).includes(value);
}
