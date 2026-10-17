---
section: Added
---

- KB-ISO-2: `defineClientInstance({ knowledgeWorker: "separate" })` and `runKnowledgeWorker()` move Knowledge Base ingestion out of the API, with independent platform and Data Store pools. The default remains `in_process`. A worker started with that default refuses with `The knowledge worker requires knowledgeWorker: "separate" in defineClientInstance`. Search, operations and retries remain in the API; an absent worker leaves ingestion queued and its page reports that it is waiting.
- Demo and Musterbau assemblies include the knowledge-worker entry, resource-limited Compose services, a six-connection worker pool default (`KNOWLEDGE_WORKER_POOL_SIZE`), and a Compose gate. Document workers in the paired capabilities release select `DOCUMENT_WORKER_ROLE=chat|knowledge|all` (default `all`); dedicated knowledge extraction serves two conversions apart from chat uploads. The release smoke waits for a fresh index-worker report when the knowledge module is on.
- Release order: publish core and paired capabilities together, then bump the deployment to that release before activating its new wiring. This does not enable a module. Rollback requires restoring both placement and services together: reverting only the worker service while keeping `separate` leaves ingestion queued. Staging CPU overrides are 0.5 each; production defaults require the release owner to verify the live server size before deployment.

- Rollout fixes: the remote deploy uses only Ubuntu base utilities and Docker to discover knowledge services and their entrypoint, with a no-`jq` host fixture. Readiness tests require a post-rollout heartbeat; both successful and failed syncs wake a waiting Workflow step once.

- Service discovery captures Compose output once before matching optional workers, so SIGPIPE cannot skip their replacement or readiness checks under `pipefail`. A repeated streaming-Docker fixture covers the regression.

- Rebase integration: source-boundary reconciliation joins the central ingestion registry, so the API cannot claim it when a separate knowledge worker owns ingestion.
