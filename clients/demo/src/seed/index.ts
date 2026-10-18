// What a test of the seed reaches the demo by: the seed, the company it brings, and the two
// things the demo's server is assembled from.

export { demoTools } from "../../tools";
export { demoOperations } from "../policy";
export {
  SEED_EMAIL_SUFFIX,
  apps,
  builder,
  checkQuestions,
  connectionCheckQuestions,
  heldSkillChange,
  people,
  workflowCheckQuestions,
  workspace,
  workspaceAssets,
  type CheckReason
} from "./company";
/** All the company brings, for a test that checks every entry of a kind. */
export * as demoCompany from "./company";
export { assertLocalDevelopmentHost } from "./adapters/local-network";
export { seedDemo, type SeedReport } from "./run";
