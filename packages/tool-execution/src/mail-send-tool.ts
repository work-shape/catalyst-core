import {
  MAIL_SEND_OPERATION,
  mailSendContract,
  mailSendInputSchema
} from "@work-shape/catalyst-core";
import { defineTool, toolFailed } from "@work-shape/catalyst-tool-sdk";

/**
 * Describes the operation `mail.send` to an agent whose definition lists it (MAIL-1). The
 * operation runner carries the call out through the operation itself, so chat and Workflows
 * share one send path, policy and audit. Registered only while outbound mail is on.
 */
export const MAIL_SEND_TOOL_NAME = MAIL_SEND_OPERATION;

export function createMailSendTool() {
  return defineTool({
    name: MAIL_SEND_TOOL_NAME,
    title: { en: "Send email", de: "E-Mail senden" },
    group: "platform",
    icon: "mail",
    effect: "changing",
    description: `${mailSendContract.description} Use it only when the person asks for an e-mail with content or to an address outside the instance; to tell people of the instance something, a Workflow's notify step puts it in their Inbox. The person confirms every mail before it goes out.`,
    inputSchema: mailSendInputSchema,
    execute: () => toolFailed("handler_failed", "Call mail.send through the operation runner")
  });
}
