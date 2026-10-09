import { vi } from "vitest";

/**
 * The view composer reads the scripts of a stored view with the browser's HTML parser, and
 * unit tests run without one. This stands in for it with the plain cases these tests use: a
 * script element with its text between a start and an end tag. What the real parser does with
 * line ends, comments, templates and odd end tags is held by `e2e/view-runtime.spec.ts`.
 */
export function stubViewHtmlParser(): void {
  vi.stubGlobal(
    "DOMParser",
    class {
      parseFromString(html: string) {
        const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/giu)].map(
          (match) => ({
            text: match[2] ?? "",
            hasAttribute: (name: string) => new RegExp(`\\b${name}\\s*=`, "iu").test(match[1] ?? "")
          })
        );
        return { querySelectorAll: () => scripts };
      }
    }
  );
}
