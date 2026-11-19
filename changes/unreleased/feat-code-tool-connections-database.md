---
section: Database
---

- **Tools:** migration 0208 `tool_code_call_requests` adds the nullable `jsonb` columns `request`
  and `answer` to `tool_code_calls`: the request a running handler made of a Connection and its
  answer, carried between the command worker and the process that waits for the call, and cleared
  when the call ends. A rollback leaves the columns unused.
