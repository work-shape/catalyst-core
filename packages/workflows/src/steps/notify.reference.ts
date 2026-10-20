import type { StepReference } from "./module";

/** What the authoring skill says of a `notify` step. */
export const notifyReference = {
  does: "Leaves a notice in each active recipient's Inbox. With mail, queues a counts-only digest and a link; no title, text, client name or finding leaves by mail. Use notify to tell people of the instance that something needs them; for an e-mail with content, or to an address outside the instance, use an `operation` step on `mail.send` where the instance has it. A test simulates this changing step: its result shows wouldHaveDone with the intended recipients and frozen content; it sends no Inbox item or mail.",
  fields: {
    to: "Instance user ids under users and Shared Workspace ids under workspaces (their active members). For 'me', use platform.context caller.id. For a name or email, call platform.context with person and use the returned people match; ask which person if ambiguous, never ask the person to type an id. No free e-mail address.",
    channels: "[inbox], or [inbox, mail]. Every notice has an Inbox item.",
    title: "A mapping { value: text } or { ref: { step, path } }; Inbox only, one line.",
    text: "A mapping { value: text } or { ref: { step, path } }; Inbox only, one paragraph.",
    link: "{ kind: run } (default), or { kind: app, workspaceId: id, app: id }. Ids only."
  }
} satisfies StepReference<"notify">;
