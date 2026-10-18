// Customer prompts are fixed requirements. Assertions never grade the assistant's answer.
export const CASES = [
  {
    id: "stateful-app",
    stories: ["S5"],
    deadlineMs: 12 * 60_000,
    prerequisite: "normal demo, apps, workspace-command-worker and Docker sandbox",
    prompt:
      "Build and save a leave-request App with a required date labelled Leave date and a Submit button. Remember my submitted requests when I return; each person must see only their own requests. Show submitted requests as a table with one row per request. Do not publish it; I will share it with my workspace."
  },
  {
    id: "workflow-safe-test",
    stories: ["S2"],
    deadlineMs: 12 * 60_000,
    prerequisite: "normal demo seed shared Workflow account, workflows and notify",
    prompt:
      "Create a draft manually started bookkeeping check. Calculate 19 + 23 and return an output object with total equal to the result. Include an Inbox notice to me after the calculation. It needs no input. Use an existing shared account available in this platform. Save the draft for me to Test from its canvas; do not run or publish it."
  },
  {
    id: "live-skill-consent",
    stories: ["S14"],
    deadlineMs: 6 * 60_000,
    prerequisite: "normal demo live skill write confirmation and reconnect",
    prompt:
      "Create a new live skill named {name}. Its instruction must be exactly: For synthetic bookkeeping examples, show amounts in EUR. Save it in this conversation’s workspace and let me decide whether to allow the live change."
  }
];
const MANUAL = {
  S2: ["Full bookkeeping journey, real data/actions and acceptance walk"],
  S5: ["Language, phone, design, discovery and wider App journeys"],
  S14: ["Records writing and full build/confirm/deny journey beyond live skill creation"]
};
export const STORIES = Object.fromEntries(
  Array.from({ length: 17 }, (_, i) => {
    const id = `S${i + 1}`;
    return [
      id,
      {
        cases: CASES.filter((c) => c.stories.includes(id)).map((c) => c.id),
        manual: MANUAL[id] ?? ["Entire standing story remains unautomated"]
      }
    ];
  })
);
export function plan(args) {
  let selection;
  let reuse;
  let keep = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--") continue;
    if (flag === "--stories" && selection === undefined) selection = args[++i];
    else if (flag === "--reuse" && reuse === undefined) reuse = args[++i];
    else if (flag === "--keep-stack") keep = true;
    else
      throw new Error("Expected --stories S2,S5,S14 [--reuse <owned stack.json>] [--keep-stack]");
  }
  if (!selection || selection.split(",").some((s) => !s.trim()))
    throw new Error("Story selection must not be empty");
  const stories = [...new Set(selection.split(",").map((s) => s.trim()))];
  if (stories.some((s) => !Object.hasOwn(STORIES, s)))
    throw new Error("Unknown story; expected S1–S17");
  if (args.includes("--reuse") && !reuse) throw new Error("Missing owned stack.json");
  const cases = CASES.filter((c) => c.stories.some((s) => stories.includes(s)));
  return {
    stories,
    cases,
    reuse,
    keep,
    coverage: stories.map((id) => ({
      id,
      ...STORIES[id],
      status: STORIES[id].cases.length ? "partial" : "unimplemented"
    }))
  };
}
export function exitCode(plan, results) {
  if (
    plan.coverage.some((c) => !c.cases.length) ||
    results.some((r) => ["blocked", "not-landed"].includes(r.status))
  )
    return 2;
  return results.length === plan.cases.length && results.every((r) => r.status === "pass") ? 0 : 1;
}
