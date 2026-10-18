import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test as base, type BrowserContext } from "@playwright/test";
import { takeInstanceTurn } from "./instance-turn";
import { BESIDE_TOP_ANCHORED_TURN, isAllowed } from "./allowed-page-errors";

/**
 * The budget for one holder of the instance state, also used to reclaim an abandoned lock.
 */
const ACCESS_STATE_WAIT_MS = 180_000;

export interface PageErrorWatch {
  /** Watches a context a test opened itself, such as a second user's, before it opens a page. */
  watch(context: BrowserContext): Promise<void>;
}

/** How old a lock or a mark of a reader is, or nothing when it is not there. */
async function ageOf(path: string): Promise<number | undefined> {
  return stat(path).then(
    (entry) => Date.now() - entry.mtimeMs,
    () => undefined
  );
}

const pause = () => new Promise((resolve) => setTimeout(resolve, 250));

/** Take the process-owned turn with the current test's diagnostics. */
export function takeTurn(
  name: "access" | "release-connections",
  baseURL: string | undefined
): Promise<() => Promise<void>> {
  const info = base.info();
  return takeInstanceTurn(name, baseURL, {
    worker: info.workerIndex,
    project: info.project.name,
    file: info.file,
    title: info.title
  });
}

/** The places of the turn-taking on the instance's agents, by the instance's address. */
function agentTurns(baseURL: string | undefined) {
  const instance = (baseURL ?? "").replace(/\W+/gu, "-");
  return {
    /** A directory that is there while a test adds or removes agents. */
    changing: join(tmpdir(), `catalyst-e2e-agents-changing-${instance}`),
    /** One file for each test that reads the whole list at this moment. */
    reading: join(tmpdir(), `catalyst-e2e-agents-reading-${instance}`)
  };
}

/** The marks of the tests that read the agent list now. One a killed run left is removed. */
async function agentReaders(reading: string): Promise<string[]> {
  const marks = await readdir(reading).catch(() => []);
  const live: string[] = [];
  for (const mark of marks) {
    const age = await ageOf(join(reading, mark));
    if (age !== undefined && age > ACCESS_STATE_WAIT_MS) {
      await rm(join(reading, mark), { force: true });
    } else if (age !== undefined) {
      live.push(mark);
    }
  }
  return live;
}

/**
 * The `test` of every browser spec. It fails a test whose pages threw an uncaught JavaScript
 * error or logged one with `console.error`, after the test's own steps have run.
 */
