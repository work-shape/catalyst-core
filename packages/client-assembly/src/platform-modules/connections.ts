import { defineModule } from "@work-shape/catalyst-core";
import {
  CONNECTION_DRAFT_TOOL_NAME,
  CONNECTION_OFFER_TOOL_NAME
} from "@work-shape/catalyst-tool-execution";

/**
 * Connections: the asset kind that holds the access to an outside system, and its list in
 * Build. Off, the kind does not exist on the instance: no call reads, lists or writes one and
 * no right on one is handed out, and no discovery runs. What the store holds stays and is
 * inactive.
 */
export const connectionsModule = defineModule({
  name: "connections",
  operations: [
    "connections.get",
    "connections.test",
    "connections.set_secret",
    "connections.discover",
    "connections.oauth_start",
    "connections.oauth_complete",
    "connections.disconnect",
    "connections.person_context",
    "connections.set_person_context",
    "connections.list_tools"
  ],
  kinds: ["connection"],
  // The agent's draft of a REST API's tools checks them against the instance's Connector types;
  // its offer of a Connection's tools to an agent is a card the person confirms.
  tools: [CONNECTION_DRAFT_TOOL_NAME, CONNECTION_OFFER_TOOL_NAME],
  jobKinds: [
    "connection.discover",
    "connection_setup_sessions.sweep",
    "connection_bindings.keep_alive"
  ],
  ui: ["build.connections"]
});
