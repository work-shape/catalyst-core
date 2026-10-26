import {
  localeCodes,
  MAIL_SEND_MAX_ADDRESSES,
  MAIL_SEND_OPERATION,
  MAIL_SUBJECT_MAX_LENGTH,
  mailSendContract,
  mailSendInputSchema
} from "@work-shape/catalyst-core";
import { defineTool, deriveInputJsonSchema, toolFailed } from "@work-shape/catalyst-tool-sdk";
import { z } from "zod";

/**
 * Describes the operation `mail.send` to an agent whose definition lists it (MAIL-1). The
 * operation runner carries the call out through the operation itself, so chat and Workflows
 * share one send path, policy and audit. Registered only while outbound mail is on.
 */
export const MAIL_SEND_TOOL_NAME = MAIL_SEND_OPERATION;

// What the model is shown: the recipients an agent writes. The operation's own schema, which
// checks every call, also takes the forms a Workflow step maps from earlier results and a
// sender that is not yet supported; spelled out for `to`, `cc` and `bcc` they cost the model
// more tokens on every call than any other tool.
const recipients = z.union([
  z.email(),
  z
    .array(
      z.union([
        z.email(),
        z.strictObject({ user: z.string() }),
        z.strictObject({ workspace: z.string() })
      ])
    )
    .max(MAIL_SEND_MAX_ADDRESSES)
]);

const modelInputSchema = z.strictObject({
  to: recipients.describe(
    "An address, or a list of addresses, people ({ user: id }) and workspaces ({ workspace: id }, its members)."
  ),
  cc: recipients.optional(),
  bcc: recipients.optional(),
  subject: z.string().max(MAIL_SUBJECT_MAX_LENGTH).describe("One line."),
  body: z.string().describe("Markdown: no raw HTML or images."),
  senderName: z.string().optional().describe("The display name on the From line."),
  replyTo: z.union([z.email(), z.strictObject({ user: z.string() })]).optional(),
  locale: z.enum(localeCodes).optional().describe("The language of the frame around the body.")
});

export function createMailSendTool() {
  return defineTool({
    name: MAIL_SEND_TOOL_NAME,
    title: { en: "Send email", de: "E-Mail senden" },
    group: "platform",
    icon: "mail",
    effect: "changing",
    description: `${mailSendContract.description} Use it only when the person asks for an e-mail with content or to an address outside the instance; to tell people of the instance something, a Workflow's notify step puts it in their Inbox. The person confirms every mail before it goes out.`,
    inputSchema: mailSendInputSchema,
    inputJsonSchema: deriveInputJsonSchema(modelInputSchema),
    execute: () => toolFailed("handler_failed", "Call mail.send through the operation runner")
  });
}
