---
section: Fixed
---

- **Page head:** A detail head that is drawn again while the browser reports sizes, such as a Workflow's head after its draft is discarded, no longer causes a "ResizeObserver loop" error. The head keeps one observer for its life and observes each element once.
