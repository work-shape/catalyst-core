import {
  AppError,
  ATTACHMENT_CREATE_OUTCOMES,
  defineJobHandler,
  defineJobKind,
  isAppError,
  readObjectBytes,
  type AttachmentManifest,
  type BeforeActionCheck,
  type CapabilityAssetKind,
  type CapabilityRecord,
  type CapabilityRecordStore,
  type ClientInstanceId,
  type ConfigAssetStore,
  type GuardrailStore,
  type KnowledgeHitDocuments,
  type ConversationAttachment,
  type ConversationId,
  type DraftAttachment,
  type Job,
  type JobControl,
  type JobHandler,
  type JobKind,
  type JobsStore,
  type JsonObject,
  type Logger,
  type LocaleCode,
  type ManagedArtifactId,
  type ManagedArtifactKind,
  type ManagedArtifactRecord,
  type ManagedFileId,
  type ManagedFileRecord,
  type ManagedObjectDeletionResult,
  type ModelSystemPurpose,
  type ModuleDefinition,
  type ModuleSnapshot,
  type ObjectStorage,
  type OperationDefinition,
  type OperationRun,
  type OperationRunEnd,
  type OperationRunId,
  type PlatformFileStore,
  type PlatformStores,
  type ProviderRegion,
  type RegisteredJobHandler,
  type RegisteredProviderDefinition,
  type RetriedJob,
  type SecretResolver,
  type ShippedSkill
} from "@work-shape/catalyst-core";
import type {
  DataSourceDescribeInput,
  DataSourceDescribeResult,
  DataSourceQueryInput,
  DataSourceQueryResult,
  DataSourceRegistration,
  DataSourceRegistry
} from "@work-shape/catalyst-postgres-connector";
import type {
  AnyConfiguredToolDefinition,
  AnyToolDefinition,
  ConfiguredToolDefinition,
  ToolAssemblyDefinition,
  ToolDefinition
} from "@work-shape/catalyst-tool-sdk";
import {
  defineConfiguredTool,
  defineTool,
  toolFailed,
  toolSuccess
} from "@work-shape/catalyst-tool-sdk";
import { createHash } from "node:crypto";

export { defineConfiguredTool, defineTool, toolFailed, toolSuccess };
export type { CapabilityAssetKind };
export type {
  DataSourceDescribeInput,
  DataSourceDescribeResult,
  DataSourceQueryInput,
  DataSourceQueryResult,
  DataSourceRegistration,
  DataSourceRegistry
};
// A capability declares its job kinds with `defineJobKind`, enqueues through `jobs` on its
// context and serves them from its own worker process with `defineJobHandler`.
export { defineJobHandler, defineJobKind };
export type {
  AnyConfiguredToolDefinition,
  AnyToolDefinition,
  ConfiguredToolDefinition,
  Job,
  JobControl,
  JobHandler,
  JobKind,
  RegisteredJobHandler,
  RetriedJob,
  ToolAssemblyDefinition,
  ToolDefinition
};

export type ClientInstanceEnv = Record<string, string | undefined>;

/** The processes a capability is created in: the API process, and the workers. */
export const CAPABILITY_PROCESSES = ["api", "worker"] as const;
export type CapabilityProcess = (typeof CAPABILITY_PROCESSES)[number];

export interface ClientInstanceCapabilityContext {
  logger: Logger;
  clientInstanceId: ClientInstanceId;
  capabilitiesConfig: Record<string, unknown>;
  /** Which modules are on. A capability asks this, not its own config, whether its module runs. */
  modules: ModuleSnapshot;
  dataSources: DataSourceRegistry;
  /** Settings only. A capability takes every secret from `secrets`. */
  env: ClientInstanceEnv;
  secrets: SecretResolver;
  /**
   * The instance's object store entries as the config states them. A capability that brings the
   * provider of a store creates it from its own definition.
   */
  objectStorage: { files?: unknown; workspaces?: unknown };
  files: ClientInstanceCapabilityFiles;
  /** Enqueues jobs of the kinds the capability declares. */
  jobs: ClientInstanceCapabilityJobs;
  /**
   * Runs `fn` with `files` and `jobs` bound to one transaction, so a record and the job that
   * drives it commit or roll back together.
   */
  transaction<Result>(
    fn: (stores: ClientInstanceCapabilityStores) => Promise<Result>
  ): Promise<Result>;
  managedObjectAccess: ManagedObjectAccessFactory;
  /** The instance's models. Every call a capability makes to a model goes through here. */
  models: ClientInstanceCapabilityModels;
  /**
   * What a capability reads and writes of the platform's own records. The platform keeps the
   * tables and their migrations; a capability reaches them through these ports alone.
   */
  stores: ClientInstanceCapabilityPlatformStores;
  /**
   * The documents of Knowledge Bases that a search hit names by file id, as the person may read
   * them (KB-7c). Answers none where Knowledge Bases are off or the process keeps no files.
   */
  knowledgeDocuments?: KnowledgeHitDocuments;
  /** The instance's mailer. Ready once the instance has started; ask `available` first. */
  mail: ClientInstanceCapabilityMail;
  /** The instance's name, accent colour and logo, for a page the capability shows outside it. */
  brand?: ClientInstanceCapabilityBrand;
  /** Which process this is: the API process, or a worker that runs steps and agents. */
  process: CapabilityProcess;
}

