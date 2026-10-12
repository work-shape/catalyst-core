// What the tests of the Agents page read. The interface itself reaches the page through the
// area route table and the workspace shell.
export {
  AGENT_CARD_PROMPTS_MAX,
  agentCardPrompts,
  agentListStatus,
  agentStudioRoute
} from "./agents-model";
export { AgentsPage, type AgentsPageProps } from "./agents-page";
// The address of the page and its row in the rail, which the same tests hold.
export { areaOfRoute, workspaceRouteFromPath, workspaceRoutePath } from "../routes";
export { railSections, shownRailSections } from "../workspace/rail-sections";
