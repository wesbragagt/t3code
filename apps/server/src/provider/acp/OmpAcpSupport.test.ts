import * as Effect from "effect/Effect";
import type * as EffectAcpSchema from "effect-acp/schema";
import { describe, expect, it } from "@effect/vitest";

import {
  applyOmpAcpModelSelection,
  extractOmpElicitationQuestions,
  isOmpElicitationFormRequest,
  makeOmpElicitationAcceptResponse,
  makeOmpElicitationCancelledResponse,
  makeOmpElicitationDeclineResponse,
  ompModelsFromConfigOptions,
  selectOmpPermissionOptionId,
  type OmpAcpModelSelectionRuntime,
  type OmpElicitationFormRequest,
} from "./OmpAcpSupport.ts";

describe("ompModelsFromConfigOptions", () => {
  it("reads the flat `model` select option", () => {
    const configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> = [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "openai/gpt-5.2",
        options: [
          { value: "openai/gpt-5.2", name: "GPT-5.2" },
          { value: "anthropic/claude-opus", name: "Claude Opus" },
        ],
      },
    ];
    expect(ompModelsFromConfigOptions(configOptions)).toEqual([
      { id: "openai/gpt-5.2", displayName: "GPT-5.2" },
      { id: "anthropic/claude-opus", displayName: "Claude Opus" },
    ]);
  });

  it("flattens a grouped `model` select option", () => {
    const configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> = [
      {
        id: "model",
        name: "Model",
        type: "select",
        currentValue: "openai/gpt-5.2",
        options: [
          {
            group: "OpenAI",
            name: "OpenAI",
            options: [{ value: "openai/gpt-5.2", name: "GPT-5.2" }],
          },
        ],
      },
    ];
    expect(ompModelsFromConfigOptions(configOptions)).toEqual([
      { id: "openai/gpt-5.2", displayName: "GPT-5.2" },
    ]);
  });

  it("returns no models when the agent has not advertised a `model` option", () => {
    expect(ompModelsFromConfigOptions([])).toEqual([]);
    expect(ompModelsFromConfigOptions(undefined)).toEqual([]);
  });
});

function makeFakeRuntime(input: {
  readonly configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>;
}) {
  const setModelCalls: Array<string> = [];
  const setConfigOptionCalls: Array<{ configId: string; value: string | boolean }> = [];
  const runtime: OmpAcpModelSelectionRuntime = {
    getConfigOptions: Effect.succeed(input.configOptions),
    setModel: (model) =>
      Effect.sync(() => {
        setModelCalls.push(model);
      }),
    setConfigOption: (configId, value) =>
      Effect.sync(() => {
        setConfigOptionCalls.push({ configId, value });
      }),
  };
  return { runtime, setModelCalls, setConfigOptionCalls };
}

describe("applyOmpAcpModelSelection", () => {
  it.effect("applies a thinking level that matches a negotiated option", () =>
    Effect.gen(function* () {
      const { runtime, setConfigOptionCalls } = makeFakeRuntime({
        configOptions: [
          {
            id: "thinking",
            name: "Thinking",
            type: "select",
            currentValue: "off",
            options: [
              { value: "off", name: "Off" },
              { value: "high", name: "High" },
            ],
          },
        ],
      });
      yield* applyOmpAcpModelSelection({
        runtime,
        model: null,
        thinking: "high",
        mapError: (context) => context,
      });
      expect(setConfigOptionCalls).toEqual([{ configId: "thinking", value: "high" }]);
    }),
  );

  it.effect("ignores a thinking level the agent did not negotiate", () =>
    Effect.gen(function* () {
      const { runtime, setConfigOptionCalls } = makeFakeRuntime({
        configOptions: [
          {
            id: "thinking",
            name: "Thinking",
            type: "select",
            currentValue: "off",
            options: [{ value: "off", name: "Off" }],
          },
        ],
      });
      yield* applyOmpAcpModelSelection({
        runtime,
        model: null,
        thinking: "nonexistent-level",
        mapError: (context) => context,
      });
      expect(setConfigOptionCalls).toEqual([]);
    }),
  );
});

