---
section: Added
---

- **Speech to text (STT-1):** a microphone left of Send in the composer records up to five
  minutes, sends the recording on stop and adds its text at the end of what is in the field;
  nothing is sent to the agent by itself. It is off until the release config holds a model
  binding of `kind: transcription` on an `openai-compatible` provider entry with `region: eu`
  (for example Mistral's `https://api.mistral.ai/v1` with model `voxtral-mini-latest`). An
  instance has at most one; it takes no fallback, no agent may use it, and a chat fallback or
  chat use that names it is refused. `transcription.terms` (up to 100) lists words to bias the
  transcription towards; each request also sends the names of the shared workspace, the project,
  the agents and the Knowledge Bases and Data Stores the person may see. New endpoint
  `POST /api/v1/transcriptions` (multipart part `file`, optional query `language`,
  `conversationId`, `projectId`, `workspaceId`); `GET /api/v1/config` says
  `transcription.enabled`. The audio is held in memory for the request only and never stored or
  logged, the text is not stored, and the audit event `transcription.completed` records the
  binding and the seconds. Usage is recorded under the purpose `transcription` against the
  person's own budget, priced per audio minute from the rate card's new `transcription` rows
  (`{ providerId, model, pricePerAudioMinute }`), which a spend budget requires for the binding.
- **Database:** migration 0206 adds the nullable column `model_usage_events.audio_seconds`, set
  only on a transcription. It rewrites no row and gives up after a 5 s `lock_timeout`. A rollback
  needs no step: an older release does not read the column.
