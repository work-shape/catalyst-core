// The @ of the composer (CHAT-SHARE-2): where an @ opens the menu of people, what is typed after
// it searches them, and what a picked person leaves in the text. The text stays plain: a
// picked person is a chip beside the field and "@Name" in it, which is what the model reads.

/** The @ the caret stands after, and what was typed since. */
export interface MentionTrigger {
  /** The position of the @ in the text. */
  at: number;
  /** What follows the @ up to the caret: the search. */
  query: string;
}

/** The longest search an @ takes before it is read as text. */
const MAX_QUERY = 40;

/**
 * The @ the caret is in, or nothing. It opens only at the start of the text or after a space or
 * a line break, so an address such as "anna@example.com" never does, nor an @ inside a code
 * fence. A space right after it ends it, "@ " is text, and so does a line break. A space later
 * on stays in the search, as names have them: "@Ada Lo".
 */
export function findMentionTrigger(text: string, caret: number): MentionTrigger | undefined {
  if (caret < 1 || caret > text.length) return undefined;
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at < 0) return undefined;
  const query = before.slice(at + 1);
  if (query.length > MAX_QUERY || /^\s|[\r\n]/u.test(query)) return undefined;
  const preceding = at === 0 ? undefined : before[at - 1];
  if (preceding !== undefined && !/\s/u.test(preceding)) return undefined;
  if (insideCodeFence(before.slice(0, at))) return undefined;
  return { at, query };
}

/** Whether text that ends here stands inside a ``` fence that is still open. */
function insideCodeFence(text: string): boolean {
  const fences = text.match(/^\s*```/gmu);
  return (fences?.length ?? 0) % 2 === 1;
}

/** The text with the picked person in place of the @ and its search, and where the caret goes. */
export function insertMention(
  text: string,
  trigger: MentionTrigger,
  caret: number,
  name: string
): { text: string; caret: number } {
  const after = text.slice(caret);
  const inserted = `@${name}${after.startsWith(" ") ? "" : " "}`;
  const next = text.slice(0, trigger.at) + inserted + after;
  return { text: next, caret: trigger.at + inserted.length + (after.startsWith(" ") ? 1 : 0) };
}

/** Whether the text still names the picked person as "@Name". */
export function mentionsName(text: string, name: string): boolean {
  return text.includes(`@${name}`);
}

/**
 * The text without the picked people's "@Name": what is left to send. A message that holds only
 * chips shares and sends no turn.
 */
export function withoutMentions(text: string, names: readonly string[]): string {
  let rest = text;
  for (const name of names) rest = rest.split(`@${name}`).join("");
  return rest.trim();
}
