import {
  operationDenialError,
  RIGHT_VERB_WORDS,
  AGENT_TOOL_ACTION_PREFIX,
  isPlatformAction,
  type LocaleCode,
  type OperationDenial,
  type PlatformAction
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
  /** The plain refusal of a missing use right on a Knowledge Base or Connection. */
  useRightRefusal?: string;
}

export function denialText(denial: OperationDenial, names: ToolCallNames): string {
  const de = names.locale === "de";
  const withHelp = (message: string) => `${message} ${accessHelpText(names)}`;
  if (denial.kind === "forbidden") {
    if (denial.action?.startsWith(AGENT_TOOL_ACTION_PREFIX)) {
      return de
        ? `Dieser Agent ist hier nicht für diese Aktion eingerichtet. Es wurde nichts ausgeführt. ${agentSetupHelpText(names)}`
        : `This agent is not set up for this action here. Nothing ran. ${agentSetupHelpText(names)}`;
    }
    const right = rightLabel(denial.action, names.locale);
    if (denial.boundBy)
      return withHelp(
        de
          ? `Dem technischen Konto „${denial.boundBy.label}“ fehlt ${right ? `das Recht „${right}“` : "das nötige Recht für diese Aktion"}.`
          : `The shared account “${denial.boundBy.label}” lacks the right ${right ? `to ${right}` : "needed for this action"}.`
      );
    if (denial.reason === "outside_key_scope")
      return withHelp(
        de
          ? "Der Schlüssel für diese Anfrage deckt diese Aktion nicht ab. Die Person, der er gehört, kann einen passenden Schlüssel ausstellen."
          : "The key used for this request does not cover this action. Its owner can issue a key with the required access."
      );
    return accessRefusalText(right, names);
  }
  if (denial.kind === "policy") {
    if (denial.reason === "confirmation_required")
      return de
        ? `Diese Aktion braucht die Bestätigung der Person im Gespräch. Es wurde nichts ausgeführt. Teile dem Agenten, der dich gestartet hat, mit, dass er '${denial.operation}' mit denselben Argumenten noch aufrufen muss, damit die Person bestätigen kann.`
        : `This action needs confirmation from the person in the conversation. Nothing ran. Tell the agent that started you that it still needs to call '${denial.operation}' with the same arguments so the person can confirm it.`;
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
    // The reason is the tool author's own text in the author's language, so it is quoted as such.
    const message = de
      ? `Diese Aktion ist hier durch eine Regel gesperrt.${names.policyReason ? ` Begründung im Wortlaut der Regel: „${names.policyReason}“` : ""}`
      : `A rule prevents this action here.${names.policyReason ? ` The rule's own words: “${names.policyReason}”` : ""}`;
    return withHelp(message);
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

/** An agent's tools are set by whoever built it; an instance administrator can change them too. */
function agentSetupHelpText(names: ToolCallNames): string {
  if (names.locale === "de") {
    return names.adminName
      ? `Frag die Person, die diesen Agenten gebaut hat, oder eine Instanz-Admin, zum Beispiel ${names.adminName}.`
      : "Frag die Person, die diesen Agenten gebaut hat, oder eine Instanz-Admin.";
  }
  return names.adminName
    ? `Ask the person who built this agent or an instance administrator, for example ${names.adminName}.`
    : "Ask the person who built this agent or an instance administrator.";
}

function accessRefusalText(right: string | undefined, names: ToolCallNames): string {
  if (names.locale === "de") {
    return `${right ? `Du hast hier nicht das Recht „${right}“.` : "Du hast hier nicht das nötige Recht für diese Aktion."} Es wurde nichts ausgeführt. ${accessHelpText(names)}`;
  }
  return `${right ? `You do not have the right to ${right} here.` : "You do not have the right needed for this action here."} Nothing ran. ${accessHelpText(names)}`;
}

/**
 * A missing right in the words every rights screen uses for it (access-and-permissions.md,
 * Words; the interface's copy is `chat-ui/src/admin/access/right-words.ts`). English is the
 * phrase inside a sentence, German the label: "edit skills", "Skills bearbeiten". An action
 * without words is described without its id.
 */
function rightLabel(
  action: string | undefined,
  locale: LocaleCode | undefined
): string | undefined {
  if (action === undefined || !isPlatformAction(action)) return undefined;
  const de = locale === "de";
  if (isOwnWordAction(action)) return OWN_ACTION_WORDS[action][de ? "de" : "en"];
  const [kind, verb] = action.split(".");
  if (!isRightKind(kind) || !isRightVerb(verb)) return undefined;
  return de
    ? `${KIND_WORDS[kind].de} ${RIGHT_VERB_WORDS[verb].de}`
    : `${RIGHT_VERB_WORDS[verb].en} ${KIND_WORDS[kind].en}`;
}

interface Words {
  en: string;
  de: string;
}

const KIND_WORDS = {
  agent: { en: "agents", de: "Agenten" },
  skill: { en: "skills", de: "Skills" },
  connection: { en: "connections", de: "Verbindungen" },
  app: { en: "apps", de: "Apps" },
  workflow: { en: "workflows", de: "Workflows" },
  data_store: { en: "data stores", de: "Datenspeicher" },
  knowledge_base: { en: "knowledge bases", de: "Wissensbasen" },
  guardrail: { en: "guardrails", de: "Leitplanken" }
} as const satisfies Record<string, Words>;

type RightVerb = keyof typeof RIGHT_VERB_WORDS;
type RightKind = keyof typeof KIND_WORDS;
type OwnWordAction = Exclude<PlatformAction, `${RightKind}.${RightVerb}`>;

/** An action core adds does not compile until it is a verb on a kind or has its words here. */
const OWN_ACTION_WORDS: Record<OwnWordAction, Words> = {
  "workflow.read_run_data": {
    en: "view the data of workflow runs",
    de: "Daten der Workflow-Läufe ansehen"
  },
  "data_store.insert": {
    en: "add rows to data stores",
    de: "Datensätze zu Datenspeichern hinzufügen"
  },
  "data_store.execute": {
    en: "change and delete rows in data stores",
    de: "Datensätze in Datenspeichern ändern und löschen"
  },
  "data_store.records": {
    en: "review extracted fields in data stores",
    de: "Extrahierte Felder in Datenspeichern prüfen"
  },
  "mail_sender.use": {
    en: "send e-mail as a sender of the instance",
    de: "E-Mails als Absender der Instanz senden"
  },
  "operations.approve": { en: "approve operation calls", de: "Aufrufe von Operationen freigeben" },
  "feedback.review": { en: "review feedback on agents", de: "Feedback zu Agenten prüfen" },
  "users.manage": { en: "manage users", de: "Benutzer verwalten" },
  "users.delete": { en: "delete users", de: "Benutzer löschen" },
  "usage.view": { en: "view usage", de: "Nutzung ansehen" },
  "limits.manage": { en: "set spend limits", de: "Ausgabenlimits festlegen" },
  "usage.view_users": { en: "view usage by person", de: "Nutzung pro Person ansehen" },
  "audit.view": { en: "view the audit log", de: "Auditprotokoll ansehen" },
  "system.view": { en: "view the System pages", de: "Systemseiten ansehen" },
  "jobs.retry": { en: "retry jobs", de: "Jobs erneut versuchen" },
  "api_access.manage": { en: "manage API access", de: "API-Zugriff verwalten" },
  "service_principals.manage": {
    en: "manage service principals",
    de: "Technische Konten verwalten"
  },
  "roles.edit_built_in": {
    en: "edit the built-in roles User and Admin",
    de: "Eingebaute Rollen Benutzer und Admin bearbeiten"
  },
  "agent_models.manage": {
    en: "manage agent model settings",
    de: "Modelleinstellungen der Agenten verwalten"
  },
  "assets.release": {
    en: "push configuration releases",
    de: "Konfiguration per Release einspielen"
  },
  builder: { en: "build in this workspace", de: "Builder" },
  publisher: { en: "publish in this workspace", de: "Publisher" }
};

function isOwnWordAction(action: PlatformAction): action is OwnWordAction {
  return Object.hasOwn(OWN_ACTION_WORDS, action);
}

function isRightKind(kind: string | undefined): kind is RightKind {
  return kind !== undefined && Object.hasOwn(KIND_WORDS, kind);
}

function isRightVerb(verb: string | undefined): verb is RightVerb {
  return verb !== undefined && Object.hasOwn(RIGHT_VERB_WORDS, verb);
}
