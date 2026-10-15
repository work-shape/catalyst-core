---
section: Fixed
---

- The composer's model picker opens its menu and its Model and Reasoning panels above the page, through the UI library's popover. In the chat beside a Workflow canvas the model panel was cut off at the chat's edge; it now shows whole, flips below the composer where there is no room above, and shifts to stay in the window. The picker follows a window resized across the breakpoint, keeps a panel no taller than the window with its Back row in reach, leaves the open panel in place while the pointer crosses the other row into it, and works from the keyboard: the arrow key towards a panel or Enter enters it, the other arrow key or Escape goes back one level. `PopoverContent` takes `surface="none"` for content that draws its own surfaces, and `reserve` for room kept free beside it, and `onEscapeKeyDown`.
