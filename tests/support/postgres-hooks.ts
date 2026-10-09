import { beforeAll, beforeEach } from "vitest";

/** Vitest marks tests skipped when beforeAll throws. Surface setup failure on every test. */
export function beforeAllWithPostgres(setup: () => unknown, timeout?: number): void {
  let failed = false;
  let failure: unknown;
  beforeAll(async () => {
    try {
      await setup();
    } catch (error) {
      failed = true;
      failure = error;
    }
  }, timeout);
  beforeEach(() => {
    if (failed) throw failure;
  });
}
