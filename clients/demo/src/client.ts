import { defineClientInstance } from "@work-shape/catalyst-client-assembly";
import { demoTools } from "../tools";

export default defineClientInstance({
  knowledgeWorker: "separate",
  rootDir: new URL("..", import.meta.url),
  tools: demoTools
});
