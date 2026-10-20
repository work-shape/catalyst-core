import type { ClientInstanceApp } from "@work-shape/catalyst-client-assembly";
import client from "./client";
import { demoOperations } from "./policy";

// The policy reads the instance's workspaces, which it finds here once `listen` answers.
const running: { app?: ClientInstanceApp } = {};
running.app = await client.listen({ operations: demoOperations(() => running.app) });
