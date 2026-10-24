---
section: Fixed
---

- **Operations:** `operations.get_run` answers the run of a held call to the person it waits on, as long as it waits: whoever decides its pending request (its addressee, or who holds its deciding right, such as `connection.approve` on its Connection) reads that one run without `audit.view`. Once the request is decided, or for any other run, it is governance evidence again: its caller and holders of `audit.view` read it, and the list still takes `system.view`. A deny on the deciding right takes the read away, and a personal key still follows only its owner's calls.
