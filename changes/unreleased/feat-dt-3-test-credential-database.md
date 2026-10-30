---
section: Database
---

- Migrations 0190 and 0191 let `connection_bindings` hold a Connection's test credential: a nullable column `endpoint`, and a scheme constraint widened by the scheme `static` for the subject `test`. The constraint is added `NOT VALID` in 0190 and validated in 0191, so the table is not scanned under the lock. Every existing row and every write of the previous release still fits it. Rolling back needs no step: the previous release reads no binding of the scheme `static`, and a test credential stays unused until the release is upgraded again.
