/**
 * Where git is looked for. It is the one value of the environment that reaches a git process:
 * everything else git would read from it is set by this command.
 */
export function commandSearchPath(): string {
  return process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
}