/**
 * The platform's records a capability may reach: the guardrails' hits and shipped switches,
 * which the platform keeps for the guardrails capability, the published config assets, the
 * capability's own records and the Operation Runs of its own operations (ADR-0033).
 */
export interface ClientInstanceCapabilityPlatformStores {
  guardrails: GuardrailStore;
  configAssets: Pick<ConfigAssetStore, "listPublishedConfigAssets">;
  /** The capability's own records. It reaches no other capability's. */
  records: ClientInstanceCapabilityRecords;
  /** The Operation Runs of the operations the capability contributes, and no others. */
  operationRuns: ClientInstanceCapabilityOperationRuns;
}

/** `CapabilityRecordStore` bound to the instance and to one capability. */
export type ClientInstanceCapabilityRecords = {
  [Method in keyof CapabilityRecordStore]: (
    input: Omit<Parameters<CapabilityRecordStore[Method]>[0], "clientInstanceId" | "capability">
  ) => ReturnType<CapabilityRecordStore[Method]>;
};
export type { CapabilityRecord };

export interface ClientInstanceCapabilityOperationRuns {
  get(id: OperationRunId): Promise<OperationRun | undefined>;
  /**
   * Ends a run of one of the capability's own operations with `completion: async` that is
   * still `running`. The transaction that ends it queues every Workflow step that waits for
   * it. `undefined` when it is not running any more. A run of another operation is refused,
   * and so is any end but `done` or `failed`.
   */
  finish(input: {
    id: OperationRunId;
    end: Extract<OperationRunEnd, { status: "done" | "failed" }>;
  }): Promise<OperationRun | undefined>;
}

/**
 * The instance's mailer, as the system sender in the frame of `workflow-message`. The capability
 * writes the subject and the Markdown; every value it puts in is escaped. Nothing is sent where
 * the instance has no mail.
 */
export interface ClientInstanceCapabilityMail {
  readonly available: () => boolean;
  send(
    message: {
      to: { email: string; name?: string };
      subject: string;
      markdown: string;
      locale: LocaleCode;
      /** The display name of the From line; the instance's sender otherwise. */
      fromName?: string;
      /** The Workflow the mail is sent for, as the mail's footer names it. */
      workflowName: string;
    },
    context?: { signal?: AbortSignal }
  ): Promise<
    | { ok: true }
    | { ok: false; reason: "no_mail" | "rejected" | "unsent" | "uncertain"; providerCode?: string }
  >;
}

/**
 * How the instance presents itself on a page outside it, such as a form a person without an
 * account fills in. The page loads nothing from the instance, so the logo comes as its bytes.
 */
export interface ClientInstanceCapabilityBrand {
  name: string;
  /** A hex colour such as `#0f766e`, where the instance sets one. */
  accentColor?: string;
  /** The logo where one is set and could be read: PNG, JPEG or GIF of at most 256 KiB. */
  logo(): Promise<
    { contentType: "image/png" | "image/jpeg" | "image/gif"; content: Uint8Array } | undefined
  >;
}

/** What a capability calls a model for. It names the call on its usage record. */
export type CapabilityModelPurpose = Extract<
  ModelSystemPurpose,
  "document_extraction" | "knowledge_field_extraction" | "guardrail_judge"
>;

