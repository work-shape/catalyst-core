// What a test of the seed reaches the demo by: the seed, the company it brings, and the two
// things the demo's server is assembled from.

export { demoTools } from "../../tools";
export { demoOperations } from "../policy";
export {
  SEED_EMAIL_SUFFIX,
  apps,
  checkQuestions,
  connectionCheckQuestions,
  people,
  workspace,
  type CheckReason
} from "./company";
export { assertLocalDevelopmentHost } from "./adapters/local-network";
export { seedDemo, type SeedReport } from "./run";
