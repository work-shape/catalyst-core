---
section: Added
---

- **Connections:** The Connection page has a section "Who may use it" ("Wer sie verwenden darf") for everyone who may read the Connection. It lists the roles with a right on it first, then each person, group and service principal with a right of their own, each with what they may do (view, use, edit, delete, approve). A reader who manages no users sees the built-in roles and a count of the rest; a service principal is named only to a reader who also sees service principals. It replaces "Additional use rights", which only user administrators saw and which named only `connection.use`.
- **API:** `connections.access` (`GET /api/v1/connections/:name/access`) answers who may use one Connection under the Connection's read right: `roles`, `holders` and `hidden`.
