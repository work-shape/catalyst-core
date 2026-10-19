import {
  BookOpenCheck,
  Bot,
  Calculator,
  CalendarClock,
  CalendarDays,
  Columns3,
  Contact,
  FlaskConical,
  LayoutTemplate,
  ListPlus,
  MailOpen,
  MessagesSquare,
  NotebookPen,
  PencilLine,
  ReceiptText,
  Table2,
  TextCursorInput,
  Timer,
  type LucideIcon
} from "lucide-react";
import { APP_ASSET_KIND } from "@work-shape/catalyst-api-client";
import {
  DATA_STORE_ASSET_KIND,
  KNOWLEDGE_BASE_ASSET_KIND,
  WORKFLOW_ASSET_KIND
} from "@work-shape/catalyst-core";
import type { TranslationKey } from "../../shared/i18n";
import type { WorkspaceRoute } from "../../shared/routes";

/** A first request about the asset a conversation is about. Choosing it fills the composer. */
interface SubjectStarter {
  icon: LucideIcon;
  title: TranslationKey;
  hint: TranslationKey;
  prompt: TranslationKey;
}

const SUBJECT_STARTERS: Readonly<Record<string, readonly SubjectStarter[]>> = {
  [APP_ASSET_KIND]: [
    {
      icon: TextCursorInput,
      title: "dock.starterAppFieldTitle",
      hint: "dock.starterAppFieldHint",
      prompt: "dock.starterAppFieldPrompt"
    },
    {
      icon: LayoutTemplate,
      title: "dock.starterAppLookTitle",
      hint: "dock.starterAppLookHint",
      prompt: "dock.starterAppLookPrompt"
    }
  ],
  [WORKFLOW_ASSET_KIND]: [
    {
      icon: ListPlus,
      title: "dock.starterWorkflowStepTitle",
      hint: "dock.starterWorkflowStepHint",
      prompt: "dock.starterWorkflowStepPrompt"
    },
    {
      icon: FlaskConical,
      title: "dock.starterWorkflowTestTitle",
      hint: "dock.starterWorkflowTestHint",
      prompt: "dock.starterWorkflowTestPrompt"
    }
  ],
  // A store changes by a new migration: a table or a column. Its rows are not edited here.
  [DATA_STORE_ASSET_KIND]: [
    {
      icon: Table2,
      title: "dock.starterDataStoreTableTitle",
      hint: "dock.starterDataStoreTableHint",
      prompt: "dock.starterDataStoreTablePrompt"
    },
    {
      icon: Columns3,
      title: "dock.starterDataStoreColumnTitle",
      hint: "dock.starterDataStoreColumnHint",
      prompt: "dock.starterDataStoreColumnPrompt"
    }
  ],
  [KNOWLEDGE_BASE_ASSET_KIND]: [
    {
      icon: PencilLine,
      title: "dock.starterKnowledgeDescriptionTitle",
      hint: "dock.starterKnowledgeDescriptionHint",
      prompt: "dock.starterKnowledgeDescriptionPrompt"
    },
    {
      icon: Bot,
      title: "dock.starterKnowledgeAgentTitle",
      hint: "dock.starterKnowledgeAgentHint",
      prompt: "dock.starterKnowledgeAgentPrompt"
    }
  ]
};

/**
 * The first requests for a new asset of a kind, where the dock opened to build one: the same
 * two examples the kind's empty list offers.
 */
