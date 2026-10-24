import { apiOperations, parseJobStatusList } from "@work-shape/catalyst-api-contract";
import type { Route } from "../http/route";
import { JobAdminWorkflow } from "../jobs/job-admin-service";
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

  // A retry runs work again that the product gave up on: the right `jobs.retry`, whose default
  // sits with `superadmin` alone (RIGHTS-1e).
  route.operation(retry, {
    resource: ({ jobId }) => ({ kind: "job", id: jobId }),
    execute: ({ jobId }, context) => workflow.retry(jobId, context)
  });
}
