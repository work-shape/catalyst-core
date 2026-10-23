import { sampleResultShapers } from "./result-shapers";
import { defineClientInstance, loadCatalogueEntries } from "@work-shape/catalyst-client-assembly";
import { demoTools } from "../tools";

export default defineClientInstance({
  knowledgeWorker: "separate",
  rootDir: new URL("..", import.meta.url),
  resultShapers: sampleResultShapers,
  tools: demoTools,
  // The demo's sample entry; config/app.yaml offers it under catalogue.entries.
  catalogue: loadCatalogueEntries(new URL("../catalogue", import.meta.url))
});
