import { describe, expect, it } from "vitest";
import type { ConversationThreadSnapshot, RunObservation } from "@work-shape/catalyst-api-client";
import { agentRunErrorSchema, runObservationSchema } from "@work-shape/catalyst-api-contract";
import {
  toUiMessages,
  applyRunObservationToControllerState,
  completeRunObservationStreamInControllerState,
  controllerStateForConversation,
  createControllerStateFromSnapshot,
  createInitialControllerState,
  resolveRunConnectionTarget,
  staleThreadReread,
  terminalRunNotice
} from "./support/chat-ui";
import { createTranslationContext } from "@work-shape/catalyst-chat-ui";

describe("chat UI conversation controller", () => {
  it("shows the preparing tool until the real tool call starts", () => {
    let state = createControllerStateFromSnapshot(createSnapshot({ lastSequence: 0, text: "" }));

    state = applyRunObservationToControllerState(
      state,
      createObservation({
        sequence: 1,
        type: "tool_call_preparing",
        payload: {
          toolCallId: "call_review",
          toolName: "submit_review"
        }
      })
    ).state;

    expect(state.activeRun?.projection.preparingTool).toEqual({
      toolCallId: "call_review",
      toolName: "submit_review"
    });
    state = applyRunObservationToControllerState(
      state,
      createObservation({
        sequence: 2,
        type: "tool_call_started",
        payload: {
          toolCallId: "call_review",
          toolName: "submit_review",
          input: { documentId: "doc_1" }
        }
      })
    ).state;

    expect(state.activeRun?.projection.preparingTool).toBeUndefined();
  });

  describe("the notice of an ended run, live and after a reload", () => {
    const en = createTranslationContext("en").t;
    const de = createTranslationContext("de").t;
    const interrupted = {
      en: "The reply was interrupted. Please send your message again.",
      de: "Die Antwort wurde unterbrochen. Bitte sende deine Nachricht erneut."
    };
    const stopped = { en: "The reply was stopped.", de: "Die Antwort wurde gestoppt." };
    /** What the worker stores when a run breaks (`agent-runtime/src/agent-run-worker.ts`). */
    const workerFailures = [
      { code: "INTERNAL", message: "Agent run failed", category: "internal_error" },
      {
        code: "OBSERVATION_PERSISTENCE_FAILED",
        message: "Agent run failed",
        category: "internal_error"
      },
      {
        code: "AGENT_RUN_EXECUTOR_ENDED",
        message: "Agent run executor ended without a terminal event",
        category: "internal_error"
      },
      {
        code: "AGENT_RUN_ABORTED",
        message: "Agent run execution was interrupted",
        category: "abort_error"
      }
    ] as const;

    function notices(state: ReturnType<typeof createInitialControllerState>) {
      return { en: terminalRunNotice(state.error, en), de: terminalRunNotice(state.error, de) };
    }

    it("reads a failure as interrupted in the person's language, never as stopped", () => {
      for (const error of workerFailures) {
        const live = applyRunObservationToControllerState(
          createControllerStateFromSnapshot(createSnapshot({ lastSequence: 1, text: "" })),
          createObservation({ sequence: 2, type: "run_failed", payload: { error } })
        ).state;
        expect(notices(live)).toEqual(interrupted);

        const reloaded = createControllerStateFromSnapshot(
          createSnapshot({ lastSequence: 2, text: "", runStatus: "failed", error })
        );
        expect(notices(reloaded)).toEqual(interrupted);
      }
    });

    it("words a reached usage limit by its code in the person's language, never the server's English", () => {
      // The refusal is an application error, whose message would otherwise reach the person.
      const error = {
        code: "MODEL_USAGE_LIMIT_REACHED",
        message: "Daily model token safeguard has been reached",
        category: "app_error"
      } as const;
      const live = applyRunObservationToControllerState(
        createControllerStateFromSnapshot(createSnapshot({ lastSequence: 1, text: "" })),
        createObservation({ sequence: 2, type: "run_failed", payload: { error } })
      ).state;
      const reloaded = createControllerStateFromSnapshot(
        createSnapshot({ lastSequence: 2, text: "", runStatus: "failed", error })
      );
      for (const state of [live, reloaded]) {
        const member = notices(state);
        expect(member.de).toContain("Eine Nutzungsgrenze hat diese Antwort gestoppt");
        expect(member.de).toContain("Bitte einen Administrator dieser Instanz");
        expect(member.en).toContain("A usage limit stopped this reply");
        // A limit can be the person's own: the notice names no scope and promises no reset.
        expect(member.en).not.toMatch(/limit of this instance|resets/u);
        expect(member.en).not.toContain("safeguard");
        const admin = terminalRunNotice(state.error, de, { seesRateCard: true });
        expect(admin).toContain("Einstellungen › Nutzung");
      }
    });

    describe("a reached usage limit that the run names", () => {
      const advice = {
        en: "Your answer so far is kept. Ask an administrator of this instance to check the usage limits.",
        de: "Was bisher geantwortet wurde, bleibt erhalten. Bitte einen Administrator dieser Instanz, die Nutzungsgrenzen zu prüfen."
      };
      const generic = {
        en: `A usage limit stopped this reply. ${advice.en}`,
        de: `Eine Nutzungsgrenze hat diese Antwort gestoppt. ${advice.de}`
      };
      const periods = {
        day: { en: ["daily", "at midnight UTC"], de: ["tägliche", "um Mitternacht UTC"] },
        month: {
          en: ["monthly", "at the start of next month (UTC)"],
          de: ["monatliche", "zu Beginn des nächsten Monats (UTC)"]
        }
      } as const;
      const metrics = {
        modelCallCount: { en: "model calls", de: "Modellaufrufe" },
        tokens: { en: "tokens", de: "Tokens" },
        costMicros: { en: "spending", de: "Ausgaben" }
      } as const;
      const scopes = {
        user: { en: "your own calls", de: "deine eigenen Aufrufe" },
        system: { en: "the calls the product makes", de: "die Aufrufe des Produkts" },
        instance: {
          en: "the calls of everyone on this instance",
          de: "die Aufrufe aller auf dieser Instanz"
        }
      } as const;
      const serverText = "Daily model token safeguard has been reached <b>raw</b>";

      /** The notices of a refusal as the API delivers it, live and after a reload. */
      function refusalNotices(usageLimit: unknown) {
        const raw = {
          code: "MODEL_USAGE_LIMIT_REACHED",
          message: serverText,
          category: "app_error",
          usageLimit
        };
        const observation = runObservationSchema.parse(
          createObservation({ sequence: 2, type: "run_failed", payload: { error: raw } })
        );
        const live = applyRunObservationToControllerState(
          createControllerStateFromSnapshot(createSnapshot({ lastSequence: 1, text: "" })),
          observation
        ).state;
        const reloaded = createControllerStateFromSnapshot(
          createSnapshot({
            lastSequence: 2,
            text: "",
            runStatus: "failed",
            error: agentRunErrorSchema.parse(raw)
          })
        );
        return [live, reloaded].map((state) => ({
          member: notices(state),
          operator: {
            en: terminalRunNotice(state.error, en, { seesRateCard: true }),
            de: terminalRunNotice(state.error, de, { seesRateCard: true })
          }
        }));
      }

      it("says which limit, whose calls and when it resets, for every limit in both languages", () => {
        for (const period of ["day", "month"] as const) {
          for (const metric of ["modelCallCount", "tokens", "costMicros"] as const) {
            for (const scope of ["user", "system", "instance"] as const) {
              const [p, m, s] = [periods[period], metrics[metric], scopes[scope]];
              const named = {
                en: `The ${p.en[0]} limit on ${m.en} stopped this reply. It counts ${s.en} and resets ${p.en[1]}.`,
                de: `Die ${p.de[0]} Grenze für ${m.de} hat diese Antwort gestoppt. Sie zählt ${s.de} und wird ${p.de[1]} zurückgesetzt.`
              };
              for (const { member, operator } of refusalNotices({ period, metric, scope })) {
                expect(member).toEqual({
                  en: `${named.en} ${advice.en}`,
                  de: `${named.de} ${advice.de}`
                });
                expect(operator.en).toBe(
                  `${named.en} Your answer so far is kept. Settings › Usage shows the usage limits and what has been used. Ask the instance operator to review the limits they set.`
                );
                expect(operator.de).toContain(`${named.de} Was bisher geantwortet wurde`);
                expect(operator.de).toContain("Einstellungen › Nutzung");
              }
            }
          }
        }
      });

      it("says only that a limit was reached when the details are missing, old or hostile", () => {
        const unreadable: unknown[] = [
          undefined,
          null,
          "day",
          42,
          [],
          ["day", "tokens", "user"],
          {},
          { period: "day", metric: "tokens" },
          { period: "week", metric: "tokens", scope: "user" },
          { period: "day", metric: "dollars", scope: "user" },
          { period: "day", metric: "tokens", scope: "everyone" },
          { period: "DAY", metric: "TOKENS", scope: "USER" },
          { period: "__proto__", metric: "constructor", scope: "toString" },
          { period: "day", metric: "tokens", scope: null },
          { period: ["day"], metric: "tokens", scope: "user" },
          { period: "day", metric: { toString: "tokens" }, scope: "user" },
          { period: "<script>alert(1)</script>", metric: "tokens", scope: "user" }
        ];
        for (const usageLimit of unreadable) {
          for (const { member } of refusalNotices(usageLimit)) expect(member).toEqual(generic);
        }
      });

      it("drops what the contract does not know and never shows the server's words", () => {
        const padded = {
          period: "month",
          metric: "costMicros",
          scope: "instance",
          used: 987654321,
          message: "Monthly spend budget of 50 EUR reached"
        };
        for (const { member, operator } of refusalNotices(padded)) {
          for (const notice of [member.en, member.de, operator.en, operator.de]) {
            expect(notice).not.toMatch(/987654321|EUR|safeguard|<b>|raw/u);
          }
          expect(member.en).toContain("The monthly limit on spending stopped this reply.");
        }
      });
    });

    it("reads a cancellation as stopped, live and after a reload", () => {
      const live = applyRunObservationToControllerState(
        createControllerStateFromSnapshot(createSnapshot({ lastSequence: 1, text: "" })),
        createObservation({
          sequence: 2,
          type: "run_cancelled",
          payload: { reason: "user_requested" }
        })
      ).state;
      expect(notices(live)).toEqual(stopped);

      const reloaded = createControllerStateFromSnapshot(
        createSnapshot({ lastSequence: 2, text: "", runStatus: "cancelled" })
      );
      expect(notices(reloaded)).toEqual(stopped);
    });
  });

  it("keeps the thread's pending follow-ups and applies each change to them in place", () => {
    const first = createFollowUp({ id: "fu_1", position: 1 });
    const second = createFollowUp({ id: "fu_2", position: 2 });
    const state = createControllerStateFromSnapshot({
      ...createSnapshot({ lastSequence: 2, text: "" }),
      followUps: [second, first]
    });
    expect(state.followUps.map((followUp) => followUp.id)).toEqual(["fu_1", "fu_2"]);

    const third = createFollowUp({ id: "fu_3", position: 3 });
    const queued = applyRunObservationToControllerState(
      state,
      createObservation({ sequence: 3, type: "follow_up_changed", payload: { followUp: third } })
    ).state;
    expect(queued.followUps.map((followUp) => followUp.id)).toEqual(["fu_1", "fu_2", "fu_3"]);

    const withdrawn = applyRunObservationToControllerState(
      queued,
      createObservation({
        sequence: 4,
        type: "follow_up_changed",
        payload: { followUp: { ...first, status: "cancelled" } }
      })
    ).state;
    expect(withdrawn.followUps.map((followUp) => followUp.id)).toEqual(["fu_2", "fu_3"]);
  });

  it("ignores duplicate or already-applied run observations", () => {
    const state = createControllerStateFromSnapshot(
      createSnapshot({ lastSequence: 2, text: "Hello" })
    );
    const duplicate = createObservation({
      sequence: 2,
      type: "message_delta",
      payload: {
        delta: " again"
      }
    });

    const result = applyRunObservationToControllerState(state, duplicate);

    expect(result).toMatchObject({
      applied: false,
      refreshRequired: false
    });
    expect(result.state).toBe(state);
  });

  it("requires a snapshot refresh before applying a sequence gap", () => {
    const state = createControllerStateFromSnapshot(
      createSnapshot({ lastSequence: 2, text: "Hello" })
    );
    const skipped = createObservation({
      sequence: 4,
      type: "message_delta",
      payload: {
        delta: " after a missing event"
      }
    });

    const result = applyRunObservationToControllerState(state, skipped);

    expect(result).toMatchObject({
      applied: false,
      refreshRequired: true,
      state: {
        connectionStatus: "reconnecting",
        error: {
          class: "stream_disconnected"
        }
      }
    });
    expect(result.state.activeRun?.projection.text).toBe("Hello");
  });

  it("reconciles completed assistant messages by canonical id", () => {
    const snapshot = createSnapshot({
      lastSequence: 2,
      text: "Draft",
      messages: [
        {
          id: "msg_assistant",
          conversationId: "conv_1",
          clientInstanceId: "client_1",
          role: "assistant",
          text: "Old final",
          createdAt: "2026-06-26T10:00:00.000Z",
          metadata: {
            agentRuntime: {
              version: 1,
              kind: "assistant_final",
              runId: "run_1"
            }
          }
        }
      ]
    });
    const state = createControllerStateFromSnapshot(snapshot);
    const completed = createObservation({
      sequence: 3,
      type: "message_completed",
      payload: {
        message: {
          id: "msg_assistant",
          role: "assistant",
          text: "Canonical final",
          metadata: {
            agentRuntime: {
              version: 1,
              kind: "assistant_final",
              runId: "run_1"
            }
          }
        }
      }
    });

    const result = applyRunObservationToControllerState(state, completed);

    expect(result.applied).toBe(true);
    expect(result.state.messages.filter((message) => message.id === "msg_assistant")).toHaveLength(
      1
    );
    expect(result.state.messages).toContainEqual(
      expect.objectContaining({
        id: "msg_assistant",
        text: "Canonical final"
      })
    );
    expect(result.state.activeRun?.projection.text).toBe("Canonical final");
    expect(result.state.activeRun?.lastAppliedSequence).toBe(3);
  });

  it("adds missing completion text without overwriting observed chronology", () => {
    let state = createControllerStateFromSnapshot(createSnapshot({ lastSequence: 0, text: "" }));
    for (const observation of [
      createObservation({
        sequence: 1,
        type: "message_delta",
        payload: {
          delta: "Ich prüfe kurz die aktuellen offiziellen Regeln."
        }
      }),
      createObservation({
        sequence: 2,
        type: "tool_call_started",
        payload: {
          toolCallId: "tool_web",
          toolName: "web_search",
          input: { query: "Pfand Annahmepflicht" }
        }
      }),
      createObservation({
        sequence: 3,
        type: "tool_call_completed",
        payload: {
          toolCallId: "tool_web",
          toolName: "web_search",
          result: {
            status: "success",
            output: { ok: true }
          },
          modelOutput: '{"ok":true}'
        }
      }),
      createObservation({
        sequence: 4,
        type: "message_completed",
        payload: {
          message: {
            id: "msg_assistant",
            role: "assistant",
            text: "Ich prüfe kurz die aktuellen offiziellen Regeln.Kurz: Nein.",
            metadata: {
              agentRuntime: {
                version: 1,
                kind: "assistant_final",
                runId: "run_1"
              }
            }
          }
        }
      })
    ]) {
      state = applyRunObservationToControllerState(state, observation).state;
    }

    expect(state.activeRun?.projection.text).toBe(
      "Ich prüfe kurz die aktuellen offiziellen Regeln.Kurz: Nein."
    );
    expect(state.activeRun?.projection.parts).toEqual([
      {
        type: "text",
        text: "Ich prüfe kurz die aktuellen offiziellen Regeln."
      },
      expect.objectContaining({
        type: "tool_call",
        toolCallId: "tool_web",
        state: "output_available"
      }),
      {
        type: "text",
        text: "Kurz: Nein."
      }
    ]);
  });

  it("does not duplicate a final completed message after earlier run text", () => {
    let state = createControllerStateFromSnapshot(createSnapshot({ lastSequence: 0, text: "" }));
    for (const observation of [
      createObservation({
        sequence: 1,
        type: "message_delta",
        payload: {
          delta: "I will create the files now."
        }
      }),
      createObservation({
        sequence: 2,
        type: "tool_call_started",
        payload: {
          toolCallId: "tool_workspace",
          toolName: "workspace.exec",
          input: { command: "split-pdf" }
        }
      }),
      createObservation({
        sequence: 3,
        type: "tool_call_completed",
        payload: {
          toolCallId: "tool_workspace",
          toolName: "workspace.exec",
          result: {
            status: "success",
            output: { ok: true }
          },
          modelOutput: '{"ok":true}'
        }
      }),
      createObservation({
        sequence: 4,
        type: "message_delta",
        payload: {
          delta: "Done. I split the PDF into 3 files."
        }
      }),
      createObservation({
        sequence: 5,
        type: "message_completed",
        payload: {
          message: {
            id: "msg_assistant",
            role: "assistant",
            text: "Done. I split the PDF into 3 files.",
            metadata: {
              agentRuntime: {
                version: 1,
                kind: "assistant_final",
                runId: "run_1"
              }
            }
          }
        }
      })
    ]) {
      state = applyRunObservationToControllerState(state, observation).state;
    }

    expect(state.activeRun?.projection.text).toBe("Done. I split the PDF into 3 files.");
    expect(state.activeRun?.projection.parts).toEqual([
      {
        type: "text",
        text: "I will create the files now."
      },
      expect.objectContaining({
        type: "tool_call",
        toolCallId: "tool_workspace",
        state: "output_available"
      }),
      {
        type: "text",
        text: "Done. I split the PDF into 3 files."
      }
    ]);
  });

  it("preserves live text and tool call chronology for active-run rendering", () => {
    let state = createControllerStateFromSnapshot(createSnapshot({ lastSequence: 0, text: "" }));
    for (const observation of [
      createObservation({
        sequence: 1,
        type: "message_delta",
        payload: {
          delta: "First step."
        }
      }),
      createObservation({
        sequence: 2,
        type: "tool_call_started",
        payload: {
          toolCallId: "tool_1",
          toolName: "demo.lookup",
          input: { query: "first" }
        }
      }),
      createObservation({
        sequence: 3,
        type: "tool_call_completed",
        payload: {
          toolCallId: "tool_1",
          toolName: "demo.lookup",
          result: {
            status: "success",
            output: { ok: true }
          },
          modelOutput: '{"ok":true}'
        }
      }),
      createObservation({
        sequence: 4,
        type: "message_delta",
        payload: {
          delta: "Second step."
        }
      })
    ]) {
      state = applyRunObservationToControllerState(state, observation).state;
    }

    expect(state.activeRun?.projection.parts).toEqual([
      {
        type: "text",
        text: "First step."
      },
      expect.objectContaining({
        type: "tool_call",
        toolCallId: "tool_1",
        state: "output_available"
      }),
      {
        type: "text",
        text: "Second step."
      }
    ]);

    const [message] = toUiMessages([], state.activeRun);
    expect(message?.metadata).toEqual({ custom: { source: "active-run" } });
    expect(message?.parts.map((part) => part.type)).toEqual(["text", "dynamic-tool", "text"]);
  });

  it("renders active-run text when projection parts only contain tools", () => {
    const snapshot = createSnapshot({ lastSequence: 2, text: "I am checking the uploaded files." });
    if (!snapshot.activeRun) {
      throw new Error("Expected active run in test snapshot");
    }
    snapshot.activeRun.projection.parts = [
      {
        type: "tool_call",
        toolCallId: "tool_1",
        toolName: "demo.lookup",
        input: { query: "files" },
        state: "input_available"
      }
    ];
    const state = createControllerStateFromSnapshot(snapshot);

    const [message] = toUiMessages([], state.activeRun);

    expect(message?.metadata).toEqual({ custom: { source: "active-run" } });
    expect(message?.parts.map((part) => part.type)).toEqual(["dynamic-tool", "text"]);
    expect(message?.parts.at(-1)).toMatchObject({
      type: "text",
      text: "I am checking the uploaded files."
    });
  });

  it("keeps a newer local active-run projection when a stale same-run snapshot arrives", () => {
    const staleSnapshot = createSnapshot({ lastSequence: 0, text: "" });
    const live = applyRunObservationToControllerState(
      createControllerStateFromSnapshot(staleSnapshot),
      createObservation({
        sequence: 1,
        type: "message_delta",
        payload: {
          delta: "Live text"
        }
      })
    ).state;

    const refreshed = createControllerStateFromSnapshot(staleSnapshot, live);

    expect(refreshed.activeRun?.lastAppliedSequence).toBe(1);
    expect(refreshed.activeRun?.projection.text).toBe("Live text");
    expect(refreshed.activeRun?.projection.parts).toEqual([
      {
        type: "text",
        text: "Live text"
      }
    ]);
  });

  it("keeps failed terminal run state visible across snapshot refresh", () => {
    const state = applyRunObservationToControllerState(
      createControllerStateFromSnapshot(
        createSnapshot({ lastSequence: 1, text: "Partial answer" })
      ),
      createObservation({
        sequence: 2,
        type: "tool_call_started",
        payload: {
          toolCallId: "tool_stuck",
          toolName: "demo.lookup",
          input: { query: "stuck" }
        }
      })
    ).state;
    const failed = applyRunObservationToControllerState(
      state,
      createObservation({
        sequence: 3,
        type: "run_failed",
        payload: {
          error: {
            category: "internal_error",
            code: "MODEL_FAILED",
            message: "Model provider failed"
          }
        }
      })
    ).state;

    const refreshed = createControllerStateFromSnapshot(
      createSnapshot({ lastSequence: 3, text: "", activeRun: false }),
      failed
    );

    expect(refreshed.activeRun?.run.status).toBe("failed");
    expect(refreshed.activeRun?.projection.text).toBe("Partial answer");
    expect(refreshed.error).toMatchObject({
      class: "run_failed",
      message: "Model provider failed"
    });

    const [message] = toUiMessages([], refreshed.activeRun);
    expect(message?.parts).toContainEqual(
      expect.objectContaining({
        type: "dynamic-tool",
        toolCallId: "tool_stuck",
        state: "output-error",
        errorText: "Model provider failed"
      })
    );
  });

  it("keeps cancelled terminal run state visible across snapshot refresh", () => {
    const state = createControllerStateFromSnapshot(
      createSnapshot({ lastSequence: 2, text: "Partial answer" })
    );
    const cancelled = applyRunObservationToControllerState(
      state,
      createObservation({
        sequence: 3,
        type: "run_cancelled",
        payload: {
          reason: "user_requested"
        }
      })
    ).state;

    const refreshed = createControllerStateFromSnapshot(
      createSnapshot({ lastSequence: 3, text: "", activeRun: false }),
      cancelled
    );

    expect(refreshed.activeRun?.run.status).toBe("cancelled");
    expect(refreshed.activeRun?.projection.text).toBe("Partial answer");
    expect(refreshed.error).toMatchObject({
      class: "run_cancelled",
      message: "user_requested"
    });
  });

  it("renders recovered terminal run snapshots without opening a live connection state", () => {
    const recovered = createControllerStateFromSnapshot(
      createSnapshot({
        lastSequence: 2,
        text: "Partial answer",
        runStatus: "failed",
        error: {
          code: "AGENT_RUN_RUNTIME_INTERRUPTED",
          message: "Agent run was interrupted after the local runtime state was lost",
          category: "runtime_interrupted"
        }
      })
    );

    expect(recovered.connectionStatus).toBe("caught_up");
    expect(recovered.activeRun?.run.status).toBe("failed");
    expect(recovered.activeRun?.projection.error).toMatchObject({
      code: "AGENT_RUN_RUNTIME_INTERRUPTED",
      category: "runtime_interrupted"
    });
    expect(recovered.error).toMatchObject({
      class: "run_failed",
      message: "Agent run was interrupted after the local runtime state was lost",
      category: "runtime_interrupted"
    });
  });

  it("treats caught-up no-observation streams as caught up rather than disconnected", () => {
    const state = createControllerStateFromSnapshot(
      createSnapshot({ lastSequence: 3, text: "Final" })
    );
    const reconnected = completeRunObservationStreamInControllerState(
      {
        ...state,
        connectionStatus: "reconnecting",
        error: {
          class: "stream_disconnected",
          message: "Previous stream disconnected"
        }
      },
      {
        sawObservation: false,
        streamCaughtUp: true
      }
    );

    expect(reconnected.connectionStatus).toBe("caught_up");
    expect(reconnected.error).toBeUndefined();
    expect(reconnected.activeRun?.lastAppliedSequence).toBe(3);
  });

  it("keeps real no-observation stream closures user-visible as disconnected", () => {
    const state = createControllerStateFromSnapshot(
      createSnapshot({ lastSequence: 3, text: "Waiting" })
    );
    const disconnected = completeRunObservationStreamInControllerState(state, {
      sawObservation: false,
      streamCaughtUp: false
    });

    expect(disconnected.connectionStatus).toBe("disconnected");
    expect(disconnected.error).toMatchObject({
      class: "stream_disconnected",
      message: "Run observation stream disconnected"
    });
  });

  it("uses refreshed snapshots to resolve stale active run state after caught-up streams", () => {
    const stale = createControllerStateFromSnapshot(
      createSnapshot({ lastSequence: 3, text: "Final" })
    );
    const caughtUp = completeRunObservationStreamInControllerState(stale, {
      sawObservation: false,
      streamCaughtUp: true
    });
    const refreshed = createControllerStateFromSnapshot(
      createSnapshot({ lastSequence: 3, text: "", activeRun: false }),
      caughtUp
    );

    expect(refreshed.connectionStatus).toBe("idle");
    expect(refreshed.activeRun).toBeUndefined();
    expect(refreshed.error).toBeUndefined();
  });

  it("reads a thread again, a bounded few times, while it reports as live a run the page saw end", () => {
    const running = createSnapshot({ lastSequence: 1, text: "Answer" });
    const live = createControllerStateFromSnapshot(running);
    const ended = applyRunObservationToControllerState(
      live,
      createObservation({ sequence: 2, type: "run_completed", payload: {} })
    ).state;
    // A run that is still going, or no thread at all, asks for nothing.
    expect(staleThreadReread({ snapshot: running, state: live, attempts: 0 })).toBeUndefined();
    expect(staleThreadReread({ snapshot: undefined, state: ended, attempts: 0 })).toBeUndefined();

    // The thread was read before the store had recorded the end of the run: without the last
    // observation, or with it but with the run still live.
    for (const behind of [running, createSnapshot({ lastSequence: 2, text: "Answer" })]) {
      const state = createControllerStateFromSnapshot(behind, ended);
      // The page keeps the end it saw, and no stream opens for the run again.
      expect(state.activeRun?.run.status).toBe("completed");
      expect(
        resolveRunConnectionTarget({
          conversationId: "conv_1",
          enabled: true,
          snapshot: behind,
          state
        })
      ).toBeUndefined();

      // It reads the thread again, each time after a longer wait, and then stops.
      const waits: number[] = [];
      for (let attempts = 0; attempts < 20; attempts += 1) {
        const reread = staleThreadReread({ snapshot: behind, state, attempts });
        if (!reread) break;
        expect(reread.runId).toBe("run_1");
        waits.push(reread.delayMs);
      }
      expect(waits.length).toBeGreaterThan(0);
      expect(waits.length).toBeLessThan(20);
      expect(waits).toEqual([...waits].sort((left, right) => left - right));
      expect(waits.every((wait) => wait > 0)).toBe(true);

      // A thread that has the end of the run, with or without the run on it, ends the re-reads.
      for (const caughtUp of [
        createSnapshot({ lastSequence: 2, text: "Answer", runStatus: "completed" }),
        createSnapshot({ lastSequence: 2, text: "Answer", activeRun: false })
      ]) {
        const next = createControllerStateFromSnapshot(caughtUp, state);
        expect(staleThreadReread({ snapshot: caughtUp, state: next, attempts: 0 })).toBeUndefined();
      }
    }
  });

  it("shows nothing of the conversation left behind while the selected one loads", () => {
    const left = createControllerStateFromSnapshot(
      createSnapshot({
        lastSequence: 28,
        text: "partial answer",
        messages: [
          {
            id: "msg_user",
            clientInstanceId: "client_1",
            conversationId: "conv_1",
            role: "user",
            text: "first message",
            createdAt: "2026-06-26T10:00:00.000Z"
          }
        ]
      })
    );

    expect(controllerStateForConversation(left, "conv_1")).toBe(left);

    const selected = controllerStateForConversation(left, "conv_2");
    expect(selected).toEqual({
      snapshotStatus: "loading",
      connectionStatus: "idle",
      messages: [],
      followUps: []
    });
    expect(toUiMessages(selected.messages, selected.activeRun)).toEqual([]);
    // A first conversation, before its thread answers once, is loading as well.
    const first = controllerStateForConversation(createInitialControllerState(), "conv_2", true);
    expect(first.snapshotStatus).toBe("loading");
  });

  it("opens a run connection only for the selected conversation's own run", () => {
    const snapshot = createSnapshot({ lastSequence: 28, text: "partial answer" });
    const state = createControllerStateFromSnapshot(snapshot);

    expect(
      resolveRunConnectionTarget({ conversationId: "conv_1", enabled: true, snapshot, state })
    ).toEqual({ conversationId: "conv_1", runId: "run_1", afterSequence: 28 });

    // The thread of the conversation switched to has not arrived: the state is still the other's.
    expect(
      resolveRunConnectionTarget({
        conversationId: "conv_2",
        enabled: true,
        snapshot: undefined,
        state
      })
    ).toBeUndefined();
    expect(
      resolveRunConnectionTarget({
        conversationId: "conv_2",
        enabled: true,
        snapshot,
        state: controllerStateForConversation(state, "conv_2")
      })
    ).toBeUndefined();
    expect(
      resolveRunConnectionTarget({ conversationId: "conv_1", enabled: false, snapshot, state })
    ).toBeUndefined();
  });
});

