import { z } from "zod";
import { defineConfiguredTool, defineTool, toolSuccess } from "@vivd-catalyst/tool-sdk";

const toolConfigSchema = z.object({
  permissionRef: z.string().min(1).default("demo-tools"),
  defaultCurrency: z.string().min(3).max(3).default("EUR")
});

const outputSchema = z.object({
  applicantName: z.string(),
  summary: z.string(),
  grossMonthlyPay: z.number(),
  netMonthlyPay: z.number().optional(),
  currency: z.string(),
  riskFlags: z.array(z.string())
});

export const workflowSummaryToolFactory = defineConfiguredTool({
  name: "demo.workflow_summary",
  configSchema: toolConfigSchema,
  create(config) {
    const inputSchema = createInputSchema(config.defaultCurrency);
    return defineTool({
      name: "demo.workflow_summary",
      description:
        "Summarize structured workflow information and return governance-safe review flags.",
      inputSchema,
      outputSchema,
      inputJsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["applicantName", "grossMonthlyPay"],
        properties: {
          applicantName: { type: "string" },
          grossMonthlyPay: { type: "number", minimum: 0 },
          netMonthlyPay: { type: "number", minimum: 0 },
          currency: { type: "string", minLength: 3, maxLength: 3, default: config.defaultCurrency },
          notes: { type: "string", maxLength: 2000 }
        }
      },
      permission: {
        mode: "allow",
        requiredPermissionRefs: [config.permissionRef]
      },
      async execute(input, context) {
        const riskFlags: string[] = [];
        if (input.grossMonthlyPay === 0) {
          riskFlags.push("missing_income");
        }
        if (input.netMonthlyPay && input.netMonthlyPay > input.grossMonthlyPay) {
          riskFlags.push("net_exceeds_gross");
        }
        if (!context.user.permissionRefs.includes(config.permissionRef)) {
          riskFlags.push("unexpected_permission_context");
        }

        const summary = `${input.applicantName} reports ${formatMoney(
          input.grossMonthlyPay,
          input.currency
        )} gross monthly pay.`;

        return toolSuccess(
          {
            applicantName: input.applicantName,
            summary,
            grossMonthlyPay: input.grossMonthlyPay,
            netMonthlyPay: input.netMonthlyPay,
            currency: input.currency,
            riskFlags
          },
          {
            display: {
              kind: "document.analysis",
              version: 1,
              mode: "inline",
              data: {
                applicantName: input.applicantName,
                grossMonthlyPay: input.grossMonthlyPay,
                currency: input.currency,
                riskFlags
              }
            },
            auditSummary: {
              action: "demo.workflow_summary",
              subject: input.applicantName,
              metadata: {
                flagCount: riskFlags.length
              }
            }
          }
        );
      }
    });
  }
});

export const workflowSummaryTool = workflowSummaryToolFactory.create(toolConfigSchema.parse({}));

function createInputSchema(defaultCurrency: string) {
  return z.object({
    applicantName: z.string().min(1),
    grossMonthlyPay: z.number().nonnegative(),
    netMonthlyPay: z.number().nonnegative().optional(),
    currency: z.string().min(3).max(3).default(defaultCurrency),
    notes: z.string().max(2000).optional()
  });
}

function formatMoney(amount: number, currency: string): string {
  return new Intl.NumberFormat("en", {
    style: "currency",
    currency,
    maximumFractionDigits: 0
  }).format(amount);
}
