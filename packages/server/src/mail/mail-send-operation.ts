import {
  AppError,
  MAIL_AUDIT_MAX_DOMAINS,
  MAIL_SEND_ERROR_CODES,
  MAIL_SEND_FAILURE_REASONS,
  MAIL_SEND_INTERRUPTED_REASON,
  MAIL_SEND_MAX_ADDRESSES,
  MAIL_OUTBOUND_DEFAULT_LIMITS,
  MAIL_SEND_OPERATION,
  MAIL_SEND_RATE_LIMITED_REASON,
  MAIL_SEND_UNSENT_REASON,
  MAIL_SENDER_RESOURCE_KIND,
  MAIL_SENDER_SYSTEM,
  MAIL_SENDER_USE_ACTION,
  WORKFLOW_ASSET_KIND,
  asCollaborationWorkspaceId,
  asUserId,
  auditActorFromIdentity,
  authenticatedUserFromRecord,
  createAuthorizer,
  getSubjectUserId,
  isAuthenticatedServicePrincipal,
  mailCopyRecipientListSchema,
  mailDomainAllowed,
  mailDomainOf,
  mailRecipientSchema,
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
  type OperationExecutionContext,
  type OperationLimitWindow,
  type OperationOrigin,
  type OperationRegistry,
  type OperationSimulationContext,
  type OperationTarget,
  type PlatformStores,
  type JsonObject,
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
//
// MAIL-2 makes it safe to switch on: a test run's "Run live once" sends the mail to the tester
// alone (`liveOnceTarget`), a live call takes a place within `outbound.limits` first, and the
// guardrails of `operation.before_call` read the subject, the body and the recipients' domains
// (`guardrailInput`), never an address.

/** One call: resolving recipients, rendering, and the provider's answer within its own time. */
const MAIL_SEND_TIMEOUT_MS = 60_000;

/**
 * Why a call failed beside the refusals of the contract: input the operation cannot send, such
 * as more than 50 addresses once workspaces are expanded. A step takes it as its code.
 */
const MAIL_INPUT_INVALID_REASON = "input_invalid";

/** Who sees who is in every workspace, and so may mail any Shared Workspace (RIGHTS-1f). */
const USERS_MANAGE = "users.manage";

export interface MailSendOperationOptions {
  clientInstanceId: ClientInstanceId;
  stores: Pick<
    PlatformStores,
    | "users"
    | "workspaces"
    | "access"
    | "workflowRuns"
    | "configAssets"
    | "operationRuns"
    | "workflowNotices"
  >;
  /** The instance's mailer, rendering in the frame of `workflow-message`. */
  sender: Pick<MailSender, "send" | "preview">;
  /** The system sender as `infrastructure.mail.sender` names it. */
  system: { fromAddress: string; fromName: string; replyTo?: string };
  /** `infrastructure.mail.outbound.recipientDomains`. */
  recipientDomains: readonly string[];
  /** The frame's language where a call names none. */
  defaultLocale: LocaleCode;
  /** `infrastructure.mail.outbound.limits`; the defaults of the contract where unset. */
  limits?: { perWorkflowPerHour: number; perInstancePerDay: number };
  now?: () => Date;
}

/**
 * The input the operation parses: the contract's, with a `to` that may hold nobody. A step's
 * reference can resolve to an empty list, and such a mail is refused as `no_recipient` and
 * recorded, as one whose people have no address is. A literal `to` still needs one entry at
 * save, and an agent's tool still names one.
 */
const mailSendCallInputSchema = mailSendInputSchema.extend({ to: mailCopyRecipientListSchema });

const HOUR_SECONDS = 3_600;
const DAY_SECONDS = 86_400;

/** Whether the author of a call may mail the members of a workspace (`workspaceMailableBy`). */
type WorkspaceSight = (workspaceId: string) => Promise<boolean>;

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
  /** A `{ workspace }` the author may not mail: its members were not read. */
  hiddenWorkspace: boolean;
}

/** A refusal of a call that sent nothing: the reason, and the one domain where it is the rule's. */
type MailRefusal =
  | { reason: typeof MAIL_SEND_ERROR_CODES.recipientNotAllowed; domain: string }
  | { reason: typeof MAIL_SEND_ERROR_CODES.noRecipient }
  | { reason: typeof MAIL_SEND_ERROR_CODES.workspaceNotAllowed }
  | { reason: typeof MAIL_SEND_ERROR_CODES.mailRejected; providerCode?: string };

/** What one item of a recipient list names. */
export type MailRecipientItem =
  | { kind: "address"; email: string }
  | { kind: "user"; id: string }
  | { kind: "workspace"; id: string };

/**
 * The items of a recipient list as the rule and the send read them. A record of an earlier
 * result is taken by its `email` alone: the schema lets its other fields through unchecked,
 * so a record's `address`, `user` or `workspace` never names a recipient.
 */
