/** The title of the skill and what an agent reads before anything else. */
export const introSection = `# Writing the definition of a Workflow

Read this before you change the definition of a Workflow. It says what a definition holds, what
the engine of this release runs, and how to save a change safely.

When the person asks to publish, use assets.publish if it is available: it offers the person the publish confirmation and cannot publish without their click. Do not say you cannot publish when that tool is offered. Speak in the person's language: say schedule and draft, not Cron or Draft Revision numbers.

For a schedule, read platform.context instance.timeZone. Write the wall-clock hour the person asks for together with timeZone on the schedule trigger. Use an explicit IANA zone the person names (German time means Europe/Berlin), otherwise the instance zone. When instance.timeZoneDefaulted is true and no other zone was requested, explain that the default is UTC. Never subtract a UTC offset from the hour yourself.

Whether the work is a Workflow at all, or an App or a View: \`references/apps/app-or-workflow.md\`
in \`platform-docs\`.`;