/** What a capability hands a model to read. */
export type CapabilityModelContentPart =
  | { type: "text"; text: string }
  | { type: "document"; mimeType: "application/pdf"; data: Uint8Array };

/** One call of a capability to a model of the instance. */
export interface CapabilityModelCall {
  /** The model binding of the instance config the call goes to. */
  bindingId: string;
  purpose: CapabilityModelPurpose;
  /** What the model is told before it reads `content`, as the instance's own turn. */
  instructions?: string;
  /** What the model reads, as one turn of a user. */
  content: CapabilityModelContentPart[];
  /**
   * `configured` calls the model with the reasoning effort its binding is configured with,
   * where the model takes one. Without it the call names none.
   */
  reasoningEffort?: "configured";
  /** Asks for an answer in JSON of this schema. The answer is then JSON; its shape is not checked. */
  output?: { jsonSchema: JsonObject };
  maxOutputTokens?: number;
  /**
   * The user and the conversation the call is made for, for its usage record. A call that names
   * a conversation holding data from a personal connection is refused with
   * `personal_data_model_region` where its model's region is not allowed for that data.
   */
  userId?: string;
  conversationId?: ConversationId;
  /** The agent run the call is made for, where an agent's call caused it. */
  agentRunId?: string;
  /**
   * The workspace and the Operation Run of the tool call that makes the call, as the tool's
   * context names them (`context.operationRun`), for its usage record.
   */
  workspaceId?: string;
  operationRunId?: string;
  /** Ties the usage record to the request that caused the call. */
  correlationId: string;
  signal?: AbortSignal;
  /** The call fails as timed out when it has not ended by then. */
  deadline?: Date;
}

export interface CapabilityModelAnswer {
  usage?: { inputTokens: number; outputTokens: number };
  text: string;
}

/** What a capability may know of a model binding before it relies on it. */
export interface CapabilityModelBinding {
  price?: { currency: string; inputPerMillionTokens: number; outputPerMillionTokens: number };
  providerId: string;
  model: string;
  /** Where the provider processes a call. Absent for a provider inside the instance. */
  region?: ProviderRegion;
  documentInput: boolean;
  structuredOutput: boolean;
}

export interface ClientInstanceCapabilityModels {
  /**
   * Sends the call through the instance's model gateway. The gateway admits it against the
   * usage limits, retries it and records what it used; a failure carries no text of the provider.
   */
  complete(call: CapabilityModelCall): Promise<CapabilityModelAnswer>;
  /** Throws when the instance config defines no binding of that id. */
  describeBinding(bindingId: string): CapabilityModelBinding;
}

export type ClientInstanceCapabilityJobs = Pick<JobsStore, "enqueue">;

/** What a capability writes through inside `transaction`. */
export interface ClientInstanceCapabilityStores {
  files: ClientInstanceCapabilityFiles;
  jobs: ClientInstanceCapabilityJobs;
}

export type ClientInstanceCapabilityFiles = Pick<
  PlatformFileStore,
  | "createConversationAttachment"
  | "getConversationAttachment"
  | "listDraftAttachments"
  | "findConversationAttachmentByChecksum"
  | "updateConversationAttachment"
  | "reactivateDraftAttachment"
  | "deleteDraftAttachment"
  | "claimReadyDraftAttachmentsForMessage"
  | "claimConversationAttachmentForPreprocessing"
  | "renewClaimedConversationAttachmentLease"
  | "listConversationAttachmentsWithoutJob"
  | "completeClaimedConversationAttachment"
  | "failClaimedConversationAttachment"
  | "findReadyConversationAttachmentByFile"
  | "findConversationAttachmentByFile"
  | "listConversationManagedObjectsForDeletion"
  | "listManagedArtifactsForFile"
  | "markConversationManagedObjectsDeleted"
>;

/**
 * How an ended job of a kind the capability declares is retried by hand. The API retries no
 * job of a kind it was not given one for.
 */
export interface ClientInstanceJobRetry {
  kind: JobKind;
  /**
   * Puts the subject record back into the state the job works from, in the transaction that
   * queues the job again. Answers false when the record cannot be worked on again. Missing
   * when the job reads everything it needs anew.
   */
  restoreSubject?(job: RetriedJob, stores: ClientInstanceCapabilityStores): Promise<boolean>;
}

