import { APP_USER_STORAGE_MAX_BYTES } from "@work-shape/catalyst-core";

export interface AppStorageBootstrap {
  session: string;
  values: Record<string, string>;
  persistent: boolean;
}

/** Installed before any App script, including Apps built against retained kit versions. */
const APP_STORAGE_SOURCE = `function installAppStorage(input) {
  const host = input.persistent ? window.parent.parent : undefined;
  let values = new Map(Object.entries(input.values));
  let sequence = 0;
  const waiting = new Map();
  function change(mutation) {
    const next = new Map(values);
    if (mutation.type === "set") next.set(mutation.key, mutation.value);
    else if (mutation.type === "remove") next.delete(mutation.key);
    else next.clear();
    if (new TextEncoder().encode(JSON.stringify(Object.fromEntries(next))).byteLength > input.maxBytes) {
      throw new DOMException(\`App storage exceeds APP_USER_STORAGE_MAX_BYTES (\${input.maxBytes} bytes). Use a Data Store for business records.\`, "QuotaExceededError");
    }
    values = next;
    if (!input.persistent) return Promise.resolve();
    const requestId = \`storage-\${++sequence}\`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        waiting.delete(requestId);
        reject(new Error("The interface did not save App storage. Try again."));
      }, input.timeoutMs);
      waiting.set(requestId, {
        resolve: () => {
          clearTimeout(timeout);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        }
      });
      host.postMessage({ catalystBridge: 1, type: "storage_write", session: input.session, requestId, mutation }, "*");
    });
  }
  if (input.persistent) window.addEventListener("message", (event) => {
    const data = event.data;
    if (event.source !== host || typeof data !== "object" || data === null || !("catalystBridge" in data) || data.catalystBridge !== 1 || !("type" in data) || data.type !== "storage_result" || !("session" in data) || data.session !== input.session || !("requestId" in data) || typeof data.requestId !== "string") return;
    const pending = waiting.get(data.requestId);
    if (!pending) return;
    waiting.delete(data.requestId);
    if ("ok" in data && data.ok === true) pending.resolve();
    else pending.reject(new Error("The interface did not save App storage. Try again."));
  });
  function report(promise) {
    void promise.catch((error) => {
      window.dispatchEvent(new CustomEvent("catalyst-storage-error", { detail: error }));
    });
  }
  const methods = {
    getItem: (key) => values.get(String(key)) ?? null,
    setItem: (key, value) => report(change({ type: "set", key: String(key), value: String(value) })),
    removeItem: (key) => report(change({ type: "remove", key: String(key) })),
    clear: () => report(change({ type: "clear" })),
    key: (index) => [...values.keys()][Number(index) >>> 0] ?? null
  };
  const storage = new Proxy(Object.create(null), {
    get(_target, key) {
      if (key === "length") return values.size;
      if (typeof key !== "string") return void 0;
      if (Object.hasOwn(methods, key)) return Reflect.get(methods, key);
      return values.get(key);
    },
    set(_target, key, value) {
      if (typeof key !== "string") return false;
      methods.setItem(key, String(value));
      return true;
    },
    deleteProperty(_target, key) {
      if (typeof key === "string") methods.removeItem(key);
      return true;
    },
    ownKeys: () => [...values.keys()],
    has: (_target, key) => typeof key === "string" && (values.has(key) || Object.hasOwn(methods, key) || key === "length"),
    getOwnPropertyDescriptor: (_target, key) => typeof key === "string" && values.has(key) ? { configurable: true, enumerable: true, writable: true, value: values.get(key) } : void 0
  });
  Object.defineProperty(window, "localStorage", { value: storage });
  Object.defineProperty(window, "catalystAppStorage", { value: {
    get: async (key) => {
      const value = methods.getItem(key);
      return value === null ? null : JSON.parse(value);
    },
    set: async (key, value) => {
      const text = JSON.stringify(value);
      if (text === void 0) throw new TypeError("App storage holds JSON values.");
      return change({ type: "set", key, value: text });
    }
  } });
}`;

// A lost host cannot leave the kit's asynchronous save waiting forever; the caller gets retry.
const APP_STORAGE_WRITE_TIMEOUT_MS = 30_000;

export function appStorageBootstrap(input: AppStorageBootstrap): string {
  const data = JSON.stringify({
    ...input,
    maxBytes: APP_USER_STORAGE_MAX_BYTES,
    timeoutMs: APP_STORAGE_WRITE_TIMEOUT_MS
  }).replaceAll("<", "\\u003c");
  return `(${APP_STORAGE_SOURCE})(${data});`;
}
