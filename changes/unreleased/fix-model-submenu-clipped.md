---
section: Fixed
---

- The composer's model picker opens its menu and its Model and Reasoning panels above the page, through the UI library's popover. In the chat beside a Workflow canvas the model panel was cut off at the chat's edge; it now shows whole, flips below the composer where there is no room above, and shifts to stay in the window. `PopoverContent` takes `surface="none"` for content that draws its own surfaces, and `reserve` for room kept free beside it.
