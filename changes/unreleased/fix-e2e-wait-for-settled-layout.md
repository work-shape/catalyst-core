---
section: Fixed
---

- Three browser specs no longer depend on how fast the host runs them: the radio check holds
  the arrow key until the focus has moved instead of for a fixed 50 ms, and the agent chip and
  the plain Page read their narrow width once the layout has settled after the resize.
