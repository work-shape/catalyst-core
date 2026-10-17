---
section: Fixed
---

- A conversation's thread is read at one moment. A queued follow-up that started while a page read the thread could be in neither the queue nor the transcript of that read, so the page stopped following and a member's message never appeared until a reload.
- A queued follow-up whose start is refused stays queued, and the queue reads as paused, instead of being dropped. Only a follow-up whose author can no longer act in the conversation is withdrawn. Every refusal is logged at warn level with its code and the check that refused, without the message.
