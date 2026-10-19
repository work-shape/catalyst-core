import { describe, expect, it } from "vitest";
import { pinnedPostgresMajor, postgresMajorMismatch } from "./support/postgres-version";

describe("the test Postgres version guard", () => {
  it("reads the pinned major from the image's Dockerfile", () => {
    expect(pinnedPostgresMajor()).toBe(17);
    expect(pinnedPostgresMajor("ARG POSTGRES_BASE=postgres:18.1-trixie@sha256:abc\n")).toBe(18);
    expect(() => pinnedPostgresMajor("FROM debian\n")).toThrow(/names no postgres/u);
  });

  it("refuses a server of another major and accepts any minor of the pinned one", () => {
    expect(postgresMajorMismatch(170011, 17)).toBeUndefined();
    expect(postgresMajorMismatch(170002, 17)).toBeUndefined();
    expect(postgresMajorMismatch(180001, 17)).toMatch(
      /is Postgres 18; the pinned image .* is Postgres 17/u
    );
  });
});
