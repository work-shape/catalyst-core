// Full typed defaults for strict scale-test ports. Any path the test does not supply fails.
import type {
  WorkflowRunsStore,
  WorkflowRunDatasetsStore,
  JobsStore,
  ActorAccess,
  Authorizer,
  PlatformStores,
  ApiAccessStore,
  ConfigAssetStore,
  AuditEventStore,
  OperationRegistry,
  WorkflowNoticesStore
} from "@work-shape/catalyst-core";
import type { RunOperationDeps } from "@work-shape/catalyst-tool-execution";
function unsupported(): never {
  throw new Error("Unexpected scale-test port call");
}
export const unusedWorkflowRunsStore: WorkflowRunsStore = {
  lockDefinitionGraph: unsupported,
  recordStepRunInput: unsupported,
  readBlockSteps: unsupported,
  markBlockWaiting: unsupported,
  findRunByOperation: unsupported,
  findChildRun: unsupported,
  listChildRuns: unsupported,
  readRunOutput: unsupported,
  markChildWaiting: unsupported,
  waitForOperation: unsupported,
  createRun: unsupported,
  lockRunByKey: unsupported,
  linkStepRun: unsupported,
  listLinkedStepRuns: unsupported,
  readScheduleState: unsupported,
  lockRun: unsupported,
  lockRunLinks: unsupported,
  markRunWaiting: unsupported,
  endRunWait: unsupported,
  readRun: unsupported,
  readRunView: unsupported,
  listRuns: unsupported,
  listLastRuns: unsupported,
  listOpenRunIds: unsupported,
  readRunInput: unsupported,
  readCheckpoint: unsupported,
  readRunDefinition: unsupported,
  markRunRunning: unsupported,
  markContinuation: unsupported,
  handoffContinuation: unsupported,
  endRun: unsupported,
  createStepRun: unsupported,
  getStepRun: unsupported,
  markStepRunRunning: unsupported,
  endStepRun: unsupported,
  readLoopDataset: unsupported,
  markLoopWaiting: unsupported,
  noteStepRunOperation: unsupported,
  stageCodeStep: unsupported,
  readStagedCode: unsupported,
  recordCodeOutcome: unsupported,
  readCodeOutcome: unsupported,
  listOpenStepRuns: unsupported,
  listRunsWithDataEndedBefore: unsupported,
  pruneStepRunData: unsupported,
  markRunDataPruned: unsupported,
  listStepRuns: unsupported,
  findStepOutput: unsupported,
  countLoopItems: unsupported,
  readLoopProgress: unsupported,
  countLoopItemsStarted: unsupported,
  readLoopItem: unsupported,
  readLoopCounts: unsupported
};
export const unusedWorkflowRunDatasetsStore: WorkflowRunDatasetsStore = {
  create: unsupported,
  listForSteps: unsupported,
  getMany: unsupported,
  lock: unsupported,
  get: unsupported,
  listForRun: unsupported,
  reservePart: unsupported,
  commitPart: unsupported,
  completeStep: unsupported,
  allowRun: unsupported,
  canRead: unsupported,
  finishRun: unsupported,
  claimExpired: unsupported,
  claimRun: unsupported,
  claimWorkflow: unsupported,
  markCleaned: unsupported
};
export const unusedJobsStore: JobsStore = {
  runAgainAfter: unsupported,
  enqueue: unsupported,
  withdraw: unsupported,
  readWorkerReport: unsupported,
  readKindActivity: unsupported,
  pruneEndedJobs: unsupported,
  summarizeByKind: unsupported,
  listOverview: unsupported,
  retry: unsupported
};
export const unusedActorAccess: ActorAccess = {
  scopeOf: unsupported,
  authorize: unsupported,
  authorizeTransfer: unsupported,
  require: unsupported,
  holdsGrantAt: unsupported,
  denials: unsupported
};
export const unusedAuthorizer: Authorizer = {
  forActor: unsupported
};
export const unusedPlatformStores: PlatformStores = {
  get conversations() {
    return unsupported();
  },
  get followUps() {
    return unsupported();
  },
  get scheduledStarts() {
    return unsupported();
  },
  get agentRuns() {
    return unsupported();
  },
  get childAgentRuns() {
    return unsupported();
  },
  get files() {
    return unsupported();
  },
  get audit() {
    return unsupported();
  },
  get usage() {
    return unsupported();
  },
  get users() {
    return unsupported();
  },
  get workspaces() {
    return unsupported();
  },
  get apiAccess() {
    return unsupported();
  },
  get personalApiKeys() {
    return unsupported();
  },
  get access() {
    return unsupported();
  },
  get roles() {
    return unsupported();
  },
  get configAssets() {
    return unsupported();
  },
  get agentProposals() {
    return unsupported();
  },
  get agentTryConversations() {
    return unsupported();
  },
  get approvals() {
    return unsupported();
  },
  get noticeMail() {
    return unsupported();
  },
  get workflowNotices() {
    return unsupported();
  },
  get executionWorkspaces() {
    return unsupported();
  },
  get structuredData() {
    return unsupported();
  },
  get jobs() {
    return unsupported();
  },
  get operationRuns() {
    return unsupported();
  },
  get liveOnceSwitches() {
    return unsupported();
  },
  get capabilityRecords() {
    return unsupported();
  },
  get infrastructureChecks() {
    return unsupported();
  },
  get pages() {
    return unsupported();
  },
  get connections() {
    return unsupported();
  },
  get workflowRuns() {
    return unsupported();
  },
  get workflowRunDatasets() {
    return unsupported();
  },
  get dataStores() {
    return unsupported();
  },
  get knowledgeBases() {
    return unsupported();
  },
  get guardrails() {
    return unsupported();
  },
  get feedback() {
    return unsupported();
  },
  get platformReports() {
    return unsupported();
  },
  get projects() {
    return unsupported();
  },
  transaction: unsupported,
  readSnapshot: unsupported,
  get close() {
    return unsupported();
  },
  get userOperationSettings() {
    return unsupported();
  },
  get readiness() {
    return unsupported();
  }
};
export const unusedApiAccessStore: ApiAccessStore = {
  listServicePrincipals: unsupported,
  findServicePrincipalByName: unsupported,
  findServicePrincipalByOwner: unsupported,
  createServicePrincipal: unsupported,
  updateServicePrincipal: unsupported,
  deleteServicePrincipal: unsupported,
  listApiCredentials: unsupported,
  createApiCredential: unsupported,
  revokeApiCredential: unsupported,
  resolveApiCredential: unsupported,
  updateApiCredentialLastUsed: unsupported
};
export const unusedConfigAssetStore: ConfigAssetStore = {
  getConfigAssetState: unsupported,
  listActiveConfigAssets: unsupported,
  listConfigAssetPage: unsupported,
  listPublishedConfigAssets: unsupported,
  getConfigAsset: unsupported,
  listConfigAssetsByKey: unsupported,
  listConfigAssetsFromPage: unsupported,
  getConfigAssetPageOrigin: unsupported,
  listConfigAssetRevisions: unsupported,
  listConfigAssetPublications: unsupported,
  getConfigAssetRevision: unsupported,
  getConfigAssetRevisionById: unsupported,
  applyConfigAssetMutations: unsupported,
  publishConfigAssetRevision: unsupported,
  unpublishConfigAsset: unsupported,
  discardConfigAssetDraft: unsupported,
  removeConfigAsset: unsupported,
  listAssetRepoBundles: unsupported,
  listAssetsWithoutCommits: unsupported,
  fillAssetRepoRevision: unsupported,
  beginAssetRepoSave: unsupported,
  getAssetRepoSave: unsupported,
  answerAssetRepoSave: unsupported,
  nameAssetRepoSaveBundle: unsupported,
  sweepAssetRepoSaves: unsupported,
  getAssetCheckout: unsupported,
  listOpenAssetCheckouts: unsupported,
  setAssetCheckout: unsupported,
  listAgentAvailability: unsupported,
  agentAwaitsFirstPublish: unsupported,
  setAgentAvailability: unsupported,
  listAgentUseLimits: unsupported,
  setAgentUse: unsupported,
  listPersonalChatSkills: unsupported,
  setPersonalChatSkill: unsupported,
  moveConfigAssets: unsupported
};
export const unusedAuditEventStore: AuditEventStore = {
  appendAuditEvent: unsupported,
  listAuditEvents: unsupported,
  deleteAuditEventsOlderThan: unsupported
};
export const unusedWorkflowNoticesStore: WorkflowNoticesStore = {
  recordPublisher: unsupported,
  publisher: unsupported,
  publishedByCredential: unsupported,
  failureCount: unsupported,
  markNotified: unsupported
};
export const unusedOperationRegistry: OperationRegistry = {
  register: unsupported,
  addSource: unsupported,
  resolve: unsupported,
  resolveMany: unsupported,
  list: unsupported,
  releaseNames: unsupported
};
export const unusedRunOperationDeps: RunOperationDeps = {
  resolveResource: unsupported,
  get clientInstanceId() {
    return unsupported();
  },
  get registry() {
    return unsupported();
  },
  get runs() {
    return unsupported();
  },
  get authorizer() {
    return unsupported();
  },
  get events() {
    return unsupported();
  },
  get audit() {
    return unsupported();
  },
  get policy() {
    return unsupported();
  },
  get approvals() {
    return unsupported();
  },
  approvedToolCall: unsupported,
  get liveOnce() {
    return unsupported();
  },
  get modules() {
    return unsupported();
  },
  agentToolNames: unsupported,
  worksInWorkspace: unsupported,
  agentAvailable: unsupported,
  get logger() {
    return unsupported();
  },
  get now() {
    return unsupported();
  }
};
