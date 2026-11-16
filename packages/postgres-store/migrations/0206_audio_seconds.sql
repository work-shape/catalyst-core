-- The seconds of audio of a transcription (STT-1). Null on every other model call.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "model_usage_events" ADD COLUMN "audio_seconds" integer;
