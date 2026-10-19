import type { TestProject } from "vitest/node";
import { PostgresFixtures } from "./postgres-fixtures";
import { assertPinnedPostgresMajor } from "./postgres-version";

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const url = process.env.POSTGRES_STORE_TEST_DATABASE_URL;
  if (url) await assertPinnedPostgresMajor(url);
  const fixtures = new PostgresFixtures();
  project.provide("postgresFixturePrefix", fixtures.prefix);
  return () => fixtures.close();
}