const formRequest = (
  properties: NonNullable<OmpElicitationFormRequest["requestedSchema"]["properties"]>,
): OmpElicitationFormRequest => ({
  mode: "form",
  sessionId: "session-1",
  message: "Pick an option",
  requestedSchema: { type: "object", title: "oh-my-pi", properties },
});

describe("isOmpElicitationFormRequest", () => {
  it("accepts form-mode requests and rejects url-mode requests", () => {
    expect(isOmpElicitationFormRequest(formRequest({}))).toBe(true);
    expect(
      isOmpElicitationFormRequest({
        mode: "url",
        sessionId: "session-1",
        message: "Sign in",
        elicitationId: "elicitation-1",
        url: "https://example.com",
      }),
    ).toBe(false);
  });
});

describe("extractOmpElicitationQuestions", () => {
  it("turns an enum string property into a single-select question", () => {
    const questions = extractOmpElicitationQuestions(
      formRequest({ choice: { type: "string", enum: ["a", "b"], title: "Pick one" } }),
    );
    expect(questions).toEqual([
      {
        id: "choice",
        header: "oh-my-pi",
        question: "Pick one",
        options: [
          { label: "a", description: "a", value: "a" },
          { label: "b", description: "b", value: "b" },
        ],
        allowCustomAnswer: false,
        multiSelect: false,
      },
    ]);
  });

  it("turns a free-text string property into an open question", () => {
    const questions = extractOmpElicitationQuestions(
      formRequest({ note: { type: "string", description: "Anything else?" } }),
    );
    expect(questions[0]?.allowCustomAnswer).toBe(true);
    expect(questions[0]?.options).toEqual([]);
  });

  it("turns a boolean property into a yes/no question", () => {
    const questions = extractOmpElicitationQuestions(
      formRequest({ confirm: { type: "boolean", description: "Proceed?" } }),
    );
    expect(questions[0]?.options.map((option) => option.value)).toEqual(["true", "false"]);
    expect(questions[0]?.allowCustomAnswer).toBe(false);
  });

  it("falls back to a single free-text question when the schema has no properties", () => {
    const questions = extractOmpElicitationQuestions(formRequest({}));
    expect(questions).toEqual([
      {
        id: "response",
        header: "oh-my-pi",
        question: "Pick an option",
        options: [],
        allowCustomAnswer: true,
        multiSelect: false,
      },
    ]);
  });
});

describe("makeOmpElicitationAcceptResponse", () => {
  it("coerces each answer to the property's declared type", () => {
    const request = formRequest({
      choice: { type: "string", enum: ["a", "b"] },
      confirm: { type: "boolean" },
      count: { type: "integer" },
    });
    const response = makeOmpElicitationAcceptResponse(request, {
      choice: "a",
      confirm: "true",
      count: "3",
    });
    expect(response).toEqual({
      action: { action: "accept", content: { choice: "a", confirm: true, count: 3 } },
    });
  });

  it("omits answers that were never provided", () => {
    const request = formRequest({ choice: { type: "string", enum: ["a", "b"] } });
    const response = makeOmpElicitationAcceptResponse(request, {});
    expect(response).toEqual({ action: { action: "accept", content: {} } });
  });
});

describe("elicitation decline/cancel responses", () => {
  it("builds the declined-url-mode response", () => {
    expect(makeOmpElicitationDeclineResponse()).toEqual({ action: { action: "decline" } });
  });

  it("builds the cancelled response", () => {
    expect(makeOmpElicitationCancelledResponse()).toEqual({ action: { action: "cancel" } });
  });
});

