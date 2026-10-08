import type { AuthRequestHeaders } from "./types";

export function hasExplicitCredentials(headers: AuthRequestHeaders): boolean {
  return Object.entries(headers).some(
    ([name, value]) =>
      value !== undefined && ["authorization", "x-server-credential"].includes(name.toLowerCase())
  );
}
