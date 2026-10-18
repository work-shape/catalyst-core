/** Small per-App, per-person JSON. Business records shared by people belong in a Data Store. */
interface AppStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

declare global {
  interface Window {
    /** Installed by the platform before App scripts run; checked before use. */
    readonly catalystAppStorage?: unknown;
  }
}

function runtime(): AppStorage {
  const value = window.catalystAppStorage;
  if (
    typeof value !== "object" ||
    value === null ||
    !("get" in value) ||
    typeof value.get !== "function" ||
    !("set" in value) ||
    typeof value.set !== "function"
  ) {
    throw new Error("App storage is available inside an App preview on this platform.");
  }
  const get = value.get;
  const set = value.set;
  return {
    get: async (key) => get(key),
    set: async (key, data) => {
      await set(key, data);
    }
  };
}

export const storage: AppStorage = {
  get: (key) => runtime().get(key),
  set: (key, value) => runtime().set(key, value)
};
