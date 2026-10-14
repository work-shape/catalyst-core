---
section: Fixed
---

- **The test that a loop runs three items at once no longer fails now and then on a busy
  runner:** it counted the calls that were with the Connection in the same 40 ms, so three items
  that reached their call further apart than that were counted as two. The first calls now wait
  for each other, for 1.5 s at most, before the 40 ms begin. A loop that runs fewer items at once
  still fails the count, and one that runs a fourth is still counted.
