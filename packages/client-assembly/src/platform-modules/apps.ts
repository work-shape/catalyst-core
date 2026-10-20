import { defineModule } from "@work-shape/catalyst-core";
import { APP_PUBLISH_TOOL_NAME } from "@work-shape/catalyst-tool-execution";

/**
 * Apps and their previews: the file sets a conversation keeps, their history, the route that
 * serves them, the tools that open a folder and save it as an App, and the job that builds it.
 * The build runs in the sandbox, so the workspace command worker serves it.
 */
export const appsModule = defineModule({
  name: "apps",
  operations: [
    "pages.list",
    "pages.get",
    "pages.files.get",
    "pages.files.list",
    "pages.preview",
    "app_content.files.get",
    "app_kit.files.get",
    "apps.create_from_page",
    "apps.actions.list",
    "apps.update_from_page",
    "apps.get_from_page",
    "apps.preview",
    "apps.sessions.context",
    "apps.sessions.call_action",
    "apps.sessions.write_storage",
    "apps.sessions.get_workflow_run"
  ],
  kinds: ["app"],
  tools: ["workspace.open", "app.save", APP_PUBLISH_TOOL_NAME],
  jobKinds: ["page.bundle", "asset_repo.commit", "asset_repo.sweep"],
  commandWorkerJobKinds: ["page.bundle", "asset_repo.commit", "asset_repo.sweep"]
});
