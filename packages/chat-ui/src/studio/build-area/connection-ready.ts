import type { TranslationContextValue, TranslationKey } from "../../shared/i18n";

// What the New connection dialog tells the conversation whose agent proposed the Connection,
// once it is connected (CHAT-CONN-1). The person's tab sends it as their message, so it reads
// as theirs: what is connected, under which id, and which tools they approved for what. It
// names no address and holds no key: only what the card showed and the dialog's own outcome.

type Translate = TranslationContextValue["t"];

/** How many tool names the message lists before it stops. */
const NAMED_TOOLS_MAX = 20;

const SURFACE_WORDS: Readonly<Record<string, TranslationKey>> = {
  agent: "connectionCreate.readySurfaceAgent",
  bridge: "connectionCreate.readySurfaceBridge",
  workflow: "connectionCreate.readySurfaceWorkflow"
};

/** What the dialog ended with. */
export type ConnectionReadyOutcome =
  /** The person approved these tools, by their names, for these uses. */
  | { kind: "approved"; tools: readonly string[]; surfaces: readonly string[] }
  /** Connected, and no tool is approved yet. */
  | { kind: "none" }
  /** A REST API is connected, and the person asks the agent to draft its tools. */
  | { kind: "draft" };

function listed(words: readonly string[], and: string): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} ${and} ${words.at(-1) ?? ""}`;
}

export function connectionReadyMessage(
  connection: { name: string; title: string },
  outcome: ConnectionReadyOutcome,
  t: Translate
): string {
  const { name, title } = connection;
  if (outcome.kind === "draft") return t("connectionCreate.readyDraft", { title, name });
  if (outcome.kind === "none" || outcome.tools.length === 0) {
    return t("connectionCreate.readyNoTools", { title, name });
  }
  const and = t("connectionCreate.readyAnd");
  const surfaces = listed(
    outcome.surfaces.flatMap((surface) => {
      const word = SURFACE_WORDS[surface];
      return word === undefined ? [] : [t(word)];
    }),
    and
  );
  const named = outcome.tools.slice(0, NAMED_TOOLS_MAX);
  const tools = named.join(", ") + (outcome.tools.length > named.length ? ", …" : "");
  return outcome.tools.length === 1
    ? t("connectionCreate.readyToolsOne", { title, name, surfaces, tools })
    : t("connectionCreate.readyTools", {
        title,
        name,
        count: outcome.tools.length,
        surfaces,
        tools
      });
}
