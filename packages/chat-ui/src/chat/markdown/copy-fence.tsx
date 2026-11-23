import { CopyText } from "@work-shape/catalyst-ui";
import { useIsCodeFenceIncomplete } from "streamdown";

// A text the reader takes elsewhere, such as a message or a clause, is written as a fence with
// the language `copy`. It renders as the library's `CopyText` instead of a code block: body
// font, wrapped lines and one button that copies exactly the text between the fence lines.
// What follows the language on the fence line names the text: ```copy Reply to the supplier

/** The language of a fence that holds a text to copy. */
const COPY_FENCE_LANGUAGE = "copy";

/** The element a `copy` fence becomes, so Markdown renders it as `CopyFence`. */
export const COPY_FENCE_TAG = "catalyst-copy-text";

/** The part of a hast node this plugin reads and writes. */
interface FenceNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: FenceNode[];
}

/**
 * The rehype plugin that turns each `copy` fence into its element. It runs after sanitizing,
 * which would drop an element it does not know. The fence's content never was Markdown or
 * HTML: it arrives as one text and leaves as one.
 */
export function copyFences() {
  return (tree: FenceNode) => {
    replaceCopyFences(tree);
  };
}

function replaceCopyFences(parent: FenceNode): void {
  if (!parent.children) {
    return;
  }
  parent.children = parent.children.map((child) => {
    if (child.type !== "element") {
      return child;
    }
    const code = copyFenceCode(child);
    if (!code) {
      replaceCopyFences(child);
      return child;
    }
    const label = code.properties?.metastring;
    const named = typeof label === "string" ? label.trim() : "";
    return {
      type: "element",
      tagName: COPY_FENCE_TAG,
      properties: { text: fenceText(code), ...(named ? { label: named } : {}) },
      children: []
    };
  });
}

/** The `code` of a `pre` that a `copy` fence became, else nothing. */
function copyFenceCode(node: FenceNode): FenceNode | undefined {
  if (node.tagName !== "pre") {
    return undefined;
  }
  const code = node.children?.find((child) => child.type === "element");
  if (code?.tagName !== "code") {
    return undefined;
  }
  const classes = code.properties?.className;
  return Array.isArray(classes) && classes.includes(`language-${COPY_FENCE_LANGUAGE}`)
    ? code
    : undefined;
}

/**
 * The text between the fence lines. Markdown ends a fence's content on a line break that is
 * not part of the text, so exactly that one is taken off.
 */
function fenceText(code: FenceNode): string {
  const text = (code.children ?? []).map((child) => child.value ?? "").join("");
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

/**
 * A `copy` fence in a reply or a Markdown preview. While its closing fence line has not
 * arrived in a reply that is still being written, the text grows and the copy button waits.
 */
export function CopyFence({ text, label }: { text?: string; label?: string }) {
  const writing = useIsCodeFenceIncomplete();
  return (
    <CopyText
      className="my-4"
      data-streamdown="copy-text"
      text={text ?? ""}
      label={label}
      pending={writing}
    />
  );
}
