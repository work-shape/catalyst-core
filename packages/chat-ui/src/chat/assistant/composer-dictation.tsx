import { useComposerRuntime } from "@assistant-ui/react";
import { AlertCircle, Mic, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { Button } from "@work-shape/catalyst-ui";
import { useOptionalWorkspaceApiClient } from "../../shared/api/workspace-api-client";
import { useTranslation, type TranslationKey } from "../../shared/i18n";
import { useOptionalWorkspaceRouteState } from "../workspace/workspace-ui-state";

/** A recording stops by itself after five minutes (STT-1). */
const DICTATION_MAX_SECONDS = 300;

/** What the browser is asked to record in, best first: WebM/Opus, then Safari's MP4/AAC. */
const RECORDING_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"];

/** Where the composer is, for the words the server sends with the recording. */
export interface DictationPlace {
  conversationId?: string;
}

type DictationState = "idle" | "starting" | "recording" | "transcribing";

export interface ComposerDictation {
  state: DictationState;
  elapsedSeconds: number;
  notice: TranslationKey | undefined;
  start(): void;
  stop(): void;
  dismissNotice(): void;
}

/** Whether this browser can record: `getUserMedia` and `MediaRecorder` are there. */
export function browserRecords(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    typeof MediaRecorder !== "undefined"
  );
}

/**
 * Speech to text in the composer (STT-1): records from the microphone, sends the recording on
 * stop, and adds its text at the end of what is in the field, which then gets focus. Nothing
 * is sent by itself. A refused microphone, a failed upload or an empty result leaves a notice
 * and keeps whatever was typed.
 */
export function useComposerDictation(
  place: DictationPlace,
  inputRef: RefObject<HTMLTextAreaElement | null>
): ComposerDictation {
  const api = useOptionalWorkspaceApiClient();
  const route = useOptionalWorkspaceRouteState()?.route;
  const workspaceId =
    route && "collaborationWorkspaceId" in route ? route.collaborationWorkspaceId : undefined;
  const composer = useComposerRuntime();
  const [state, setState] = useState<DictationState>("idle");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [notice, setNotice] = useState<TranslationKey | undefined>(undefined);
  const recording = useRef<
    { recorder: MediaRecorder; stream: MediaStream; timer: number } | undefined
  >(undefined);
  const mounted = useRef(true);
  const placeRef = useRef({ ...place, workspaceId });
  placeRef.current = { ...place, workspaceId };

  const release = useCallback(() => {
    const current = recording.current;
    recording.current = undefined;
    if (!current) return;
    window.clearInterval(current.timer);
    for (const track of current.stream.getTracks()) track.stop();
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const current = recording.current;
      if (current && current.recorder.state !== "inactive") {
        // Unmounted while recording: the recording is dropped, nothing is sent.
        current.recorder.ondataavailable = null;
        current.recorder.onstop = null;
        current.recorder.stop();
      }
      release();
    };
  }, [release]);

  const transcribe = useCallback(
    async (blob: Blob) => {
      if (!api) return;
      const type = blob.type || "audio/webm";
      const extension = type.startsWith("audio/mp4")
        ? "mp4"
        : type.includes("ogg")
          ? "ogg"
          : "webm";
      const { conversationId, workspaceId: inWorkspace } = placeRef.current;
      try {
        const result = await api.client.transcriptions.create({
          query: {
            ...(conversationId ? { conversationId } : {}),
            ...(!conversationId && inWorkspace ? { workspaceId: inWorkspace } : {})
          },
          file: new File([blob], `recording.${extension}`, { type })
        });
        if (!mounted.current) return;
        const text = result.text.trim();
        if (text === "") {
          setNotice("dictation.empty");
          return;
        }
        // Added at the end of what is there now, typed while it was transcribed included.
        const before = composer.getState().text;
        composer.setText(before.trim() === "" ? text : `${before.replace(/\s+$/u, "")} ${text}`);
        window.requestAnimationFrame(() => {
          const input = inputRef.current;
          if (!input) return;
          input.focus({ preventScroll: true });
          input.setSelectionRange(input.value.length, input.value.length);
        });
      } catch {
        if (mounted.current) setNotice("dictation.failed");
      } finally {
        if (mounted.current) setState("idle");
      }
    },
    [api, composer, inputRef]
  );

  const stop = useCallback(() => {
    const current = recording.current;
    if (!current || current.recorder.state === "inactive") return;
    setState("transcribing");
    current.recorder.stop();
  }, []);

  const start = useCallback(() => {
    if (state !== "idle" || !browserRecords()) return;
    setNotice(undefined);
    setState("starting");
    const begin = async () => {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        if (mounted.current) {
          setNotice("dictation.micRefused");
          setState("idle");
        }
        return;
      }
      if (!mounted.current) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      const mimeType = RECORDING_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.onstop = () => {
        release();
        const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || "audio/webm" });
        if (blob.size === 0) {
          setNotice("dictation.empty");
          setState("idle");
          return;
        }
        transcribe(blob).catch(() => undefined);
      };
      const startedAt = Date.now();
      const timer = window.setInterval(() => {
        const seconds = Math.floor((Date.now() - startedAt) / 1000);
        setElapsedSeconds(seconds);
        if (seconds >= DICTATION_MAX_SECONDS) stop();
      }, 250);
      recording.current = { recorder, stream, timer };
      setElapsedSeconds(0);
      recorder.start();
      setState("recording");
    };
    begin().catch(() => {
      // The browser refused to record, such as for a format it named and cannot write.
      release();
      if (mounted.current) {
        setNotice("dictation.failed");
        setState("idle");
      }
    });
  }, [release, state, stop, transcribe]);

  return {
    state,
    elapsedSeconds,
    notice,
    start,
    stop,
    dismissNotice: useCallback(() => setNotice(undefined), [])
  };
}

/** The microphone left of Send: record, then stop with the running time, then busy. */
export function DictationButton({
  dictation,
  disabled
}: {
  dictation: ComposerDictation;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  if (dictation.state === "recording") {
    return (
      <Button
        type="button"
        variant="secondary"
        className="h-9 shrink-0 gap-1.5 rounded-full px-3 tabular-nums"
        aria-label={t("dictation.stop")}
        title={t("dictation.stop")}
        onClick={dictation.stop}
        data-testid="dictation-stop"
      >
        <Square size={12} className="fill-current" aria-hidden="true" />
        <span>{formatElapsed(dictation.elapsedSeconds)}</span>
      </Button>
    );
  }
  const busy = dictation.state === "transcribing" || dictation.state === "starting";
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-9 shrink-0 rounded-full text-muted-foreground"
      aria-label={t(
        dictation.state === "transcribing" ? "dictation.transcribing" : "dictation.start"
      )}
      title={t(dictation.state === "transcribing" ? "dictation.transcribing" : "dictation.start")}
      loading={busy}
      disabled={disabled}
      onClick={dictation.start}
      data-testid="dictation-start"
    >
      <Mic size={16} aria-hidden="true" />
    </Button>
  );
}

/** The short notice in the composer when dictation did not give text. */
export function DictationNotice({ dictation }: { dictation: ComposerDictation }) {
  const { t } = useTranslation();
  if (!dictation.notice) return null;
  return (
    <p
      role="status"
      className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground"
      data-testid="dictation-notice"
    >
      <AlertCircle size={12} className="shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">{t(dictation.notice)}</span>
      <Button variant="link" size="sm" onClick={dictation.dismissNotice}>
        {t("dictation.dismiss")}
      </Button>
    </p>
  );
}

function formatElapsed(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}
