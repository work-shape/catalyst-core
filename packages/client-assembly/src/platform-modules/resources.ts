import { defineModule } from "@work-shape/catalyst-core";

/** The Resources panel of a conversation and the list it reads. */
export const resourcesModule = defineModule({
  name: "resources",
  operations: ["conversations.resources.list"],
  ui: ["conversation.resources"]
});