const NEW_STARTERS: Readonly<Record<string, readonly SubjectStarter[]>> = {
  [APP_ASSET_KIND]: [
    {
      icon: Calculator,
      title: "apps.exampleFeeTitle",
      hint: "apps.exampleFeeHint",
      prompt: "apps.exampleFeePrompt"
    },
    {
      icon: CalendarDays,
      title: "apps.exampleLeaveTitle",
      hint: "apps.exampleLeaveHint",
      prompt: "apps.exampleLeavePrompt"
    }
  ],
  [WORKFLOW_ASSET_KIND]: [
    {
      icon: CalendarClock,
      title: "workflows.exampleSummaryTitle",
      hint: "workflows.exampleSummaryHint",
      prompt: "workflows.exampleSummaryPrompt"
    },
    {
      icon: ReceiptText,
      title: "workflows.exampleReminderTitle",
      hint: "workflows.exampleReminderHint",
      prompt: "workflows.exampleReminderPrompt"
    }
  ],
  [DATA_STORE_ASSET_KIND]: [
    {
      icon: Contact,
      title: "dataStores.exampleClientsTitle",
      hint: "dataStores.exampleClientsHint",
      prompt: "dataStores.exampleClientsPrompt"
    },
    {
      icon: Timer,
      title: "dataStores.exampleHoursTitle",
      hint: "dataStores.exampleHoursHint",
      prompt: "dataStores.exampleHoursPrompt"
    }
  ],
  agent: [
    {
      icon: MessagesSquare,
      title: "dock.newAgentAnswersTitle",
      hint: "dock.newAgentAnswersHint",
      prompt: "dock.newAgentAnswersPrompt"
    },
    {
      icon: MailOpen,
      title: "dock.newAgentRepliesTitle",
      hint: "dock.newAgentRepliesHint",
      prompt: "dock.newAgentRepliesPrompt"
    }
  ],
  skill: [
    {
      icon: BookOpenCheck,
      title: "dock.newSkillInvoiceTitle",
      hint: "dock.newSkillInvoiceHint",
      prompt: "dock.newSkillInvoicePrompt"
    },
    {
      icon: NotebookPen,
      title: "dock.newSkillNotesTitle",
      hint: "dock.newSkillNotesHint",
      prompt: "dock.newSkillNotesPrompt"
    }
  ]
};

const NEW_GREETINGS: Readonly<Record<string, TranslationKey>> = {
  [APP_ASSET_KIND]: "dock.greetingNewApp",
  [WORKFLOW_ASSET_KIND]: "dock.greetingNewWorkflow",
  [DATA_STORE_ASSET_KIND]: "dock.greetingNewDataStore",
  agent: "dock.greetingNewAgent",
  skill: "dock.greetingNewSkill"
};

/**
 * What the empty conversation is for: an asset it is about, or a new asset of a kind, where
 * the dock was opened beside that kind's pages. Its start page then speaks of that asset and
 * never offers the agent's own welcome and prompts, which are written for a chat of its own.
 */
export type ConversationStart =
  | { about: "asset"; kind: string; title: string | undefined }
  | { about: "new"; kind: string }
  | { about: "try" };

/** The dock kind of the Try tab, whose empty conversation invites a first message. */
export const TRY_DOCK_KIND = "try";

/** The kind of asset a page is about, where the dock beside it builds or changes one. */
export function dockKindOfRoute(route: WorkspaceRoute): string | undefined {
  switch (route.kind) {
    case "apps":
    case "app":
    case "app-edit":
      return APP_ASSET_KIND;
    case "workflows":
    case "workflow":
    case "workflow-runs":
    case "workflow-run":
      return WORKFLOW_ASSET_KIND;
    case "agents":
      return "agent";
    case "build-kind":
    case "build-asset":
      return route.assetKind;
    default:
      return undefined;
  }
}

/** The start of a conversation: its subject where it has one, else the kind beside the dock. */
export function conversationStart(
  subject: { kind: string; title: string | undefined } | undefined,
  dockKind: string | undefined
): ConversationStart | undefined {
  if (subject !== undefined) {
    return { about: "asset", kind: subject.kind, title: subject.title };
  }
  if (dockKind === TRY_DOCK_KIND) return { about: "try" };
  return dockKind === undefined ? undefined : { about: "new", kind: dockKind };
}

/** The heading of the start page, as a key and its values. */
export function startGreeting(start: ConversationStart): {
  key: TranslationKey;
  values?: Record<string, string>;
} {
  if (start.about === "try") return { key: "dock.greetingTry" };
  if (start.about === "asset") {
    return start.title === undefined || start.title.trim() === ""
      ? { key: "dock.greetingAboutUntitled" }
      : { key: "dock.greetingAbout", values: { title: start.title } };
  }
  return { key: NEW_GREETINGS[start.kind] ?? "dock.greetingNewOther" };
}

/**
 * The starters of a conversation's start page, in place of the agent's own: what a person
 * changes on an App, a Workflow, a Data Store or a Knowledge Base, or two examples of a new asset of the kind. None where the
 * kind has none: the agent's own prompts are never offered for an asset.
 */
export function startStarters(start: ConversationStart): readonly SubjectStarter[] {
  if (start.about === "try") return [];
  return (start.about === "asset" ? SUBJECT_STARTERS : NEW_STARTERS)[start.kind] ?? [];
}