export function mailRecipientItemsOf(value: MailSendRecipientList): MailRecipientItem[] {
  const items = typeof value === "string" ? [value] : value;
  return items.flatMap((item): MailRecipientItem[] => {
    if (typeof item === "string") return [{ kind: "address", email: item }];
    const named = mailRecipientSchema.safeParse(item);
    if (named.success) {
      const recipient = named.data;
      if ("address" in recipient) return [{ kind: "address", email: recipient.address }];
      if ("user" in recipient) return [{ kind: "user", id: recipient.user }];
      return [{ kind: "workspace", id: recipient.workspace }];
    }
    return "email" in item && typeof item.email === "string"
      ? [{ kind: "address", email: item.email }]
      : [];
  });
}

/**
 * Whether a person may mail the members of a workspace (MAIL-2): a Shared Workspace they are a
 * member of, or any Shared Workspace for a holder of `users.manage` on the whole instance, who
 * sees who is in each workspace already (RIGHTS-1f). Nobody else learns who is in it, and no
 * Personal Workspace is ever mailed. Nobody (`undefined`) may mail none.
 */
export async function workspaceMailableBy(
  stores: Pick<PlatformStores, "users" | "workspaces" | "access">,
  clientInstanceId: ClientInstanceId,
  workspaceId: string,
  author: string | undefined
): Promise<boolean> {
  if (author === undefined) return false;
  const id = asCollaborationWorkspaceId(workspaceId);
  const [workspace, user] = await Promise.all([
    stores.workspaces.getWorkspace(clientInstanceId, id),
    stores.users.getUser({ clientInstanceId, userId: asUserId(author) })
  ]);
  if (workspace?.kind !== "shared" || user?.status !== "active") return false;
  if (await managesUsers(stores, user)) return true;
  const membership = await stores.workspaces.getMembership({
    clientInstanceId,
    collaborationWorkspaceId: id,
    userId: user.id
  });
  return membership !== undefined;
}

/**
 * The person holds `users.manage` on the whole instance, as their record and rows say now: by
 * a role, a custom one included, or by the key given them, and a deny takes it away.
 */
