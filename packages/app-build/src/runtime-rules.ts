import type { PageBuildError } from "./errors";

/** Authoring checks, not a security boundary. The frame sandbox and CSP remain the boundary. */
export const RULES = [
  {
    id: "browser_dialog",
    match: ["alert", "confirm", "prompt", "print"],
    sentence: "Apps cannot use browser alert, confirm, prompt or print dialogs.",
    fix: "Use ConfirmDialog or Dialog from the kit, or an HTML `<dialog>`."
  },
  {
    id: "new_window",
    match: ["open", "a[target=_blank]"],
    sentence: 'Apps cannot open a new window with window.open or a link with target="_blank".',
    fix: "Use the kit's navigate or files.open."
  },
  {
    id: "top_navigation",
    match: ["top", "parent", "postMessage"],
    sentence: "Apps cannot access the parent or top frame or use postMessage directly.",
    fix: "Use the kit's navigate and client."
  },
  {
    id: "browser_storage",
    match: ["localStorage", "sessionStorage", "indexedDB", "document.cookie"],
    sentence: "Apps cannot use browser localStorage, sessionStorage, indexedDB or document.cookie.",
    fix: "Use the kit's storage.get/set; keep shared records in Data Stores."
  },
  {
    id: "direct_network",
    match: ["fetch", "XMLHttpRequest", "WebSocket", "EventSource"],
    sentence:
      "Apps cannot use fetch, XMLHttpRequest, WebSocket or EventSource when the manifest names no external host.",
    fix: "Use a named action."
  }
] as const;

export type RuntimeRuleId = (typeof RULES)[number]["id"];

export const RUNTIME_RULES_INTRO =
  "The frame has no modals, popups, top navigation, browser storage or direct network; everything goes through the kit. Builds check new source only; stored revisions, including publishing an older revision, are unchanged. These authoring checks are not a security boundary: the sandbox and CSP remain the boundary. A declared external host permits direct network subject to the frame's CSP.";

/** Shared by tool descriptions, the skill and the generated docs section. */
export function renderRuntimeRules(): string {
  return `${RUNTIME_RULES_INTRO}\n\n${RULES.map((rule) => `- ${rule.sentence} ${rule.fix}`).join("\n")}`;
}

export function runtimeRuleError(
  id: RuntimeRuleId
): Pick<PageBuildError, "code" | "rule" | "sentence" | "fix" | "message"> {
  const rule = RULES.find((rule) => rule.id === id);
  if (!rule) throw new Error(`Unknown runtime rule: ${id}`);
  return {
    code: "runtime_rule",
    rule: rule.id,
    sentence: rule.sentence,
    fix: rule.fix,
    message: `${rule.id}: ${rule.sentence} ${rule.fix}`
  };
}
