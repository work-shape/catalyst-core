---
section: Changed
---

- **Rights:** Publisher in a workspace now deletes the skills that workspace owns
  (`skill.delete`), and nothing else of it. A delete keeps the skill's revisions, so a revert
  brings it back. Deleting a skill that an agent lists, in its live revision or its pending
  draft, is refused with `CONFLICT` (`skill_in_use`) and names those agents, for every deleter.
  Builder still deletes nothing. A CLI refusal for a key that does not cover a right its person
  holds, such as a key issued before its person became Publisher, says how to issue a new key
  (SKILL-DEL-1).