async function managesUsers(
  stores: Pick<PlatformStores, "access">,
  user: UserRecord
): Promise<boolean> {
  const actor = authenticatedUserFromRecord({
    user,
    identity: { authSource: "mail-workspace", externalUserId: user.id }
  });
  const access = await createAuthorizer(stores.access).forActor(actor);
  return access.authorize(USERS_MANAGE).allowed;
}

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
    value: MailSendRecipientList | undefined,
    sees: WorkspaceSight
  ): Promise<{ recipients: ResolvedRecipient[]; skipped: number; hidden: boolean }> {
    if (value === undefined) return { recipients: [], skipped: 0, hidden: false };
    const recipients: ResolvedRecipient[] = [];
    let skipped = 0;
    let hidden = false;
    const address = async (email: string) => {
      const person = await personOf(email);
      recipients.push(
        person?.email
          ? personRecipient({ ...person, email: person.email })
          : { email, label: email, person: false }
      );
    };
    for (const item of mailRecipientItemsOf(value)) {
      if (item.kind === "address") await address(item.email);
      else if (item.kind === "user") {
        const user = await userOf(item.id);
        if (user?.email) recipients.push(personRecipient({ ...user, email: user.email }));
        else skipped += 1;
      } else {
        // A workspace the author may not mail is never read: no member of it is named.
        if (!(await sees(item.id))) {
          hidden = true;
          continue;
        }
        const members = await membersOf(item.id);
        if (!members) {
          skipped += 1;
          continue;
        }
        for (const member of members) {
          if (member?.email) recipients.push(personRecipient({ ...member, email: member.email }));
          else skipped += 1;
        }
      }
    }
    return { recipients, skipped, hidden };
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

  async function resolveEnvelope(
    input: MailSendInput,
    sees: WorkspaceSight
  ): Promise<ResolvedEnvelope> {
    const [to, cc, bcc] = await Promise.all([
      resolveList(input.to, sees),
      resolveList(input.cc, sees),
      resolveList(input.bcc, sees)
    ]);
    let replyTo: ResolvedRecipient | undefined;
    let skipped = to.skipped + cc.skipped + bcc.skipped;
    if (input.replyTo !== undefined) {
      const reply = typeof input.replyTo === "string" ? { address: input.replyTo } : input.replyTo;
      const resolved = await resolveList([reply], sees);
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
      skipped,
      hiddenWorkspace: to.hidden || cc.hidden || bcc.hidden
    };
  }

  /**
   * Who a call's mail is the mail of, for the workspaces it may name: the person who calls, as
   * an agent's person or a test run's tester, and for a published run the person who published
   * the revision it runs. A run of a revision nobody published as a person mails no workspace.
   */
  async function authorOf(
    context: Pick<OperationSimulationContext, "actor" | "origin">
  ): Promise<string | undefined> {
    if (!isAuthenticatedServicePrincipal(context.actor)) return getSubjectUserId(context.actor);
    if (context.origin.kind !== "workflow") return undefined;
    const run = await stores.workflowRuns.readRun({
      clientInstanceId,
      id: context.origin.workflowRunId
    });
    return run
      ? stores.workflowNotices.publisher({ clientInstanceId, revisionId: run.definitionRevisionId })
      : undefined;
  }

  async function sightOf(
    context: Pick<OperationSimulationContext, "actor" | "origin">
  ): Promise<WorkspaceSight> {
    const author = await authorOf(context);
    return (workspaceId) => workspaceMailableBy(stores, clientInstanceId, workspaceId, author);
  }

  /**
   * The recipient rule: an address outside the instance's people and outside every listed
   * domain refuses the whole mail, naming the first such domain. A mail left with nobody in
   * `to` is refused, and so is one of more than 50 addresses.
   */
  function refusalOf(envelope: ResolvedEnvelope): MailRefusal | undefined {
    if (envelope.hiddenWorkspace) return { reason: MAIL_SEND_ERROR_CODES.workspaceNotAllowed };
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
    context: Pick<
      OperationSimulationContext,
      "audit" | "actor" | "correlationId" | "origin" | "runId"
    >,
    input: MailSendInput,
    target: OperationTarget,
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
        operationRunId: context.runId,
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
          : refusal.reason === MAIL_SEND_ERROR_CODES.workspaceNotAllowed
            ? "The mail was sent to nobody: it names a workspace that is not a Shared Workspace its author is a member of"
            : `The mail provider refused the mail${refusal.providerCode ? ` (${refusal.providerCode})` : ""}, and it was sent to nobody`;
    return new AppError("VALIDATION_FAILED", message, refusal, {
      exposeMessage: true,
      changedNothing: true
    });
  }

  /**
   * The Workflows a call from a run counts toward: the run's own and the Workflow of every
   * run above it, since a Workflow's limit counts its runs and their children.
   */
  async function workflowsOf(runId: string): Promise<string[]> {
    const workflows = new Set<string>();
    const seen = new Set<string>();
    let next: string | undefined = runId;
    while (next !== undefined && !seen.has(next)) {
      seen.add(next);
      const run = await stores.workflowRuns.readRun({ clientInstanceId, id: next });
      if (!run) break;
      workflows.add(run.workflow);
      next = run.parentRunId;
    }
    return [...workflows];
  }

  /**
   * Takes the call's place within `outbound.limits`, or refuses it as changing nothing. A
   * step that is refused waits queued until the window has room (the retry it is told); a
   * call from chat is answered `rate_limited`.
   */
  async function admit(context: Pick<OperationExecutionContext, "runId" | "origin">) {
    const limits = options.limits ?? MAIL_OUTBOUND_DEFAULT_LIMITS;
    const at = options.now?.() ?? new Date();
    const windows: OperationLimitWindow[] = [
      { seconds: DAY_SECONDS, calls: limits.perInstancePerDay }
    ];
    if (context.origin.kind === "workflow") {
      for (const workflow of await workflowsOf(context.origin.workflowRunId)) {
        windows.push({ seconds: HOUR_SECONDS, calls: limits.perWorkflowPerHour, workflow });
      }
    }
    const admission = await stores.operationRuns.admitWithinLimits({
      clientInstanceId,
      id: context.runId,
      operation: MAIL_SEND_OPERATION,
      at: at.toISOString(),
      windows
    });
    if (admission.admitted) return;
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((Date.parse(admission.roomAt) - at.getTime()) / 1000)
    );
    const window = windows[admission.window];
    throw new AppError(
      "RATE_LIMITED",
      window?.workflow === undefined
        ? `The instance has sent its ${limits.perInstancePerDay} e-mails of the last 24 hours, and the mail was not sent`
        : `The Workflow has sent its ${limits.perWorkflowPerHour} e-mails of the last hour, and the mail was not sent`,
      { reason: MAIL_SEND_RATE_LIMITED_REASON, retryAfterSeconds },
      { exposeMessage: true, changedNothing: true }
    );
  }

  /** The person testing a draft, by their address: a test mail reaches them alone. */
  async function testerOf(actor: AuthenticatedIdentity): Promise<ResolvedRecipient | undefined> {
    if (isAuthenticatedServicePrincipal(actor)) return undefined;
    const user = await userOf(actor.id);
    return user?.email ? personRecipient({ ...user, email: user.email }) : undefined;
  }

  /** Hands the mail to the provider and records what came of it. */
  async function deliver(
    context: OperationExecutionContext,
    input: MailSendInput,
    target: Exclude<OperationTarget, "dry_run">,
    message: WorkflowMessageMailMessage,
    envelope: Pick<ResolvedEnvelope, "to" | "cc" | "bcc" | "skipped">
  ): Promise<MailSendOutput> {
    const origin = originOf(context.origin);
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
      await recordRefusal(context, input, target, rejected);
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
        operationRunId: context.runId,
        origin,
        sender: input.sender,
        target,
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
      skipped: envelope.skipped,
      ...(target === "test" ? { test: true as const } : {})
    };
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
    // "Run live once" sends the mail to the tester alone and never to its recipients.
    liveOnceTarget: "test",
    stepFailureReasons: [...MAIL_SEND_FAILURE_REASONS, MAIL_INPUT_INVALID_REASON],
    retriedReasons: [MAIL_SEND_UNSENT_REASON],
    scope: null,
    auth: "principal",
    inputSchema: mailSendCallInputSchema,
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
    // What `operation.before_call` reads: the subject, the body as the call resolved it and
    // the recipients' domains. The addresses stay out, so the e-mail preset fires on none.
    async guardrailInput(input, call): Promise<JsonObject> {
      const parsed = mailSendCallInputSchema.safeParse(input);
      if (!parsed.success) {
        // A publish asks before the run resolves a reference: what is written is read.
        const written = writtenTextSchema.safeParse(input).data;
        return {
          ...(written?.subject === undefined ? {} : { subject: written.subject }),
          ...(written?.body === undefined ? {} : { body: written.body }),
          attachmentNames: [],
          recipientDomains: []
        };
      }
      // Only the domains reach the guardrails, and only of the workspaces the call's author
      // may mail: a publish preview, which has no actor, reads no members.
      const envelope = await resolveEnvelope(
        parsed.data,
        call.actor
          ? await sightOf({ actor: call.actor, origin: call.origin })
          : () => Promise.resolve(false)
      );
      const recipientDomains = [
        ...new Set(
          [
            ...envelope.to,
            ...envelope.cc,
            ...envelope.bcc,
            ...(envelope.replyTo ? [envelope.replyTo] : [])
          ].map((recipient) => mailDomainOf(recipient.email))
        )
      ].sort();
      return {
        subject: parsed.data.subject,
        body: parsed.data.body,
        attachmentNames: [],
        recipientDomains
      };
    },
    async simulate(input, context): Promise<MailSendSimulatedOutput> {
      originOf(context.origin);
      const envelope = await resolveEnvelope(input, await sightOf(context));
      const refusal = refusalOf(envelope);
      if (refusal) {
        // A test run's preview is `dry_run`; the preview a confirmation shows is of the call.
        await recordRefusal(context, input, context.target ?? "dry_run", refusal);
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
      originOf(context.origin);
      const target = context.target === "test" ? "test" : "live";
      const envelope = await resolveEnvelope(input, await sightOf(context));
      const refusal = refusalOf(envelope);
      if (refusal) {
        await recordRefusal(context, input, target, refusal);
        throw refusalError(refusal);
      }
      assertBound(envelope);
      const message = await messageOf(input, envelope, context);
      if (target === "test") {
        // "Run live once" of a test run: the rendered mail goes to the tester alone, its
        // subject marked and the recipients it would have reached in a box above the body.
        const tester = await testerOf(context.actor);
        if (!tester) {
          await recordRefusal(context, input, target, {
            reason: MAIL_SEND_ERROR_CODES.noRecipient
          });
          throw new AppError(
            "VALIDATION_FAILED",
            "The test mail was sent to nobody: it goes to the address of the person testing, and they have none",
            { reason: MAIL_SEND_ERROR_CODES.noRecipient },
            { exposeMessage: true, changedNothing: true }
          );
        }
        const test: WorkflowMessageMailMessage = {
          template: message.template,
          params: {
            ...message.params,
            test: {
              intendedRecipients: {
                to: envelope.to.map(preview),
                cc: envelope.cc.map(preview),
                bcc: envelope.bcc.map(preview)
              }
            }
          },
          to: [{ email: tester.email, displayLabel: tester.label }],
          cc: [],
          bcc: [],
          ...(message.fromName ? { fromName: message.fromName } : {}),
          locale: message.locale
        };
        return deliver(context, input, target, test, {
          to: [tester],
          cc: [],
          bcc: [],
          skipped: envelope.skipped
        });
      }
      await admit(context);
      return deliver(context, input, target, message, envelope);
    }
  };
}

const writtenTextSchema = z.object({
  subject: z.string().optional().catch(undefined),
  body: z.string().optional().catch(undefined)
});

const workflowTitleSchema = z.object({
  manifest: z.object({ name: z.string().min(1) })
});
