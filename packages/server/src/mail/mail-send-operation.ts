import {
  AppError,
  MAIL_AUDIT_MAX_DOMAINS,
  MAIL_SEND_ERROR_CODES,
  MAIL_SEND_FAILURE_REASONS,
  MAIL_SEND_INTERRUPTED_REASON,
  MAIL_SEND_MAX_ADDRESSES,
  MAIL_SEND_OPERATION,
  MAIL_SEND_UNSENT_REASON,
  MAIL_SENDER_RESOURCE_KIND,
  MAIL_SENDER_SYSTEM,
  MAIL_SENDER_USE_ACTION,
  WORKFLOW_ASSET_KIND,
  asCollaborationWorkspaceId,
  asUserId,
  auditActorFromIdentity,
  isAuthenticatedServicePrincipal,
  mailDomainAllowed,
  mailDomainOf,
  mailSendContract,
  mailSendInputSchema,
  type AuthenticatedIdentity,
  type ClientInstanceId,
  type LocaleCode,
  type MailPreviewRecipient,
  type MailSendInput,
  type MailSendOutput,
  type MailSendRecipientList,
  type MailSendSimulatedOutput,
  type OperationDefinition,
  type OperationOrigin,
  type OperationRegistry,
  type OperationSimulationContext,
  type PlatformStores,
  type UserRecord
} from "@work-shape/catalyst-core";
import type {
  MailRecipient,
  MailSender,
  WorkflowMessageMailMessage
} from "@work-shape/catalyst-mail";
import { z } from "zod";

// The operation `mail.send` with the system sender (MAIL-1). It exists on an instance only
// while release config switches `infrastructure.mail.outbound` on, and decides who may be
// mailed: the address of a person of the instance always, any other address only in a domain
// of `recipientDomains`. A Workflow step and an agent's tool call reach the same send path,
// policy and audit. Its audit events carry counts, domains and reasons, and never an address,
// a subject or a body. Spec: events-workflows-and-guardrails.md, "Sending e-mail".

/** One call: resolving recipients, rendering, and the provider's answer within its own time. */
const MAIL_SEND_TIMEOUT_MS = 60_000;

/**
 * Why a call failed beside the refusals of the contract: input the operation cannot send, such
 * as more than 50 addresses once workspaces are expanded. A step takes it as its code.
 */
const MAIL_INPUT_INVALID_REASON = "input_invalid";

export interface MailSendOperationOptions {
  clientInstanceId: ClientInstanceId;
  stores: Pick<PlatformStores, "users" | "workspaces" | "workflowRuns" | "configAssets">;
  /** The instance's mailer, rendering in the frame of `workflow-message`. */
  sender: Pick<MailSender, "send" | "preview">;
  /** The system sender as `infrastructure.mail.sender` names it. */
  system: { fromAddress: string; fromName: string; replyTo?: string };
  /** `infrastructure.mail.outbound.recipientDomains`. */
  recipientDomains: readonly string[];
  /** The frame's language where a call names none. */
  defaultLocale: LocaleCode;
}

/** A recipient as the send uses it: an address, and whether it is a person of the instance. */
interface ResolvedRecipient {
  email: string;
  /** What a preview shows: a person's name, else the address. */
  label: string;
  person: boolean;
}

/** The recipients of one call, before the rule is asked. */
interface ResolvedEnvelope {
  to: ResolvedRecipient[];
  cc: ResolvedRecipient[];
  bcc: ResolvedRecipient[];
  replyTo?: ResolvedRecipient;
  /** People and members without an address, and ids that name nobody. */
  skipped: number;
}

/** A refusal of a call that sent nothing: the reason, and the one domain where it is the rule's. */
type MailRefusal =
  | { reason: typeof MAIL_SEND_ERROR_CODES.recipientNotAllowed; domain: string }
  | { reason: typeof MAIL_SEND_ERROR_CODES.noRecipient }
  | { reason: typeof MAIL_SEND_ERROR_CODES.mailRejected; providerCode?: string };

/** The active person of the instance whose address this is, where one is. */
export async function activePersonOf(
  stores: Pick<PlatformStores, "users">,
  clientInstanceId: ClientInstanceId,
  email: string
): Promise<UserRecord | undefined> {
  const found = await stores.users.listUsers({ clientInstanceId, text: email, activeOnly: true });
  const wanted = email.toLowerCase();
  return found.find((user) => user.email?.toLowerCase() === wanted);
}

export function registerMailSendOperation(
  registry: Pick<OperationRegistry, "register">,
  options: MailSendOperationOptions
): void {
  registry.register(mailSendOperation(options));
}

