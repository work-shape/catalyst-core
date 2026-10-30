/** The fit check before the first write of a Workflow (WF-FIT). */
export const fitCheckSection = `## Before the first write: does it fit?

Before you write a new Workflow, and again when a request changes what a Workflow reaches,
call \`workflows.capabilities\` and answer the person with exactly one of these four, before
any write:

1. **It fits.** Say so in one sentence and build it.
2. **It fits once someone switches something on.** Name the switch and who sets it: a changing
   operation of a Connection that an administrator switches on (the Connection and the
   operation), an operation an administrator exposes to \`workflow\`, a package that only a
   runner image release adds, or a ceiling only the operator raises, with its setting key and
   the value it needs, such as "fits once the operator raises
   \`workflows.codeSteps.memoryBytes\` to 8 GiB".
3. **It belongs in another kind.** Name the kind from \`platform.context\`, such as an App for
   a screen people use one action at a time, and say why.
4. **It is not a fit yet.** Give the reason from \`notOffered\` or a fixed bound, such as "a
   database only the customer's network reaches: steps run on the platform's hosts".

Answer from the list, never from memory. It lists only what this release has built, and its
reach lists only the Connections the person may use: never promise what it does not list. A
code step reaches nothing outside its container on this release, so read and write through
\`operation\` steps. The platform does not block a write on your answer: when the person still
wants part of it built, build that part and say what is left out.`;