export const test = base.extend<{
  pageErrors: PageErrorWatch;
  accessState: void;
  instanceAgents: void;
  instanceAgentsChange: void;
  releaseConnections: void;
}>({
  /**
   * Asked for by a test that registers a Namespace or writes a grant, or that asserts there is
   * none. The specs run side by side against one instance, and such a test would see the
   * other's rows: with this fixture one runs after the other.
   */
  accessState: [
    async ({ baseURL }, use) => {
      const release = await takeTurn("access", baseURL);
      try {
        await use();
      } finally {
        await release();
      }
    },
    // Healthy queue time is unbounded and does not consume the test's own timeout.
    { timeout: 0 }
  ],
  /**
   * Asked for by a test that asserts the whole list of agents a member is offered, by count or
   * by every name. A new agent is offered in every workspace from the moment it is stored, so
   * an agent another spec file holds at that moment would stand in the list. Such tests run
   * side by side with each other, and not while a test with `instanceAgentsChange` runs.
   */
  instanceAgents: [
    async ({ baseURL }, use) => {
      const { changing, reading } = agentTurns(baseURL);
      const mark = join(reading, randomUUID());
      const waitUntil = Date.now() + ACCESS_STATE_WAIT_MS;
      await mkdir(reading, { recursive: true });
      for (;;) {
        // The mark is set before the look at the other side, as the changing test sets its
        // directory before it looks here: one of the two always sees the other.
        await writeFile(mark, "");
        const age = await ageOf(changing);
        if (age === undefined) {
          break;
        }
        await rm(mark, { force: true });
        if (age > ACCESS_STATE_WAIT_MS) {
          await rmdir(changing).catch(() => undefined);
        } else if (Date.now() > waitUntil) {
          throw new Error(`The agents of the instance stayed in change: ${changing}`);
        } else {
          await pause();
        }
      }
      try {
        await use();
      } finally {
        await rm(mark, { force: true });
      }
    },
    { timeout: ACCESS_STATE_WAIT_MS + 10_000 }
  ],
  /**
   * Asked for by a test that stores or deletes an agent of the instance. It runs when no test
   * with `instanceAgents` runs and no other test changes agents. It takes its turn on the
   * Namespaces and grants first, so two such tests never wait for each other.
   */
  instanceAgentsChange: [
    async ({ baseURL, accessState: _accessState }, use) => {
      const { changing, reading } = agentTurns(baseURL);
      const waitUntil = Date.now() + ACCESS_STATE_WAIT_MS;
      // `accessState` lets one such test through at a time, so the directory is free or left
      // behind by a run that was killed.
      await rmdir(changing).catch(() => undefined);
      await mkdir(changing);
      try {
        while ((await agentReaders(reading)).length > 0) {
          if (Date.now() > waitUntil) {
            throw new Error(`The agent list of the instance stayed in use: ${reading}`);
          }
          await pause();
        }
        await use();
      } finally {
        await rmdir(changing).catch(() => undefined);
      }
    },
    { timeout: 2 * ACCESS_STATE_WAIT_MS + 10_000 }
  ],
  /**
   * Asked for by every test that creates Connections (through the UI too), reads their whole
   * list, or plants a Guardrail of origin `release`. Connections belong to the instance, so
   * unique names and separate workspaces do not isolate an empty-list or rights assertion.
   * Hold the turn until the test has removed its assets and grants. An API process that starts
   * also reconciles release assets, so it takes the same turn while starting
   * (`takeTurn("release-connections", …)`).
   */
  releaseConnections: [
    // Every Connection writer takes access first. An access holder must not sit behind a
    // queue of editor tests while holding a lock that other rights tests need.
    async ({ baseURL, accessState: _accessState }, use) => {
      const release = await takeTurn("release-connections", baseURL);
      try {
        await use();
      } finally {
        await release();
      }
    },
    // Healthy queue time is unbounded and does not consume the test's own timeout.
    { timeout: 0 }
  ],
  pageErrors: [
    async ({ context }, use, testInfo) => {
      const reported: string[] = [];
      const report = (kind: "pageerror" | "console.error", text: string, address = "") => {
        if (!isAllowed(text, address, testInfo.title)) {
          reported.push(address ? `${kind}: ${text} (${address})` : `${kind}: ${text}`);
        }
      };
      const watch = async (watched: BrowserContext) => {
        // An error event without an exception, such as a resize observer loop, reaches neither
        // the console nor `weberror`. The page logs it, so it is reported like the rest.
        await watched.addInitScript((besideTopAnchoredTurn) => {
          window.addEventListener("error", (event) => {
            if (event.error === null || event.error === undefined) {
              const anchored = document.querySelector("[data-aui-top-anchor-target]") !== null;
              console.error(
                `Error event without an exception: ${event.message}${anchored ? besideTopAnchoredTurn : ""}`
              );
            }
          });
        }, BESIDE_TOP_ANCHORED_TURN);
        watched.on("weberror", (webError) => report("pageerror", webError.error().message));
        watched.on("console", (message) => {
          if (message.type() === "error") {
            report("console.error", message.text(), message.location().url);
          }
        });
      };
      await watch(context);
      await use({ watch });
      expect(reported, "JavaScript errors on the page").toEqual([]);
    },
    { auto: true }
  ]
});

export { expect };
