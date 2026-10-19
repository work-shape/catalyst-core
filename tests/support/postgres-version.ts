import { readFileSync } from "node:fs";
import postgres from "postgres";

const dockerfile = new URL("../../docker/postgres/Dockerfile", import.meta.url);

/** The major version of the pinned image's base, `ARG POSTGRES_BASE=postgres:<major>.<minor>…`. */
export function pinnedPostgresMajor(source = readFileSync(dockerfile, "utf8")): number {
  const major = source.match(/^ARG POSTGRES_BASE=postgres:(\d+)[.-]/mu)?.[1];
  if (!major) throw new Error("docker/postgres/Dockerfile names no postgres:<major> base");
  return Number(major);
}

/** Why a server of this `server_version_num` is not the pinned major, or undefined if it is. */
export function postgresMajorMismatch(
  serverVersionNum: number,
  pinnedMajor: number
): string | undefined {
  const major = Math.floor(serverVersionNum / 10000);
  if (major === pinnedMajor) return undefined;
  return (
    `The test Postgres at POSTGRES_STORE_TEST_DATABASE_URL is Postgres ${major}; the pinned image ` +
    `(docker/postgres/pinned-image) is Postgres ${pinnedMajor}. Query plans differ between majors, ` +
    `so the tests refuse to run. Point POSTGRES_STORE_TEST_DATABASE_URL at a Postgres ${pinnedMajor} ` +
    `server, such as the pinned image, which pnpm check:local starts.`
  );
}

export async function assertPinnedPostgresMajor(url: string): Promise<void> {
  const sql = postgres(url, { max: 1, connect_timeout: 5, onnotice() {} });
  let versionNum: number;
  try {
    const [row] = await sql<{ server_version_num: string }[]>`show server_version_num`;
    versionNum = Number(row?.server_version_num);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => undefined);
  }
  if (!Number.isInteger(versionNum))
    throw new Error("The test Postgres reported no server_version_num");
  const mismatch = postgresMajorMismatch(versionNum, pinnedPostgresMajor());
  if (mismatch) throw new Error(mismatch);
}
