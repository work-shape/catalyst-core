import type { TestProject } from "vitest/node";
import { PostgresFixtures } from "./postgres-fixtures";
import { assertPinnedPostgresMajor } from "./postgres-version";

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  // Extended projects inherit globalSetup arrays. Only the root owns the run; its
  // provided prefix is inherited by every project after all global setup has completed.
  if (!project.isRootProject()) return async () => {};
  const url = process.env.POSTGRES_STORE_TEST_DATABASE_URL;
  if (url) await assertPinnedPostgresMajor(url);
  const fixtures = new PostgresFixtures();
  try {
    if (url) await fixtures.prepare();
  } catch (error) {
    await fixtures.close();
    throw error;
  }
  project.provide("postgresFixturePrefix", fixtures.prefix);
  return () => fixtures.close();
}
