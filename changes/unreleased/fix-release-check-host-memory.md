---
section: Fixed
---

- **Release gate and the host's memory:** the release gate's resolve-only run of the workspace
  command worker compared the memory its sandboxes need with the memory of the machine the
  gate runs on, so a CI runner smaller than the host stopped every deploy with
  `sandbox_memory_exceeds_host`. A resolve-only run no longer makes that check and prints
  `host memory not checked: checked at startup on the host`; the worker still refuses to start
  on a host that cannot hold its sandboxes. **Upgrade:** nothing to do. **Rollback:** the
  previous release's gate refuses such a config again on a smaller CI machine.
