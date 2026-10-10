import { apiOperations, parseJobStatusList } from "@vivd-catalyst/api-contract";
import { isAuthenticatedServicePrincipal, isSuperadmin } from "@vivd-catalyst/core";
import type { Route } from "../http/route";
import { JobAdminWorkflow } from "../job-admin-workflow";
import type { ChatServerOptions } from "../types";

/** Instance > Jobs: what the background is doing, and the retry of a job that died. */
export function registerJobRoutes(route: Route, options: ChatServerOptions): void {
  const workflow = new JobAdminWorkflow(options);
  const retry = apiOperations["instance.jobs.retry"];

  route(apiOperations["instance.jobs.summary"], async () => ({ items: await workflow.summary() }));

  route(apiOperations["instance.jobs.list"], ({ query, paging }) =>
    workflow.list(
      {
        kind: query.kind,
        statuses: query.status === undefined ? undefined : parseJobStatusList(query.status)
      },
      paging
    )
  );

  route.operation(retry, {
    // A retry runs work again that the product gave up on, so it is a superadmin's alone.
    authorize: (_input, { actor }) =>
      !isAuthenticatedServicePrincipal(actor) && isSuperadmin(actor)
        ? { allowed: true }
        : { allowed: false, action: retry.id, reason: "no_grant" },
    resource: ({ jobId }) => ({ kind: "job", id: jobId }),
    execute: ({ jobId }, context) => workflow.retry(jobId, context)
  });
}
