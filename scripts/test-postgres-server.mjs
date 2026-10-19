// How a throwaway test Postgres runs: `pnpm check:local`, the agent stories' stack and the
// browser runner's Compose stack. Such a server keeps nothing past its run, so its data
// directory is memory and nothing waits for a disk: no fsync, no full-page images, and a
// checkpoint only when a statement asks for one (DROP DATABASE does, for every test file).
// .github/scripts/start-postgres.sh repeats these lines for the hosted check.
// Never for an instance's database.

/** The data directory of the image (its PGDATA), mounted as memory. */
export const TEST_POSTGRES_DATA_DIRECTORY = "/var/lib/postgresql/data";

/** The server settings, as `name=value`. */
export const TEST_POSTGRES_SETTINGS = [
  "fsync=off",
  "synchronous_commit=off",
  "full_page_writes=off",
  "checkpoint_timeout=1d",
  "max_wal_size=4GB",
  "shared_buffers=512MB"
];

/** `docker run` options before the image. */
export const testPostgresDockerOptions = () => ["--tmpfs", TEST_POSTGRES_DATA_DIRECTORY];

/** Arguments after the image: each setting as `-c name=value`. */
export const testPostgresServerArguments = () => TEST_POSTGRES_SETTINGS.flatMap((s) => ["-c", s]);
