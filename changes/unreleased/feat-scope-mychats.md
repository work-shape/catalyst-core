---
section: Added
---

- **Skills:** A skill of a person's Personal Workspace has the switch "Use in my chats" ("In meinen Chats verwenden") on its page (SCOPE-MYCHATS). Switched on, every agent the person chats with, the Workshaper included, is told of it and may read it, read-only, like its own skills; the page head shows "In my chats". The agents themselves stay as they are, and nothing is shared: only runs the person started themself in a chat get it. A run of another member of a shared conversation, a subagent, a Workflow step, and a run started or acting with a key, a service principal or an embedding host get none.
- **API:** `me.chat_skills.list` (`GET /api/v1/me/chat-skills`) lists the skills of the signed-in person's Personal Workspace with their switch; `me.chat_skills.set` (`PUT /api/v1/me/chat-skills/:name`) switches one. Only the person signed in themself reads and sets their own; another person's skill answers `404`, a key `403`. Each switch records the audit event `user.chat_skill_changed` with the skill's name and the value.
- **Database:** Migration 0167 adds the table `personal_chat_skills`: one row per switched-on skill, removed with the skill.
