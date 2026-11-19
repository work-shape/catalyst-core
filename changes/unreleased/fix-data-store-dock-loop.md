---
section: Fixed
---

- **UI library:** the page of a Data Store never published no longer fails with "Maximum update
  depth exceeded" at phone width. In a detail head with a line of facts, the name now keeps its
  own width and the chips after it give way first; before, bringing back the text of the way back
  cut the name, which took the text away again in every render. Where that would still happen,
  the text stays gone until the row's width or the name changes.
