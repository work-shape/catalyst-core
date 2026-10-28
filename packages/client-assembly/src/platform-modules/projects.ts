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
  operations: ["projects.list", "projects.get", "projects.create", "conversations.set_project"],
  ui: ["rail.projects", "workspace.projects", "workspace.project"]
});
