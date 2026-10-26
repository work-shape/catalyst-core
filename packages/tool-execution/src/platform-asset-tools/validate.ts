import type { ConversationSubject, ToolExecutionContext } from "@work-shape/catalyst-core";
import { defineTool, toolSuccess, type AnyToolDefinition } from "@work-shape/catalyst-tool-sdk";
import { z } from "zod";
import { PLATFORM_ASSET_TOOLS } from "./names";
import {
  BOUND,
  configSchema,
  createdDraftOf,
  issueSchema,
  kindSchema,
  nameSchema,
  type PlatformAssetIssue,
  type PlatformAssetWarning
} from "./shapes";

const { validate } = PLATFORM_ASSET_TOOLS;

/** What carries out the tool that checks a definition. */
export interface PlatformAssetValidateCalls {
  /** Checks `config` as a save of the subject, or of the created draft `named`, would. */
  validate(
    context: ToolExecutionContext,
    config: Record<string, unknown>,
    named?: ConversationSubject
  ): Promise<{ issues: PlatformAssetIssue[]; warnings?: PlatformAssetWarning[] }>;
}

const validateOutputSchema = z.object({
  valid: z.boolean(),
  issues: z.array(issueSchema),
  warnings: z.array(z.object({ code: z.string(), message: z.string() })).optional()
});

/** The tool that checks a definition as a save of it would, saving nothing. */
export function createValidateAssetTool(calls: PlatformAssetValidateCalls): AnyToolDefinition {
  return defineTool({
    name: validate.name,
    title: { en: "Check asset", de: "Asset prüfen" },
    summary: {
      en: "Checks a definition for problems without saving it.",
      de: "Prüft eine Definition auf Fehler, ohne sie zu speichern."
    },
    group: "platform",
    icon: "guide",
    effect: validate.effect,
    description: [
      "Check a definition without saving it, with the checks a save runs: answers each issue with its path, a sentence and maybe a code; an empty list passes. A warning refuses nothing: correct it or tell the person.",
      BOUND
    ].join(" "),
    inputSchema: z.object({
      config: configSchema,
      kind: kindSchema
        .optional()
        .describe("Only for a draft this conversation created: its kind, with 'name'."),
      name: nameSchema
        .optional()
        .describe("Only for a draft this conversation created: its name, with 'kind'.")
    }),
    outputSchema: validateOutputSchema,
    async execute(input, context) {
      const { issues, warnings } = await calls.validate(
        context,
        input.config,
        createdDraftOf(input)
      );
      return toolSuccess(
        { valid: issues.length === 0, issues, ...(warnings ? { warnings } : {}) },
        { auditSummary: { action: validate.name, metadata: { issueCount: issues.length } } }
      );
    }
  });
}
