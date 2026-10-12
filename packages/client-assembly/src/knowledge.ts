import { knowledgeModule } from "@vivd-catalyst/data-stores";
import type { ModuleSeam } from "./module-assembly";

export { knowledgeModule };

/** What an instance with the module `knowledge` on has for its Knowledge Bases. Nothing yet. */
export const assembleKnowledge: ModuleSeam = ({ modules }) =>
  modules.isEnabled(knowledgeModule.name) ? {} : undefined;
