import { LEGACY_AUDIT, type PlatformEventDefinition } from "./definition";

export const dataStoreEvents = {
  // Guardrails answer here before a Data Store's revision goes live, which applies its
  // migrations. The subject is the store.
  "data_store.before_publish": {
    name: "data_store.before_publish",
    subject: "config_asset",
    legacy: false,
    audited: false,
    phases: ["before"]
  },
  // The database of a store a Knowledge Base owned is dropped, once that Knowledge Base was
  // deleted. The subject is the store.
  // The store a Knowledge Base owned, dropped with its rows and roles after the Knowledge Base
  // was deleted. Its metadata names the store; it holds nothing the store held.
  "data_store.dropped": {
    name: "data_store.dropped",
    subject: "data_store",
    legacy: false,
    audited: true,
    phases: ["after"],
    payload: {
      type: "object",
      additionalProperties: false,
      required: ["name"],
      properties: { name: { type: "string" } }
    }
  },
  // The test copy of a store was built from nothing (DT-2): by a draft's first changing call
  // (`made`), because a migration or seed file it was built from changed in the draft
  // (`rebuilt`), or by a reset. It names the store, the level and the number of seed files; the
  // actor is the person whose draft called or who reset it. It holds no row and no SQL.
  "data_store.test_copy_built": {
    legacy: false,
    audited: true,
    phases: ["after"],
    name: "data_store.test_copy_built",
    subject: "data_store",
    payload: {
      type: "object",
      additionalProperties: false,
      required: ["name", "reason", "level", "seedFiles"],
      properties: {
        name: { type: "string" },
        reason: { type: "string", enum: ["made", "rebuilt", "reset"] },
        level: { type: "integer" },
        seedFiles: { type: "integer" }
      }
    }
  },
  // Building or bringing a test copy to its draft failed, and the copy is left unbuilt. It
  // names the file and the SQLSTATE, never the statement's text or a value.
  "data_store.test_copy_failed": {
    legacy: false,
    audited: true,
    phases: ["after"],
    name: "data_store.test_copy_failed",
    subject: "data_store",
    payload: {
      type: "object",
      additionalProperties: false,
      required: ["name", "code"],
      properties: {
        name: { type: "string" },
        code: { type: "string" },
        file: { type: "string" },
        sqlState: { type: "string" }
      }
    }
  },
  // The test copy of a store was dropped: by Delete, or with the store's asset (`store_deleted`).
  "data_store.test_copy_deleted": {
    legacy: false,
    audited: true,
    phases: ["after"],
    name: "data_store.test_copy_deleted",
    subject: "data_store",
    payload: {
      type: "object",
      additionalProperties: false,
      required: ["name", "reason"],
      properties: {
        name: { type: "string" },
        reason: { type: "string", enum: ["deleted", "store_deleted"] }
      }
    }
  },
  "data_store.rows_written": {
    legacy: false,
    audited: true,
    phases: ["after"],
    name: "data_store.rows_written",
    subject: "data_store",
    payload: {
      type: "object",
      additionalProperties: false,
      required: ["store", "table", "operationRunId"],
      properties: {
        store: { type: "string" },
        table: { type: "string" },
        operationRunId: { type: "string" },
        inserted: { type: "integer" },
        skipped: { type: "integer" },
        updated: { type: "integer" },
        deleted: { type: "integer" }
      }
    }
  },
  // A person's decision on one record field in "Prüfen" (REC-2). It names the field and the
  // action, never the value or the object's key.
  "data_store.record_decided": {
    legacy: false,
    audited: true,
    phases: ["after"],
    name: "data_store.record_decided",
    subject: "data_store",
    payload: {
      type: "object",
      additionalProperties: false,
      required: ["store", "table", "field", "action", "operationRunId"],
      properties: {
        store: { type: "string" },
        table: { type: "string" },
        field: { type: "string" },
        action: { type: "string", enum: ["confirm", "correct", "assign"] },
        operationRunId: { type: "string" }
      }
    }
  },
  // A holder of `connection.write` confirmed that a publish hands a source's data to people who
  // read the store and may not use the source (DS-13c). It names the store, the source, the
  // asset published and how many people; never who.
  "data_store.handover_confirmed": {
    legacy: false,
    audited: true,
    phases: ["after"],
    name: "data_store.handover_confirmed",
    subject: "data_store",
    payload: {
      type: "object",
      additionalProperties: false,
      required: ["store", "connection", "people", "kind", "name"],
      properties: {
        store: { type: "string" },
        connection: { type: "string" },
        people: { type: "integer" },
        kind: { type: "string" },
        name: { type: "string" }
      }
    }
  },
  "data_store.migrated": {
    ...LEGACY_AUDIT,
    name: "data_store.migrated",
    subject: "data_store"
  },
  "data_store.migration_failed": {
    ...LEGACY_AUDIT,
    name: "data_store.migration_failed",
    subject: "data_store"
  },
  "data_store.provisioned": {
    ...LEGACY_AUDIT,
    name: "data_store.provisioned",
    subject: "data_store"
  },
  "data_store.provisioning_failed": {
    ...LEGACY_AUDIT,
    name: "data_store.provisioning_failed",
    subject: "data_store"
  }
} as const satisfies Record<string, PlatformEventDefinition>;
