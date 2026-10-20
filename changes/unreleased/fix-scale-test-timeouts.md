---
section: Fixed
---

- **Tests:** The Workflow scale tests that ran past their time limit in the full suite on a loaded machine, while each passed alone, get a limit sized to their work: 20 minutes instead of 5 for the 1,000-item loop and the 600 child runs, and 2 minutes instead of 30 s for the continue-as-new tests that run a chain of histories to its end. What they assert is unchanged.
