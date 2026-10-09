import { Slot } from "radix-ui";
import {
  cloneElement,
  isValidElement,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode
} from "react";

export interface LinkSlotProps extends HTMLAttributes<HTMLElement> {
  /** The caller's link element, such as `<a href>` or its router's link. */
  link: ReactElement;
  children: ReactNode;
}

/**
 * Renders the caller's link element with a library component's props and content. The library
 * imports no router: whatever navigates comes in as an element and leaves as the same element.
 */
export function LinkSlot({ link, children, ...props }: LinkSlotProps) {
  return <Slot.Root {...props}>{cloneElement(link, undefined, children)}</Slot.Root>;
}

/**
 * Splits the single child of a component used with `asChild` into the link element and the
 * label written inside it.
 */
export function splitLinkChild(
  component: string,
  children: ReactNode
): { link: ReactElement; label: ReactNode } {
  if (!isValidElement<{ children?: ReactNode }>(children)) {
    throw new Error(`${component} with asChild takes one link element as its only child.`);
  }
  return { link: children, label: children.props.children };
}
