// Saves that take a free name in one workspace run one after another in this process, so two
// saves of one name side by side, such as two subagents' downloads, never both take the same
// path and the second replace the first. Workers in other processes are not ordered by it.
const savesOfWorkspace = new Map<string, Promise<void>>();

export function oneSaveAtATime<T>(workspaceId: string, work: () => Promise<T>): Promise<T> {
  const before = savesOfWorkspace.get(workspaceId) ?? Promise.resolve();
  const done = before.then(work, work);
  const forget = () => {
    if (savesOfWorkspace.get(workspaceId) === settled) savesOfWorkspace.delete(workspaceId);
  };
  const settled: Promise<void> = done.then(forget, forget);
  savesOfWorkspace.set(workspaceId, settled);
  return done;
}
