import client from "./client";
import { demoOperations } from "./policy";

await client.listen({ operations: demoOperations });