export interface ClientInstanceCapabilityContribution {
  /**
   * Answers at every before-event of the instance, beside the platform's own checks: in every
   * process, for every call, asset write, publish and approval request. The strictest answer
   * of all checks is the event's. A check that throws or does not answer in time refuses the
   * action with the reason `check_unavailable`.
   */
  beforeActionCheck?: BeforeActionCheck;
  knowledgeFieldExtractor?: import("@work-shape/catalyst-core").KnowledgeFieldExtractor;
  tools?: AnyToolDefinition[];
  /**
   * Operations the capability brings (ADR-0033). Every process registers them with the
   * platform's own, so a Workflow `operation` step and every other caller reach them under the
   * same policy and audit. One with `completion: async` is ended through
   * `stores.operationRuns.finish`. A module that lists them in `operations` turns them off.
   */
  operations?: readonly OperationDefinition[];
  /**
   * Work that runs in the API process alone while it serves, such as a poll of the
   * capability's records. Started after the server listens and stopped before it closes.
   */
  background?: { start(): void; stop(): Promise<void> };
  attachments?: ClientInstanceAttachmentHandler[];
  managedObjects?: ClientInstanceManagedObjectReaderContribution[];
  jobRetries?: ClientInstanceJobRetry[];
  /**
   * Runs once in the API process after the capabilities are created and before it takes a
   * request, as the platform's own seed does. A worker process never runs it. What it throws
   * stops the start.
   */
  instanceSeed?(input: ClientInstanceCapabilitySeedInput): Promise<void>;
  /**
   * The asset kinds the capability brings: each is registered with the platform's own, read,
   * written and published through the asset operations under the rights the kind names. A
   * capability brings a module's kind only while that module is on; the platform refuses a
   * kind it already has.
   */
  assetKinds?: readonly CapabilityAssetKind[];
  /**
   * Deletes what the capability keeps past the audit retention, in the transaction that
   * deletes the audit events, so both go or neither does. It answers the counts the
   * `audit.pruned` event records, by name. It runs whether the capability's module is on or
   * off: what was kept while it was on is deleted all the same.
   */
  retention?(
    input: ClientInstanceCapabilityRetentionInput
  ): Promise<Readonly<Record<string, number>>>;
  close?: () => Promise<void>;
}

/** What a capability's seed writes through: the platform's records it keeps, in one transaction. */
export interface ClientInstanceCapabilitySeedInput {
  stores: {
    transaction<Result>(
      fn: (stores: Pick<PlatformStores, "guardrails" | "configAssets">) => Promise<Result>
    ): Promise<Result>;
  };
}

export interface ClientInstanceCapabilityRetentionInput {
  /** The audit retention of the instance: what is older is deleted. */
  days: number;
  /** Bound to the transaction that deletes the audit events. */
  stores: { guardrails: Pick<GuardrailStore, "deleteHitsOlderThan"> };
}

export interface UploadDraftAttachmentInput {
  locale?: LocaleCode;
  conversationId: ConversationId;
  ownerUserId: string;
  filename: string;
  mimeType?: string;
  content: UploadFileContent;
}

export interface UploadFileContent {
  byteSize: number;
  checksum: string;
  headerBytes: Uint8Array;
  openStream(): AsyncIterable<Uint8Array>;
}

export interface UploadDraftAttachmentResult {
  attachment: ConversationAttachment;
  outcome: (typeof ATTACHMENT_CREATE_OUTCOMES)[number];
}

export interface ReadConversationFileInput {
  conversationId: ConversationId;
  fileId: string;
}

export interface ReadConversationFileResult {
  fileId: ManagedFileId;
  filename: string;
  mimeType?: string;
  byteSize: number;
  bytes: Uint8Array;
}

