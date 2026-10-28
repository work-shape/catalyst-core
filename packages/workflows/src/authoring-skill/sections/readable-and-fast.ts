/** How an agent makes a Workflow a person can follow, and one that does no work twice. */
export const readableAndFastSection = `## Steps a person can follow, work done once

Give every step a \`description\` beside its \`name\`: one or two plain sentences that say where
its input comes from (the start form, an earlier step, a Connection), what the step does, and
what it hands on or where it stores it (only in the run, or kept in a Data Store, and who sees it
there). Write for the person who runs the Workflow, not for a developer: no ids, paths or code.
For example: "Takes the client number from the start form, loads that client's bookings from
the accounting system once, and hands them to the checks below. Keeps them only in this run."

Load data once and reuse it. Read what a source answers in one step near the top and refer to
that step's output in every later step; never call the same operation again for data a step
already has. Put independent analyses of the same loaded data into a \`parallel\` block;
map each branch's input to the load step's output. Reuse these values within this run, rather
than promising a cache across runs. Use a Data Store only when results need to persist,
and explain who can read them there. The step after the block waits for every analysis.
Where items do not depend on each other, such as one check per client or per
document, put them in a \`loop\` and set its \`concurrency\` so they run at once. Steps within
a branch still run one after the other.`;
