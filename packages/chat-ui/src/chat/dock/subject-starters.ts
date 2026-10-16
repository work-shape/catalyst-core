import {
  FlaskConical,
  LayoutTemplate,
  ListPlus,
  TextCursorInput,
  type LucideIcon
} from "lucide-react";
import { APP_ASSET_KIND } from "@work-shape/catalyst-api-client";
import { WORKFLOW_ASSET_KIND } from "@work-shape/catalyst-core";
import type { TranslationKey } from "../../shared/i18n";

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
  ]
};

/**
 * The starters of a conversation about an asset of this kind, in place of the agent's own: what
 * a person changes on an App or a Workflow. None for a kind without its own.
 */
export function subjectStarters(kind: string | undefined): readonly SubjectStarter[] | undefined {
  return kind === undefined ? undefined : SUBJECT_STARTERS[kind];
}