export interface ClientInstanceAttachmentHandler {
  name: string;
  maxFileBytes: number;
  acceptedFileTypes: string[];
  acceptsFile(
    input: Pick<UploadDraftAttachmentInput, "filename" | "mimeType" | "content">
  ): boolean;
  listDraftAttachments(conversationId: ConversationId): Promise<DraftAttachment[]>;
  uploadDraftAttachment(input: UploadDraftAttachmentInput): Promise<UploadDraftAttachmentResult>;
  retryDraftAttachment(input: {
    conversationId: ConversationId;
    attachmentId: string;
  }): Promise<ConversationAttachment>;
  deleteDraftAttachment(input: {
    conversationId: ConversationId;
    attachmentId: string;
  }): Promise<ConversationAttachment>;
  deleteConversationAttachments(input: {
    conversationId: ConversationId;
    deletedAt: string;
  }): Promise<ManagedObjectDeletionResult>;
  /**
   * Deletes the stored bytes of managed files that no Conversation refers to any more. A
   * handler removes only the object keys it stores itself and returns those.
   */
  deleteOrphanedFileObjects?(input: { objectKeys: readonly string[] }): Promise<string[]>;
  /**
   * Transition release only: enqueues a job for each of the handler's attachments that waits
   * for preprocessing and has no queued or running job, up to `limit`, and returns how many.
   * The schedule `platform_jobs.adopt_legacy` calls it every minute. It goes with that schedule
   * in the contract step.
   */
  adoptLegacyAttachments?(input: { limit: number }): Promise<number>;
  readConversationFile(input: ReadConversationFileInput): Promise<ReadConversationFileResult>;
  blockingDraftAttachmentMessage(attachments: readonly DraftAttachment[]): string | undefined;
  createAttachmentManifest(attachments: readonly ConversationAttachment[]): AttachmentManifest;
  isInlineDisplayMimeType(mimeType: string): boolean;
}

export interface ClientInstanceManagedObjectReader {
  readArtifact(input: {
    clientInstanceId: ClientInstanceId;
    artifactId: ManagedArtifactId;
  }): Promise<{
    bytes: Uint8Array;
    mimeType: string;
  }>;
  readFile(input: { clientInstanceId: ClientInstanceId; fileId: ManagedFileId }): Promise<{
    bytes: Uint8Array;
    mimeType?: string;
  }>;
}

export interface ClientInstanceManagedObjectReaderContribution extends ClientInstanceManagedObjectReader {
  name: string;
}

export interface ClientInstanceCapability {
  name: string;
  configKey?: string;
  /** Modules whose code the capability ships. They register beside the platform's own. */
  modules?: readonly ModuleDefinition[];
  /** Providers the capability brings. They register beside the platform's own at startup. */
  providers?: readonly RegisteredProviderDefinition[];
  /**
   * Skills the capability ships. The release seed stores each as a read-only skill of origin
   * `release` where the instance has the tools it names, and its name is the platform's.
   */
  skills?: readonly ShippedSkill[];
  create(
    context: ClientInstanceCapabilityContext
  ): ClientInstanceCapabilityContribution | Promise<ClientInstanceCapabilityContribution>;
}

export interface ManagedObjectFileKeyInput {
  clientInstanceId: ClientInstanceId;
  ownerUserId: string;
  conversationId?: ConversationId;
  filename: string;
  mimeType?: string;
  byteSize: number;
  checksum: string;
  extension?: string;
  keyContext?: JsonObject;
}

export interface ManagedObjectArtifactKeyInput {
  clientInstanceId: ClientInstanceId;
  conversationId: ConversationId;
  sourceFileId?: ManagedFileId;
  kind: ManagedArtifactKind;
  filename?: string;
  mimeType: string;
  byteSize: number;
  checksum: string;
  extension?: string;
  metadata?: JsonObject;
  keyContext?: JsonObject;
}

export interface ManagedObjectKeyFactory {
  createFileObjectKey(input: ManagedObjectFileKeyInput): string;
  createArtifactObjectKey(input: ManagedObjectArtifactKeyInput): string;
}

export interface CreateManagedObjectFileInput {
  ownerUserId: string;
  conversationId?: ConversationId;
  filename: string;
  mimeType?: string;
  bytes: Uint8Array;
  extension?: string;
  keyContext?: JsonObject;
}

export interface CreateManagedObjectStreamedFileInput {
  ownerUserId: string;
  conversationId?: ConversationId;
  filename: string;
  mimeType?: string;
  content: UploadFileContent;
  extension?: string;
  keyContext?: JsonObject;
}

export interface CreateManagedObjectArtifactInput {
  conversationId: ConversationId;
  sourceFileId?: ManagedFileId;
  kind: ManagedArtifactKind;
  filename?: string;
  mimeType: string;
  bytes: Uint8Array;
  metadata?: JsonObject;
  extension?: string;
  keyContext?: JsonObject;
}

export interface ReadManagedObjectFileInput {
  fileId: ManagedFileId;
}

export interface ReadManagedObjectArtifactInput {
  artifactId: ManagedArtifactId;
}

