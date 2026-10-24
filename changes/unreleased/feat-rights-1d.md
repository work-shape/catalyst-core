---
section: Changed
---

- **Access:** `connection.write`, `connection.delete` and `connection.approve` can be granted on one Connection or on the whole instance, as `connection.read` and `connection.use` already could. Instance > Access offers them. A grant on one Connection covers that Connection only; creating a Connection still needs write on the whole instance. The no-escalation check applies as for every other grant. Changing the host a Connection calls still clears its stored key, so a writer of one Connection cannot send the key elsewhere.
- **Connections:** Every check of these rights asks the Connection it is about. The connector types are readable by anyone who may write any Connection; the chat's Connection proposal asks write on the Connection it names when that Connection exists; Studio's Connection page offers its switches, exposure boxes and tool approval to a writer of that Connection; and Studio offers "New connection" to whoever holds `connection.write` on the instance rather than the general Studio permission.
- **Approvals:** `connection.approve` decides a held call on its Connection, one of its operations or a change or deletion of its definition, beside `operations.approve`. The Inbox lists those requests to its holders. The call still runs as the person who made it, so the approver gains no right on the Connection.
- **Chat:** A person who may change only the Connection an agent's proposal names can open that Connection's page from the proposal's card.