function createSnapshot({
  lastSequence,
  text,
  messages = [],
  activeRun = true,
  runStatus = "running",
  error
}: {
  lastSequence: number;
  text: string;
  messages?: ConversationThreadSnapshot["messages"];
  activeRun?: boolean;
  runStatus?: NonNullable<ConversationThreadSnapshot["activeRun"]>["run"]["status"];
  error?: NonNullable<ConversationThreadSnapshot["activeRun"]>["projection"]["error"];
}): ConversationThreadSnapshot {
  return {
    conversation: {
      id: "conv_1",
      clientInstanceId: "client_1",
      collaborationWorkspaceId: "cw_test",
      visibility: "workspace",
      createdByUserId: "user_1",
      createdByExternalUserId: "external_1",
      title: "Test",
      status: "active",
      createdAt: "2026-06-26T10:00:00.000Z",
      updatedAt: "2026-06-26T10:00:00.000Z",
      retainedUntil: "2026-07-26T10:00:00.000Z"
    },
    messages,
    ...(activeRun
      ? {
          activeRun: {
            run: {
              id: "run_1",
              conversationId: "conv_1",
              agentName: "test_agent",
              status: runStatus,
              startedAt: "2026-06-26T10:00:00.000Z",
              updatedAt: "2026-06-26T10:00:00.000Z",
              lastSequence
            },
            projection: {
              runId: "run_1",
              lastSequence,
              status: runStatus,
              parts:
                text.length > 0
                  ? [
                      {
                        type: "text",
                        text
                      }
                    ]
                  : [],
              text,
              reasoning: [],
              activeToolCalls: [],
              ...(error ? { error } : {})
            }
          }
        }
      : {}),
    userState: {
      clientInstanceId: "client_1",
      conversationId: "conv_1",
      userId: "user_1",
      updatedAt: "2026-06-26T10:00:00.000Z"
    },
    serverTime: "2026-06-26T10:00:00.000Z"
  };
}

function createFollowUp({
  id,
  position
}: {
  id: string;
  position: number;
}): NonNullable<ConversationThreadSnapshot["followUps"]>[number] {
  return {
    id,
    clientInstanceId: "client_1",
    conversationId: "conv_1",
    authorUserId: "user_1",
    text: `Queued ${id}`,
    mode: "queue",
    status: "pending",
    position,
    agentName: "test_agent",
    createdAt: "2026-06-26T10:00:00.000Z",
    updatedAt: "2026-06-26T10:00:00.000Z"
  };
}

function createObservation<TType extends RunObservation["payload"]["type"]>({
  sequence,
  type,
  payload
}: {
  sequence: number;
  type: TType;
  payload: Record<string, unknown>;
}): RunObservation {
  const createdAt = `2026-06-26T10:00:0${sequence}.000Z`;
  return {
    clientInstanceId: "client_1",
    conversationId: "conv_1",
    ownerUserId: "user_1",
    runId: "run_1",
    sequence,
    type,
    payload: {
      ...payload,
      type,
      runId: "run_1",
      sequence,
      createdAt
    } as RunObservation["payload"],
    createdAt
  };
}