export interface ManagedObjectFileRead {
  record: ManagedFileRecord;
  bytes: Uint8Array;
  mimeType?: string;
}

export interface ManagedObjectArtifactRead {
  record: ManagedArtifactRecord;
  bytes: Uint8Array;
  mimeType: string;
}

export interface ManagedObjectAccess {
  createFile(input: CreateManagedObjectFileInput): Promise<ManagedFileRecord>;
  createStreamedFile(input: CreateManagedObjectStreamedFileInput): Promise<ManagedFileRecord>;
  createArtifact(input: CreateManagedObjectArtifactInput): Promise<ManagedArtifactRecord>;
  readFile(input: ReadManagedObjectFileInput): Promise<ManagedObjectFileRead>;
  readArtifact(input: ReadManagedObjectArtifactInput): Promise<ManagedObjectArtifactRead>;
  deleteConversationObjects(input: {
    conversationId: ConversationId;
    deletedAt: string;
  }): Promise<ManagedObjectDeletionResult>;
}

export interface CreateManagedObjectAccessInput {
  clientInstanceId: ClientInstanceId;
  files: PlatformFileStore;
  byteStore: ObjectStorage;
  keyFactory: ManagedObjectKeyFactory;
  logger?: import("@work-shape/catalyst-core").Logger;
}

export interface CreateManagedObjectAccessFromContextInput {
  byteStore: ObjectStorage;
  keyFactory: ManagedObjectKeyFactory;
}

export interface ManagedObjectAccessFactory {
  createAccess(input: CreateManagedObjectAccessFromContextInput): ManagedObjectAccess;
}

export function defineCapability(capability: ClientInstanceCapability): ClientInstanceCapability {
  return capability;
}

export function createManagedObjectAccess(
  input: CreateManagedObjectAccessInput
): ManagedObjectAccess {
  return new DefaultManagedObjectAccess(input);
}

class DefaultManagedObjectAccess implements ManagedObjectAccess {
  private readonly clientInstanceId: ClientInstanceId;
  private readonly files: PlatformFileStore;
  private readonly byteStore: ObjectStorage;
  private readonly keyFactory: ManagedObjectKeyFactory;
  private readonly logger: CreateManagedObjectAccessInput["logger"];

  constructor(input: CreateManagedObjectAccessInput) {
    this.clientInstanceId = input.clientInstanceId;
    this.files = input.files;
    this.byteStore = input.byteStore;
    this.keyFactory = input.keyFactory;
    this.logger = input.logger;
  }

  async createFile(input: CreateManagedObjectFileInput): Promise<ManagedFileRecord> {
    const checksum = createManagedObjectChecksum(input.bytes);
    const objectKey = this.keyFactory.createFileObjectKey({
      clientInstanceId: this.clientInstanceId,
      ownerUserId: input.ownerUserId,
      conversationId: input.conversationId,
      filename: input.filename,
      mimeType: input.mimeType,
      byteSize: input.bytes.byteLength,
      checksum,
      extension: input.extension,
      keyContext: input.keyContext
    });
    await this.byteStore.put(objectKey, input.bytes, { contentType: input.mimeType });
    return this.files.createManagedFile({
      clientInstanceId: this.clientInstanceId,
      ownerUserId: input.ownerUserId,
      filename: input.filename,
      mimeType: input.mimeType,
      byteSize: input.bytes.byteLength,
      checksum,
      objectKey
    });
  }

  async createStreamedFile(
    input: CreateManagedObjectStreamedFileInput
  ): Promise<ManagedFileRecord> {
    const objectKey = this.keyFactory.createFileObjectKey({
      clientInstanceId: this.clientInstanceId,
      ownerUserId: input.ownerUserId,
      conversationId: input.conversationId,
      filename: input.filename,
      mimeType: input.mimeType,
      byteSize: input.content.byteSize,
      checksum: input.content.checksum,
      extension: input.extension,
      keyContext: input.keyContext
    });
    await this.byteStore.put(objectKey, input.content.openStream(), {
      contentType: input.mimeType,
      size: input.content.byteSize
    });
    return this.files.createManagedFile({
      clientInstanceId: this.clientInstanceId,
      ownerUserId: input.ownerUserId,
      filename: input.filename,
      mimeType: input.mimeType,
      byteSize: input.content.byteSize,
      checksum: input.content.checksum,
      objectKey
    });
  }