export function mailSendOperation(
  options: MailSendOperationOptions
): OperationDefinition<MailSendInput, MailSendOutput> {
  const { clientInstanceId, stores } = options;

  const personOf = (email: string) => activePersonOf(stores, clientInstanceId, email);

  async function userOf(id: string): Promise<UserRecord | undefined> {
    const user = await stores.users.getUser({ clientInstanceId, userId: asUserId(id) });
    return user?.status === "active" ? user : undefined;
  }

  const personRecipient = (user: UserRecord & { email: string }): ResolvedRecipient => ({
    email: user.email,
    label: user.displayLabel || user.email,
    person: true
  });

  /** The recipients of one field: addresses as written, people and the members of workspaces. */
  async function resolveList(
    value: MailSendRecipientList | undefined
  ): Promise<{ recipients: ResolvedRecipient[]; skipped: number }> {
    if (value === undefined) return { recipients: [], skipped: 0 };
    const items = typeof value === "string" ? [value] : value;
    const recipients: ResolvedRecipient[] = [];
    let skipped = 0;
    const address = async (email: string) => {
      const person = await personOf(email);
      recipients.push(
        person?.email
          ? personRecipient({ ...person, email: person.email })
          : { email, label: email, person: false }
      );
    };
    for (const item of items) {
      if (typeof item === "string") await address(item);
      else if ("address" in item && typeof item.address === "string") await address(item.address);
      else if ("user" in item && typeof item.user === "string") {
        const user = await userOf(item.user);
        if (user?.email) recipients.push(personRecipient({ ...user, email: user.email }));
        else skipped += 1;
      } else if ("workspace" in item && typeof item.workspace === "string") {
        const members = await membersOf(item.workspace);
        if (!members) {
          skipped += 1;
          continue;
        }
        for (const member of members) {
          if (member?.email) recipients.push(personRecipient({ ...member, email: member.email }));
          else skipped += 1;
        }
      } else if ("email" in item && typeof item.email === "string") await address(item.email);
    }
    return { recipients, skipped };
  }

  /** The active members of a Shared Workspace; nothing for an id that names none. */
  async function membersOf(id: string): Promise<(UserRecord | undefined)[] | undefined> {
    const workspaceId = asCollaborationWorkspaceId(id);
    const workspace = await stores.workspaces.getWorkspace(clientInstanceId, workspaceId);
    if (!workspace || workspace.kind !== "shared") return undefined;
    const memberships = await stores.workspaces.listMemberships({
      clientInstanceId,
      collaborationWorkspaceId: workspaceId
    });
    return Promise.all(memberships.map(({ userId }) => userOf(userId)));
  }

  async function resolveEnvelope(input: MailSendInput): Promise<ResolvedEnvelope> {
    const [to, cc, bcc] = await Promise.all([
      resolveList(input.to),
      resolveList(input.cc),
      resolveList(input.bcc)
    ]);
    let replyTo: ResolvedRecipient | undefined;
    let skipped = to.skipped + cc.skipped + bcc.skipped;
    if (input.replyTo !== undefined) {
      const reply = typeof input.replyTo === "string" ? { address: input.replyTo } : input.replyTo;
      const resolved = await resolveList([reply]);
      replyTo = resolved.recipients[0];
      skipped += resolved.skipped;
    }
    // One mail reaches an address once: in `to` before `cc` before `bcc`.
    const seen = new Set<string>();
    const once = (list: ResolvedRecipient[]) =>
      list.filter((recipient) => {
        const key = recipient.email.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    return {
      to: once(to.recipients),
      cc: once(cc.recipients),
      bcc: once(bcc.recipients),
      ...(replyTo ? { replyTo } : {}),
      skipped
    };
  }

  /**
   * The recipient rule: an address outside the instance's people and outside every listed
   * domain refuses the whole mail, naming the first such domain. A mail left with nobody in
   * `to` is refused, and so is one of more than 50 addresses.
   */
  function refusalOf(envelope: ResolvedEnvelope): MailRefusal | undefined {
    const everyone = [
      ...envelope.to,
      ...envelope.cc,
      ...envelope.bcc,
      ...(envelope.replyTo ? [envelope.replyTo] : [])
    ];
    const outside = everyone.find(
      (recipient) =>
        !recipient.person &&
        !mailDomainAllowed(mailDomainOf(recipient.email), options.recipientDomains)
    );
    if (outside) {
      return {
        reason: MAIL_SEND_ERROR_CODES.recipientNotAllowed,
        domain: mailDomainOf(outside.email)
      };
    }
    if (envelope.to.length === 0) return { reason: MAIL_SEND_ERROR_CODES.noRecipient };
    return undefined;
  }

  function assertBound(envelope: ResolvedEnvelope): void {
    const count = envelope.to.length + envelope.cc.length + envelope.bcc.length;
    if (count > MAIL_SEND_MAX_ADDRESSES) {
      throw new AppError(
        "VALIDATION_FAILED",
        `The mail reaches ${count} addresses once its workspaces are expanded, and one mail reaches at most ${MAIL_SEND_MAX_ADDRESSES}`,
        { reason: MAIL_INPUT_INVALID_REASON, field: "to" },
        { exposeMessage: true, changedNothing: true }
      );
    }
  }

  /** Who sent the mail, for the frame's footer: the Workflow by its name, or the person. */
  async function sentByOf(
    origin: OperationOrigin,
    actor: AuthenticatedIdentity
  ): Promise<WorkflowMessageMailMessage["params"]["sentBy"]> {
    if (origin.kind === "workflow") {
      const run = await stores.workflowRuns.readRun({ clientInstanceId, id: origin.workflowRunId });
      const workflow = run?.workflow ?? "Workflow";
      const asset =
        run &&
        (await stores.configAssets.getConfigAsset({
          clientInstanceId,
          kind: WORKFLOW_ASSET_KIND,
          name: run.workflow
        }));
      const title = workflowTitleSchema.safeParse(asset?.config).data?.manifest.name;
      return { kind: "workflow", workflowName: (title ?? workflow).slice(0, 200) };
    }
    return {
      kind: "agent",
      onBehalfOf: (isAuthenticatedServicePrincipal(actor)
        ? actor.displayLabel
        : actor.displayLabel || actor.email || actor.id
      ).slice(0, 200)
    };
  }

  async function messageOf(
    input: MailSendInput,
    envelope: ResolvedEnvelope,
    context: Pick<OperationSimulationContext, "origin" | "actor">
  ): Promise<WorkflowMessageMailMessage> {
    const contact = (recipient: ResolvedRecipient): MailRecipient =>
      recipient.person
        ? { email: recipient.email, displayLabel: recipient.label }
        : { email: recipient.email };
    return {
      template: "workflow-message",
      params: {
        subject: input.subject,
        markdown: input.body,
        sentBy: await sentByOf(context.origin, context.actor)
      },
      to: envelope.to.map(contact),
      cc: envelope.cc.map(contact),
      bcc: envelope.bcc.map(contact),
      ...(envelope.replyTo ? { replyTo: { email: envelope.replyTo.email } } : {}),
      ...(input.senderName ? { fromName: input.senderName } : {}),
      locale: input.locale ?? options.defaultLocale
    };
  }

  /** The Workflow run or the conversation a call came from: what the mail events name. */
  function originOf(origin: OperationOrigin): {
    kind: "workflow_run" | "conversation";
    id: string;
  } {
    if (origin.kind === "workflow") return { kind: "workflow_run", id: origin.workflowRunId };
    if (origin.kind === "agent") return { kind: "conversation", id: origin.conversationId };
    // A Workflow's step and an agent's tool call are the only callers: nothing else reaches
    // the operation, which has no HTTP face.
    throw new AppError(
      "FORBIDDEN",
      "Only a step of a Workflow or an agent sends e-mail",
      { action: MAIL_SENDER_USE_ACTION, reason: "user_only" },
      { exposeMessage: true, changedNothing: true }
    );
  }

  async function recordRefusal(
    context: Pick<OperationSimulationContext, "audit" | "actor" | "correlationId" | "origin">,
    input: MailSendInput,
    target: "live" | "dry_run",
    refusal: MailRefusal
  ): Promise<void> {
    await context.audit.record({
      type: "mail.refused",
      status: "failed",
      actor: auditActorFromIdentity(context.actor),
      correlationId: context.correlationId,
      subject: input.sender,
      reason: refusal.reason,
      metadata: {
        origin: originOf(context.origin),
        sender: input.sender,
        target,
        reason: refusal.reason,
        ...("domain" in refusal ? { domain: refusal.domain } : {})
      }
    });
  }

  function refusalError(refusal: MailRefusal): AppError {
    const message =
      refusal.reason === MAIL_SEND_ERROR_CODES.recipientNotAllowed
        ? `The mail was sent to nobody: an address in the domain '${refusal.domain}' is neither a person of this instance nor in a domain the instance may mail`
        : refusal.reason === MAIL_SEND_ERROR_CODES.noRecipient
          ? "The mail was sent to nobody: no recipient in 'to' has an address"
          : `The mail provider refused the mail${refusal.providerCode ? ` (${refusal.providerCode})` : ""}, and it was sent to nobody`;
    return new AppError("VALIDATION_FAILED", message, refusal, {
      exposeMessage: true,
      changedNothing: true
    });
  }

  const preview = (recipient: ResolvedRecipient): MailPreviewRecipient => ({
    kind: recipient.person ? "person" : "address",
    label: recipient.label.slice(0, 254)
  });

  return {
    name: MAIL_SEND_OPERATION,
    effect: "changing",
    changeClass: "outward",
    action: MAIL_SENDER_USE_ACTION,
    rightNeededAtPublish: true,
    stepFailureReasons: [...MAIL_SEND_FAILURE_REASONS, MAIL_INPUT_INVALID_REASON],
    retriedReasons: [MAIL_SEND_UNSENT_REASON],
    scope: null,
    auth: "principal",
    inputSchema: mailSendInputSchema,
    outputSchema: mailSendContract.outputSchema,
    // The sender a call names, `system` where it names none: a step's mapping leaves the field
    // out, and the publish asks the right on what the mapping says before any run.
    resource: (input) => {
      const sender = input.sender ?? MAIL_SENDER_SYSTEM;
      return {
        kind: MAIL_SENDER_RESOURCE_KIND,
        id: sender,
        name: sender,
        assetId: sender,
        title: sender === MAIL_SENDER_SYSTEM ? options.system.fromName : sender
      };
    },
    timeoutMs: MAIL_SEND_TIMEOUT_MS,
    async simulate(input, context): Promise<MailSendSimulatedOutput> {
      originOf(context.origin);
      const envelope = await resolveEnvelope(input);
      const refusal = refusalOf(envelope);
      if (refusal) {
        await recordRefusal(context, input, "dry_run", refusal);
        throw refusalError(refusal);
      }
      assertBound(envelope);
      const message = await messageOf(input, envelope, context);
      const rendered = await (options.sender.preview?.(message) ??
        Promise.reject(new AppError("INTERNAL", "The mailer renders no preview")));
      const replyTo = envelope.replyTo?.email ?? options.system.replyTo;
      return {
        simulated: true,
        preview: {
          from: {
            name: input.senderName ?? options.system.fromName,
            address: options.system.fromAddress
          },
          ...(replyTo ? { replyTo } : {}),
          to: envelope.to.map(preview),
          cc: envelope.cc.map(preview),
          bcc: envelope.bcc.map(preview),
          skipped: envelope.skipped,
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text
        }
      };
    },
    async execute(input, context) {
      const origin = originOf(context.origin);
      const envelope = await resolveEnvelope(input);
      const refusal = refusalOf(envelope);
      if (refusal) {
        await recordRefusal(context, input, "live", refusal);
        throw refusalError(refusal);
      }
      assertBound(envelope);
      const message = await messageOf(input, envelope, context);
      const sent = await options.sender.send(
        message,
        context.runtime.signal ? { signal: context.runtime.signal } : undefined
      );
      const recipients = {
        to: envelope.to.length,
        cc: envelope.cc.length,
        bcc: envelope.bcc.length
      };
      if (!sent.ok && sent.failure === "rejected") {
        const rejected: MailRefusal = {
          reason: MAIL_SEND_ERROR_CODES.mailRejected,
          ...(sent.providerCode ? { providerCode: sent.providerCode.slice(0, 100) } : {})
        };
        await recordRefusal(context, input, "live", rejected);
        throw refusalError(rejected);
      }
      if (!sent.ok && sent.failure === "unsent") {
        // Nothing reached the provider: the step's attempts make the call again.
        throw new AppError(
          "CONFLICT",
          "The mail provider could not be reached, and the mail was not sent",
          { reason: MAIL_SEND_UNSENT_REASON },
          { exposeMessage: true, changedNothing: true }
        );
      }
      const accepted = sent.ok;
      const domains = [
        ...new Set(
          [...envelope.to, ...envelope.cc, ...envelope.bcc].map((recipient) =>
            mailDomainOf(recipient.email)
          )
        )
      ].sort();
      await context.audit.record({
        type: "mail.sent",
        status: accepted ? "success" : "failed",
        actor: auditActorFromIdentity(context.actor),
        correlationId: context.correlationId,
        subject: input.sender,
        metadata: {
          origin,
          sender: input.sender,
          target: "live",
          recipients,
          skipped: envelope.skipped,
          domains: domains.slice(0, MAIL_AUDIT_MAX_DOMAINS),
          moreDomains: Math.max(0, domains.length - MAIL_AUDIT_MAX_DOMAINS),
          attachments: { count: 0, bytes: 0 },
          outcome: accepted ? "accepted" : "uncertain"
        }
      });
      if (!sent.ok) {
        // The request left and its answer was lost. The provider takes no key, so the mail is
        // never sent a second time: the step fails and says it may have gone out.
        throw new AppError(
          "TIMEOUT",
          "The answer of the mail provider was lost after the mail left, so it may or may not have been sent",
          { reason: MAIL_SEND_INTERRUPTED_REASON },
          { exposeMessage: true }
        );
      }
      return {
        sentAt: new Date().toISOString(),
        ...(sent.messageId ? { messageId: sent.messageId.slice(0, 256) } : {}),
        recipients,
        skipped: envelope.skipped
      };
    }
  };
}

const workflowTitleSchema = z.object({
  manifest: z.object({ name: z.string().min(1) })
});