describe("native omp askDialog shapes", () => {
  const askDialogRequest = (multi: boolean): OmpElicitationFormRequest =>
    formRequest(
      multi
        ? {
            q0: {
              type: "array",
              title: "Which options apply?",
              description: "Header text",
              items: {
                anyOf: [
                  { const: "Alpha", title: "Alpha" },
                  { const: "Beta", title: "Beta" },
                ],
              },
            },
            q0__other: { type: "string", title: "Other (type your own)" },
          }
        : {
            q0: {
              type: "string",
              title: "Which option do you choose?",
              description: "Header text",
              oneOf: [
                { const: "Alpha", title: "Alpha" },
                { const: "Beta", title: "Beta" },
              ],
            },
            q0__other: { type: "string", title: "Other (type your own)" },
          },
    );

  it("coalesces the `__other` companion into a single question with its real options", () => {
    const questions = extractOmpElicitationQuestions(askDialogRequest(false));
    expect(questions).toEqual([
      {
        id: "q0",
        header: "Header text",
        question: "Which option do you choose?",
        options: [
          { label: "Alpha", description: "Alpha", value: "Alpha" },
          { label: "Beta", description: "Beta", value: "Beta" },
        ],
        allowCustomAnswer: true,
        multiSelect: false,
      },
    ]);
  });

  it("maps `items.anyOf` into a multi-select question", () => {
    const questions = extractOmpElicitationQuestions(askDialogRequest(true));
    expect(questions).toEqual([
      {
        id: "q0",
        header: "Header text",
        question: "Which options apply?",
        options: [
          { label: "Alpha", description: "Alpha", value: "Alpha" },
          { label: "Beta", description: "Beta", value: "Beta" },
        ],
        allowCustomAnswer: true,
        multiSelect: true,
      },
    ]);
  });

  it("round-trips a known option label through the real property", () => {
    const response = makeOmpElicitationAcceptResponse(askDialogRequest(false), { q0: "Alpha" });
    expect(response).toEqual({ action: { action: "accept", content: { q0: "Alpha" } } });
  });

  it("routes a typed custom answer through the `__other` companion property", () => {
    const response = makeOmpElicitationAcceptResponse(askDialogRequest(false), {
      q0: "something the agent didn't offer",
    });
    expect(response).toEqual({
      action: {
        action: "accept",
        content: { q0__other: "something the agent didn't offer" },
      },
    });
  });

  it("preserves typed custom answers for multi-select questions", () => {
    expect(makeOmpElicitationAcceptResponse(askDialogRequest(true), { q0: "Gamma" })).toEqual({
      action: { action: "accept", content: { q0__other: "Gamma" } },
    });
    expect(
      makeOmpElicitationAcceptResponse(askDialogRequest(true), { q0: ["Alpha", "Gamma"] }),
    ).toEqual({
      action: { action: "accept", content: { q0: ["Alpha"], q0__other: "Gamma" } },
    });
  });
});

describe("selectOmpPermissionOptionId", () => {
  const request: EffectAcpSchema.RequestPermissionRequest = {
    sessionId: "session-1",
    toolCall: { toolCallId: "tool-1", title: "bash" },
    options: [
      { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
      { optionId: "allow_always", name: "Always allow", kind: "allow_always" },
      { optionId: "reject_once", name: "Reject", kind: "reject_once" },
      { optionId: "reject_always", name: "Always reject", kind: "reject_always" },
    ],
  };

  it("selects the underscore `allow_once` id for accept", () => {
    expect(selectOmpPermissionOptionId(request, "accept")).toBe("allow_once");
  });

  it("selects the underscore `allow_always` id for acceptForSession", () => {
    expect(selectOmpPermissionOptionId(request, "acceptForSession")).toBe("allow_always");
  });

  it("selects the underscore `reject_once` id for decline", () => {
    expect(selectOmpPermissionOptionId(request, "decline")).toBe("reject_once");
  });

  it("returns undefined when the agent did not offer a matching kind", () => {
    const noAllowAlways: EffectAcpSchema.RequestPermissionRequest = {
      ...request,
      options: [{ optionId: "allow_once", name: "Allow once", kind: "allow_once" }],
    };
    expect(selectOmpPermissionOptionId(noAllowAlways, "decline")).toBeUndefined();
  });
});
