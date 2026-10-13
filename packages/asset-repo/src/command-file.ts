import { fileURLToPath } from "node:url";

/**
 * The script of the command as this package ships it, for an instance whose sandbox is the
 * `local` provider: there the command is a process of the worker and is started by this path,
 * with the git of the machine. A `docker` sandbox starts the command its image installed.
 */
export function assetRepoCommandFile(): string {
  return fileURLToPath(new URL("../dist/cli.js", import.meta.url));
}
