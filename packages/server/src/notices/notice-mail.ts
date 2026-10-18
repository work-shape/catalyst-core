import { noticeMailSettingsSchema } from "@work-shape/catalyst-config-schema";
import {
  defineJobHandler,
  defineJobKind,
  defineSchedule,
  scheduledJobPayloadSchema
} from "@work-shape/catalyst-core";
import type { ChatServerOptions } from "../types";

// One leased tick across the instance, so two processes never mail the same pending digest.
// A crash after the provider accepts and before the delete can repeat a counts-only digest:
// SMTP/provider delivery cannot commit atomically with our database (at-least-once delivery).
const noticeMailJob = defineJobKind({
  kind: "notice.deliver_mail",
  payloadSchema: scheduledJobPayloadSchema,
  maxAttempts: 1,
  backoff: { baseMs: 0, maxMs: 0 },
  leaseMs: 2 * 60 * 1000,
  concurrency: { global: 1 },
  manualRetry: false
});

/** Durable, recipient-specific digests through the existing template-typed mail adapter. */
export function createNoticeMailJobs(
  options: Pick<
    ChatServerOptions,
    "config" | "clientInstanceId" | "stores" | "mail" | "auditRecorder"
  >,
  now: () => Date = () => new Date()
) {
  const { stores, clientInstanceId } = options;
  const settings =
    options.config.infrastructure.mail?.notices ?? noticeMailSettingsSchema.parse({});
  const handler = defineJobHandler({
    kind: noticeMailJob,
    slots: 1,
    async run(_job, control) {
      const { mail } = options;
      if (!mail) return; // A later configured provider drains the durable outbox.
      const before = now().toISOString();
      const recipients = await stores.noticeMail.dueRecipients({
        clientInstanceId,
        now: before,
        limit: settings.batchSize
      });
      for (const userId of recipients) {
        control.signal.throwIfAborted();
        const scope = { clientInstanceId, userId, before };
        const count = await stores.noticeMail.countPending(scope);
        if (count === 0) {
          await control.transaction((tx) => tx.noticeMail.removePending(scope));
          continue;
        }
        // Read the address and active state at delivery, never keep either in the queue.
        const user = await stores.users.getUser({ clientInstanceId, userId });
        if (!user || user.status !== "active") {
          await control.transaction((tx) => tx.noticeMail.removePending(scope));
          continue;
        }
        const defer = () =>
          control.transaction((tx) =>
            tx.noticeMail.deferPending({
              ...scope,
              dueAt: new Date(now().getTime() + settings.digestIntervalMs).toISOString()
            })
          );
        if (!user.email) {
          await defer();
          continue;
        }
        let delivered = false;
        try {
          delivered = (
            await mail.sender.send(
              {
                template: "workflow-notice",
                to: { email: user.email },
                // Each recipient's own language at delivery, the instance's where they chose none.
                locale: user.locale ?? options.config.localization.defaultLocale,
                params: { count, link: `${mail.appUrl.replace(/\/+$/u, "")}/inbox` }
              },
              { signal: control.signal }
            )
          ).ok;
        } catch {
          // Provider text can contain credentials or content. The next tick is the retry.
        }
        control.signal.throwIfAborted();
        if (delivered) await control.transaction((tx) => tx.noticeMail.removePending(scope));
        else await defer();
        await options.auditRecorder.record({
          type: "notice.mail_delivery",
          status: delivered ? "success" : "failed",
          actor: { displayLabel: "Notice mail", roles: [] },
          correlationId: _job.correlationId,
          metadata: { notices: count, delivered: delivered ? 1 : 0 }
        });
      }
    }
  });
  return {
    handlers: [handler],
    schedules: [defineSchedule({ kind: noticeMailJob, every: settings.digestIntervalMs })]
  };
}
