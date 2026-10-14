---
section: Added
---

- **The chat dock beside every page (DOCK-1):** a conversation opened from a page's link
  stands in a dock at the left of that page and of every page after it, as
  `?chat=<conversation>` in the address; a reload or a new tab brings it back, and a
  conversation the person may not read leaves the dock empty without an error. A change of
  route never mounts the conversation anew, so its running answer, the composer's text and its
  scroll position stay. The dock opens at 420 px, keeps 380 px for itself and the page, and
  remembers a dragged width; below a main area of 760 px it lies over the page with "Show page"
  and "Show chat". Close hides it, and "Chat" in the page head brings it back with a dot while
  its answer runs. Going into or out of the dock plays a 250 ms view transition
  (`--duration-dock`), at once under reduced motion. The UI library gains `SplitHandle`,
  `SurfaceHeader` and `PageHeaderShellAction`.
