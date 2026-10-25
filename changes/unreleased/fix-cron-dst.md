---
section: Fixed
---

- The test of a scheduled start's late tick sets the worker's clock instead of reading the real one, so it no longer fails when the suite runs inside a repeated hour after the clock is set back. Scheduling did not change: a schedule runs once for every time of day it names, on both days a year the clock changes. A time the clock shows twice is due the first time only, and times the clock skips are due once, together, at the first minute after the gap. New tests cover both changes in Berlin, New York and on Lord Howe Island (half-hour change), forward and backward, and a late tick in each.
