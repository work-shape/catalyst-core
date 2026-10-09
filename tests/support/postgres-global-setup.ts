import type { TestProject } from "vitest/node";
import { PostgresFixtures } from "./postgres-fixtures";

export default function setup(project: TestProject): () => Promise<void> {
  const fixtures = new PostgresFixtures();
  project.provide("postgresFixturePrefix", fixtures.prefix);
  return () => fixtures.close();
}
