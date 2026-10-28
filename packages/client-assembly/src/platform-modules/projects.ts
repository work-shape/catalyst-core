import { defineModule } from "@work-shape/catalyst-core";

/**
 * Projects (PRJ-1): a named folder of chat work in one workspace, shared with its members or
 * private to its creator, on in every workspace once the module is on. Off by default. Off, no
 * project is created, listed or read, no conversation enters one, and the interface shows no
 * Projects row. Conversations already in a project keep their audience either way.
 */
export const projectsModule = defineModule({
  name: "projects",
  kinds: ["project"],
  operations: [
    "projects.list",
    "projects.get",
    "projects.create",
    "conversations.set_project",
    "projects.files.list",
    "projects.files.versions",
    "projects.files.get_content",
    "projects.files.upload",
    "projects.files.move",
    "projects.files.delete",
    "projects.files.purge",
    "projects.files.restore",
    "conversations.project_files.save",
    "conversations.draft_attachments.add_from_project"
  ],
  ui: ["rail.projects", "workspace.projects", "workspace.project"]
});