  async createArtifact(input: CreateManagedObjectArtifactInput): Promise<ManagedArtifactRecord> {
    const checksum = createManagedObjectChecksum(input.bytes);
    const objectKey = this.keyFactory.createArtifactObjectKey({
      clientInstanceId: this.clientInstanceId,
      conversationId: input.conversationId,
      sourceFileId: input.sourceFileId,
      kind: input.kind,
      filename: input.filename,
      mimeType: input.mimeType,
      byteSize: input.bytes.byteLength,
      checksum,
      extension: input.extension,
      metadata: input.metadata,
      keyContext: input.keyContext
    });
    await this.byteStore.put(objectKey, input.bytes, { contentType: input.mimeType });
    try {
      return await this.files.createManagedArtifact({
        clientInstanceId: this.clientInstanceId,
        conversationId: input.conversationId,
        sourceFileId: input.sourceFileId,
        kind: input.kind,
        objectKey,
        filename: input.filename,
        mimeType: input.mimeType,
        byteSize: input.bytes.byteLength,
        checksum,
        metadata: input.metadata
      });
    } catch (error: unknown) {
      // The store refuses the record when the Conversation was deleted in the meantime. No
      // record names the bytes then, so they are removed here, best effort.
      if (error instanceof AppError && error.code === "NOT_FOUND") {
        try {
          await this.byteStore.delete(objectKey);
        } catch (deleteError: unknown) {
          this.logger?.error(
            {
              objectKey,
              // The class and the code only: a provider's message can repeat an address.
              errorClass: deleteError instanceof Error ? deleteError.name : "unknown",
              ...(isAppError(deleteError) ? { errorCode: deleteError.code } : {})
            },
            "Could not remove an artifact object after its record was refused"
          );
        }
      }
      throw error;
    }
  }

  async readFile(input: ReadManagedObjectFileInput): Promise<ManagedObjectFileRead> {
    const record = await this.files.getManagedFile({
      clientInstanceId: this.clientInstanceId,
      fileId: input.fileId
    });
    if (!record) {
      throw new AppError("NOT_FOUND", `Managed file '${input.fileId}' was not found`);
    }
    if (record.status === "released") {
      throw new AppError("CONFLICT", "Original liegt in der Quelle", {
        reason: "knowledge_original_released"
      });
    }
    return {
      record,
      bytes: await readObjectBytes(this.byteStore, record.objectKey),
      mimeType: record.mimeType
    };
  }

  async readArtifact(input: ReadManagedObjectArtifactInput): Promise<ManagedObjectArtifactRead> {
    const record = await this.files.getManagedArtifact({
      clientInstanceId: this.clientInstanceId,
      artifactId: input.artifactId
    });
    if (!record) {
      throw new AppError("NOT_FOUND", `Managed artifact '${input.artifactId}' was not found`);
    }
    return {
      record,
      bytes: await readObjectBytes(this.byteStore, record.objectKey),
      mimeType: record.mimeType
    };
  }

  async deleteConversationObjects(input: {
    conversationId: ConversationId;
    deletedAt: string;
  }): Promise<ManagedObjectDeletionResult> {
    const deletion = await this.files.listConversationManagedObjectsForDeletion({
      clientInstanceId: this.clientInstanceId,
      conversationId: input.conversationId
    });
    await Promise.all(
      [...deletion.artifactObjectKeys, ...deletion.fileObjectKeys].map((objectKey) =>
        this.byteStore.delete(objectKey)
      )
    );
    return this.files.markConversationManagedObjectsDeleted({
      clientInstanceId: this.clientInstanceId,
      conversationId: input.conversationId,
      deletedAt: input.deletedAt
    });
  }
}

export function createManagedObjectChecksum(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function createUploadFileContent(bytes: Uint8Array): UploadFileContent {
  return {
    byteSize: bytes.byteLength,
    checksum: createManagedObjectChecksum(bytes),
    headerBytes: bytes.slice(0, 16),
    async *openStream() {
      yield bytes;
    }
  };
}

export function resolveUploadFileContent(input: {
  content?: UploadFileContent;
  bytes?: Uint8Array;
}): UploadFileContent {
  if (input.content) {
    return input.content;
  }
  if (input.bytes) {
    return createUploadFileContent(input.bytes);
  }
  throw new AppError("VALIDATION_FAILED", "Uploaded file content is missing");
}
