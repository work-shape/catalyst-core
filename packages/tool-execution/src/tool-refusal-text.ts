import {
  operationDenialError,
  AGENT_TOOL_ACTION_PREFIX,
  type LocaleCode,
  type OperationDenial
} from "@work-shape/catalyst-core";

/** What the agent is told about the tool call it made. */
export interface ToolCallNames {
  toolName: string;
  agentName: string;
  correlationId: string;
  /** The reason a tool's own definition gives for its mode, where it gives one. */
  policyReason?: string;
  locale?: LocaleCode;
  adminName?: string;
}

export function denialText(denial: OperationDenial, names: ToolCallNames): string {
  const de = names.locale === "de";
  const withHelp = (message: string) => `${message} ${accessHelpText(names)}`;
  if (denial.kind === "forbidden") {
    if (denial.action?.startsWith(AGENT_TOOL_ACTION_PREFIX)) {
      return withHelp(
        de
          ? "Dieser Agent ist hier nicht für diese Aktion eingerichtet. Es wurde nichts ausgeführt."
          : "This agent is not set up for this action here. Nothing ran."
      );
    }
    if (denial.boundBy)
      return withHelp(
        de
          ? `Dem technischen Konto „${denial.boundBy.label}“ fehlt das nötige Recht für diese Aktion.`
          : `The shared account “${denial.boundBy.label}” lacks the right needed for this action.`
      );
    if (denial.reason === "outside_key_scope")
      return withHelp(
        de
          ? "Der Schlüssel für diese Anfrage deckt diese Aktion nicht ab. Die Person, der er gehört, kann einen passenden Schlüssel ausstellen."
          : "The key used for this request does not cover this action. Its owner can issue a key with the required access."
      );
    return accessRefusalText(names);
  }
  if (denial.kind === "policy") {
    if (denial.reason === "confirmation_required")
      return de
        ? "Diese Aktion braucht die Bestätigung der Person im Gespräch. Es wurde nichts ausgeführt. Der Agent, der dich gestartet hat, kann die Aktion zur Bestätigung vorlegen."
        : "This action needs confirmation from the person in the conversation. Nothing ran. The agent that started you can make the call so the person can confirm it.";
    if (denial.reason === "approval_stale")
      return withHelp(
        de
          ? "Diese Freigabe ist überholt, weil sich die betroffene Version geändert hat. Prüfe die aktuelle Version und frage erneut nach einer Freigabe."
          : "This approval is out of date because the affected version changed. Review the current version and request approval again."
      );
    if (denial.reason === "approval_unavailable")
      return withHelp(
        de
          ? "Diese Aktion braucht die Freigabe einer anderen Person. Hier kann sie nicht auf die Freigabe warten. Es wurde nichts ausgeführt."
          : "This action needs another person's approval and cannot wait for it here. Nothing ran."
      );
    if (denial.reason === "workflow_deleted")
      return withHelp(
        de
          ? "Der Workflow dieser Ausführung wurde gelöscht. Es wurde nichts ausgeführt."
          : "The workflow used for this run was deleted. Nothing ran."
      );
    const message = de
      ? `Diese Aktion ist hier durch eine Regel gesperrt.${names.policyReason ? ` ${names.policyReason}` : ""}`
      : (names.policyReason ?? "A rule prevents this action here.");
    return withHelp(`${message}${/[.!?]$/u.test(message) ? "" : "."}`);
  }
  return operationDenialError(denial).message;
}

function accessHelpText(names: ToolCallNames): string {
  if (names.locale === "de") {
    return names.adminName
      ? `Frag eine Instanz-Admin, zum Beispiel ${names.adminName}.`
      : "Frag eine Instanz-Admin; derzeit ist keine Kontaktperson hinterlegt.";
  }
  return names.adminName
    ? `Ask an instance administrator, for example ${names.adminName}.`
    : "Ask an instance administrator; no contact person is currently listed.";
}

function accessRefusalText(names: ToolCallNames): string {
  return names.locale === "de"
    ? `Du hast hier nicht das nötige Recht für diese Aktion. Es wurde nichts ausgeführt. ${accessHelpText(names)}`
    : `You do not have the right needed for this action here. Nothing ran. ${accessHelpText(names)}`;
}
