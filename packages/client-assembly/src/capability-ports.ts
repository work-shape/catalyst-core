import {
  AppError,
  type ClientInstanceId,
  type OperationRunId,
  type PlatformStores
} from "@work-shape/catalyst-core";
import type {
  ClientInstanceCapabilityMail,
  ClientInstanceCapabilityPlatformStores,
  ClientInstanceCapabilityRecords
} from "@work-shape/catalyst-capability-sdk";
import type { MailSender } from "@work-shape/catalyst-mail";

// The ports one capability gets of the platform's records (ADR-0033): its own records, the
// Operation Runs of its own operations, and the instance's mailer.

export function capabilityStoresOf(input: {
  clientInstanceId: ClientInstanceId;
  capability: string;
  store: Pick<PlatformStores, "capabilityRecords" | "operationRuns">;
  /** The operations the capability contributes, known once it is created. */
  operations: () => ReadonlySet<string>;
}): Pick<ClientInstanceCapabilityPlatformStores, "records" | "operationRuns"> {
  const { clientInstanceId, capability, store } = input;
  const own = { clientInstanceId, capability };
  const records: ClientInstanceCapabilityRecords = {
    create: (call) => store.capabilityRecords.create({ ...call, ...own }),
    get: (call) => store.capabilityRecords.get({ ...call, ...own }),
    getByKey: (call) => store.capabilityRecords.getByKey({ ...call, ...own }),
    update: (call) => store.capabilityRecords.update({ ...call, ...own }),
    claim: (call) => store.capabilityRecords.claim({ ...call, ...own }),
    deleteExpired: (call) => store.capabilityRecords.deleteExpired({ ...call, ...own })
  };
  async function ownRun(id: OperationRunId) {
    const run = await store.operationRuns.get({ clientInstanceId, id });
    return run && input.operations().has(run.operation) ? run : undefined;
  }
  return {
    records,
    operationRuns: {
      get: ownRun,
      async finish({ id, end }) {
        const run = await ownRun(id);
        if (!run) {
          throw new AppError("NOT_FOUND", "No run of this capability's operations has this id");
        }
        return store.operationRuns.finish({ clientInstanceId, id: run.id, end });
      }
    }
  };
}

export function createCapabilityMail(input: {
  /** The instance's mailer, once the instance has made it. */
  sender: () => Pick<MailSender, "send"> | undefined;
  defaultFromName: string;
}): ClientInstanceCapabilityMail {
  return {
    available: () => input.sender() !== undefined,
    async send(message, context) {
      const sender = input.sender();
      if (!sender) return { ok: false, reason: "no_mail" };
      const result = await sender.send(
        {
          template: "workflow-message",
          params: {
            subject: message.subject,
            markdown: message.markdown,
            sentBy: { kind: "workflow", workflowName: message.workflowName }
          },
          to: [
            message.to.name
              ? { email: message.to.email, displayLabel: message.to.name }
              : { email: message.to.email }
          ],
          fromName: message.fromName ?? input.defaultFromName,
          locale: message.locale
        },
        context
      );
      if (result.ok) return { ok: true };
      return {
        ok: false,
        reason: result.failure ?? "rejected",
        ...(result.providerCode ? { providerCode: result.providerCode } : {})
      };
    }
  };
}
