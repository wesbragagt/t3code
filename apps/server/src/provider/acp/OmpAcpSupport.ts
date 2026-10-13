/**
 * OmpAcpSupport — ACP spawn/runtime/model-selection/elicitation helpers for
 * the oh-my-pi (`omp acp`) driver.
 *
 * omp's native ACP implementation (verified against the installed
 * `@oh-my-pi/pi-coding-agent` CLI's `src/modes/acp/acp-agent.ts`,
 * `src/session/acp-permission-gate.ts`, `src/session/session-tools.ts`, and
 * confirmed against live `omp acp` sessions) differs from the Cursor/Grok
 * ACP drivers in three load-bearing ways:
 *
 *  - Model selection is ONLY the generic `session/set_config_option` write
 *    against configId `"model"` (values are `${provider}/${modelId}`, e.g.
 *    `"openai/gpt-5.2"`). There is no `session/set_model` (unstable)
 *    support and no legacy `models` field on `session/new|load|resume` —
 *    model discovery must read the session's `configOptions`.
 *  - Tool-call approvals (`bash`/`edit`/`delete`/`move`) DO go through real
 *    `session/request_permission` requests, gated by `tools.approvalMode`
 *    (CLI `--approval-mode=always-ask|write`; disabled entirely by
 *    `--approval-mode=yolo` / `--auto-approve`). omp's option ids are
 *    `allow_once`/`allow_always`/`reject_once`/`reject_always` (underscore,
 *    per the ACP spec's `kind` enum) — an unrecognized id fails the tool
 *    call closed, so responses must select the real negotiated `optionId`
 *    by `kind` (see `selectOmpPermissionOptionId`), never a hardcoded guess.
 *  - User questions (plan approval, `ask`-style tool prompts) arrive as
 *    real ACP `session/elicitation` form requests (a JSON-schema-shaped
 *    object), not a vendor extension method.
 *
 * @module OmpAcpSupport
 */
import {
  type OmpSettings,
  type ProviderApprovalDecision,
  type ProviderUserInputAnswers,
  type RuntimeMode,
  type UserInputQuestion,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

/** omp's only advertised ACP auth method; reuses whatever credentials the CLI already has. */
const OMP_AUTH_METHOD_ID = "agent";
export const OMP_MODEL_CONFIG_ID = "model";
export const OMP_THINKING_CONFIG_ID = "thinking";

type OmpAcpRuntimeOmpSettings = Pick<OmpSettings, "binaryPath">;

export interface OmpAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly ompSettings: OmpAcpRuntimeOmpSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runtimeMode?: RuntimeMode;
}

/**
 * Maps `RuntimeMode` to omp's `--approval-mode` CLI flag. `full-access`
 * disables `session/request_permission` entirely (yolo); every other mode
 * keeps it live, gated by `tools.approvalMode` — see
 * `selectOmpPermissionOptionId` for how responses are built.
 */
export function ompAcpApprovalArgs(runtimeMode?: RuntimeMode): ReadonlyArray<string> {
  switch (runtimeMode) {
    case "approval-required":
      return ["--approval-mode=always-ask"];
    case "auto-accept-edits":
    case "auto":
      return ["--approval-mode=write"];
    case "full-access":
      return ["--approval-mode=yolo"];
    default:
      return [];
  }
}

/**
 * Selects the real negotiated `optionId` for a decision from the agent's
 * own `request.options` array, by ACP spec `kind`
 * (`allow_once`/`allow_always`/`reject_once`/`reject_always`). omp's
 * `PERMISSION_OPTIONS_BY_ID` lookup fails closed on an unrecognized id, so
 * a response must never guess a hardcoded id string. Returns `undefined`
 * when the agent did not offer a matching option.
 */
export function selectOmpPermissionOptionId(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: Exclude<ProviderApprovalDecision, "cancel">,
): string | undefined {
  const byKind = (kind: EffectAcpSchema.PermissionOptionKind) =>
    request.options.find((option) => option.kind === kind)?.optionId;
  switch (decision) {
    case "acceptForSession":
      return byKind("allow_always") ?? byKind("allow_once");
    case "accept":
      return byKind("allow_once") ?? byKind("allow_always");
    case "decline":
    default:
      return byKind("reject_once") ?? byKind("reject_always");
  }
}

export function buildOmpAcpSpawnInput(
  ompSettings: OmpAcpRuntimeOmpSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  runtimeMode?: RuntimeMode,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: ompSettings?.binaryPath || "omp",
    args: [...ompAcpApprovalArgs(runtimeMode), "acp"],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

/**
 * omp supports form-mode `session/elicitation` (plan approval, `ask`-style
 * questions). Advertising this capability lets the native agent ask the
 * user instead of silently auto-approving plan proposals (omp auto-approves
 * plan mode when the client does not advertise form elicitation).
 */
const OMP_CLIENT_CAPABILITIES = {
  elicitation: { form: {} },
} satisfies NonNullable<EffectAcpSchema.InitializeRequest["clientCapabilities"]>;

export const makeOmpAcpRuntime = (
  input: OmpAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildOmpAcpSpawnInput(
          input.ompSettings,
          input.cwd,
          input.environment,
          input.runtimeMode,
        ),
        authMethodId: OMP_AUTH_METHOD_ID,
        clientCapabilities: OMP_CLIENT_CAPABILITIES,
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

/** omp model ids are already `${provider}/${modelId}` on the wire; nothing to rewrite. */
export function resolveOmpAcpBaseModelId(model: string | null | undefined): string {
  return model?.trim() ?? "";
}

export interface OmpAcpModelSelectionRuntime {
  readonly getConfigOptions: AcpSessionRuntime.AcpSessionRuntime["Service"]["getConfigOptions"];
  readonly setConfigOption: (
    configId: string,
    value: string | boolean,
  ) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
  readonly setModel: (model: string) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
}

export interface OmpAcpModelSelectionErrorContext {
  readonly cause: EffectAcpErrors.AcpError;
  readonly step: "set-model" | "set-config-option";
  readonly configId?: string;
}

/**
 * Applies a model selection through `session/set_config_option` (configId
 * `"model"`), plus an optional `"thinking"` level selection through the same
 * mechanism (`off|minimal|low|medium|high|xhigh|max|auto` per the native
 * agent's own config option, applied only when it matches one of the
 * negotiated option values).
 */
export function applyOmpAcpModelSelection<E>(input: {
  readonly runtime: OmpAcpModelSelectionRuntime;
  readonly model: string | null | undefined;
  readonly thinking: string | null | undefined;
  readonly mapError: (context: OmpAcpModelSelectionErrorContext) => E;
}): Effect.Effect<void, E> {
  return Effect.gen(function* () {
    const model = resolveOmpAcpBaseModelId(input.model);
    if (model) {
      yield* input.runtime
        .setModel(model)
        .pipe(Effect.mapError((cause) => input.mapError({ cause, step: "set-model" })));
    }
    const requestedThinking = input.thinking?.trim();
    if (!requestedThinking) {
      return;
    }
    const configOptions = yield* input.runtime.getConfigOptions;
    const thinkingOption = configOptions.find((option) => option.id === OMP_THINKING_CONFIG_ID);
    const hasValue = flattenOmpSelectOptions(thinkingOption).some(
      (option) => option.value === requestedThinking,
    );
    if (!hasValue) {
      return;
    }
    yield* input.runtime
      .setConfigOption(OMP_THINKING_CONFIG_ID, requestedThinking)
      .pipe(
        Effect.mapError((cause) =>
          input.mapError({ cause, step: "set-config-option", configId: OMP_THINKING_CONFIG_ID }),
        ),
      );
  });
}

/** Flattens a `"select"` config option's (possibly grouped) values into a flat list. */
function flattenOmpSelectOptions(
  option: EffectAcpSchema.SessionConfigOption | undefined,
): ReadonlyArray<EffectAcpSchema.SessionConfigSelectOption> {
  if (!option || option.type !== "select") {
    return [];
  }
  return option.options.flatMap((entry) => ("group" in entry ? entry.options : [entry]));
}

export interface OmpDiscoveredModel {
  readonly id: string;
  readonly displayName: string;
  readonly description?: string;
}

/** Models advertised through the native `"model"` select config option. */
export function ompModelsFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ReadonlyArray<OmpDiscoveredModel> {
  const modelOption = configOptions?.find((option) => option.id === OMP_MODEL_CONFIG_ID);
  return flattenOmpSelectOptions(modelOption).flatMap((option) =>
    option.value.trim()
      ? [
          {
            id: option.value,
            displayName: option.name?.trim() || option.value,
            ...(option.description ? { description: option.description } : {}),
          },
        ]
      : [],
  );
}

// ---------------------------------------------------------------------------
// Elicitation (`session/elicitation`) -> generic user-input question mapping
// ---------------------------------------------------------------------------

export type OmpElicitationFormRequest = Extract<
  EffectAcpSchema.ElicitationRequest,
  { readonly mode: "form" }
>;

export function isOmpElicitationFormRequest(
  request: EffectAcpSchema.ElicitationRequest,
): request is OmpElicitationFormRequest {
  return "mode" in request && request.mode === "form";
}

type OmpElicitationProperty = NonNullable<
  OmpElicitationFormRequest["requestedSchema"]["properties"]
>[string];

// omp's `askDialog` bridge (src/modes/acp/acp-agent.ts) always pairs a real
// question property `qN` with a free-text companion property `qN__other`
// (title "Other (type your own)"). A typed custom answer wins over any
// selected option on the real property. T3 folds that pair into a single
// question with `allowCustomAnswer: true`, and routes a custom answer back
// through the `__other` property, exactly mirroring that wire contract.
const OMP_OTHER_PROPERTY_SUFFIX = "__other";

function ompOtherPropertyKey(baseId: string): string {
  return `${baseId}${OMP_OTHER_PROPERTY_SUFFIX}`;
}

function ompBasePropertyIdOfOther(
  id: string,
  propertyIds: ReadonlySet<string>,
): string | undefined {
  if (!id.endsWith(OMP_OTHER_PROPERTY_SUFFIX)) return undefined;
  const baseId = id.slice(0, -OMP_OTHER_PROPERTY_SUFFIX.length);
  return propertyIds.has(baseId) ? baseId : undefined;
}

interface OmpElicitationChoice {
  readonly options: ReadonlyArray<{
    readonly label: string;
    readonly description: string;
    readonly value: string;
  }>;
  readonly multiSelect: boolean;
}

/**
 * Extracts the enumerable choice set from a property. omp's own ask-dialog
 * tool encodes titled single-select choices as `string.oneOf` and titled
 * multi-select choices as `array.items.anyOf` (both `{const, title}`
 * entries) — checked before the bare JSON-Schema `enum` fallback used by
 * other elicitation producers. Returns `undefined` for a property with no
 * enumerable choice set (free text).
 */
function ompElicitationPropertyChoice(
  property: OmpElicitationProperty,
): OmpElicitationChoice | undefined {
  if (property.type === "boolean") {
    return {
      options: [
        { label: "Yes", description: "Yes", value: "true" },
        { label: "No", description: "No", value: "false" },
      ],
      multiSelect: false,
    };
  }
  if (property.type === "string") {
    if (property.oneOf && property.oneOf.length > 0) {
      return {
        options: property.oneOf.map((option) => ({
          label: option.title,
          description: option.title,
          value: option.const,
        })),
        multiSelect: false,
      };
    }
    if (property.enum && property.enum.length > 0) {
      return {
        options: property.enum.map((value) => ({ label: value, description: value, value })),
        multiSelect: false,
      };
    }
    return undefined;
  }
  if (property.type === "array") {
    if (property.items && "anyOf" in property.items && property.items.anyOf.length > 0) {
      return {
        options: property.items.anyOf.map((option) => ({
          label: option.title,
          description: option.title,
          value: option.const,
        })),
        multiSelect: true,
      };
    }
    if (property.items && "enum" in property.items && property.items.enum.length > 0) {
      return {
        options: property.items.enum.map((value) => ({ label: value, description: value, value })),
        multiSelect: true,
      };
    }
    return undefined;
  }
  // "number" | "integer": no enumerable choice set.
  return undefined;
}

/**
 * Maps an omp `session/elicitation` form request into T3's generic
 * question/answer channel (`user-input.requested`). One real ACP schema
 * property becomes one question (its paired `__other` free-text property is
 * folded into `allowCustomAnswer`, not surfaced separately); a property
 * without an enumerable choice set becomes a free-text question. A schema
 * with no properties at all (a bare confirmation prompt) becomes a single
 * free-text question so the agent is never silently stranded.
 */
export function extractOmpElicitationQuestions(
  request: OmpElicitationFormRequest,
): ReadonlyArray<UserInputQuestion> {
  const defaultHeader = request.requestedSchema.title?.trim() || "oh-my-pi";
  const properties = request.requestedSchema.properties ?? {};
  const propertyIds = new Set(Object.keys(properties));
  const entries = Object.entries(properties).filter(
    ([id]) => ompBasePropertyIdOfOther(id, propertyIds) === undefined,
  );
  if (entries.length === 0) {
    return [
      {
        id: "response",
        header: defaultHeader,
        question: request.message,
        options: [],
        allowCustomAnswer: true,
        multiSelect: false,
      },
    ];
  }
  return entries.map(([id, property]) => {
    const choice = ompElicitationPropertyChoice(property);
    const hasOtherSibling = propertyIds.has(ompOtherPropertyKey(id));
    return {
      id,
      // omp puts the header in `description` and the question text in
      // `title` (the generic schema-level title is the fallback header).
      header: property.description?.trim() || defaultHeader,
      question: property.title?.trim() || property.description?.trim() || request.message,
      options: choice?.options ?? [],
      allowCustomAnswer: choice === undefined || hasOtherSibling,
      multiSelect: choice?.multiSelect ?? false,
    };
  });
}

function coerceOmpElicitationAnswer(
  property: OmpElicitationProperty,
  value: unknown,
): EffectAcpSchema.ElicitationContentValue | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  switch (property.type) {
    case "boolean":
      return value === true || value === "true";
    case "number":
    case "integer": {
      const numeric = typeof value === "number" ? value : Number(value);
      return Number.isFinite(numeric) ? numeric : undefined;
    }
    case "array":
      return Array.isArray(value) ? value.map((entry) => String(entry)) : [String(value)];
    default:
      return Array.isArray(value) ? String(value[0] ?? "") : String(value);
  }
}

/** Routes known choices through their property and custom text through `__other`. */
export function makeOmpElicitationAcceptResponse(
  request: OmpElicitationFormRequest,
  answers: ProviderUserInputAnswers,
): EffectAcpSchema.ElicitationResponse {
  const properties = request.requestedSchema.properties ?? {};
  const propertyIds = new Set(Object.keys(properties));
  const content: Record<string, EffectAcpSchema.ElicitationContentValue> = {};

  for (const [id, property] of Object.entries(properties)) {
    if (ompBasePropertyIdOfOther(id, propertyIds) !== undefined) {
      // Companion free-text field; populated below from its base question.
      continue;
    }
    const answer = answers[id];
    if (answer === undefined || answer === null) {
      continue;
    }
    const choice = ompElicitationPropertyChoice(property);
    const otherKey = ompOtherPropertyKey(id);
    if (property.type === "array" && propertyIds.has(otherKey)) {
      const knownValues = new Set(choice.options.map((option) => option.value));
      const values = Array.isArray(answer) ? answer.map(String) : [String(answer)];
      const selected = values.filter((value) => knownValues.has(value));
      const custom = values
        .filter((value) => !knownValues.has(value))
        .join(", ")
        .trim();
      if (selected.length > 0) content[id] = selected;
      if (custom) content[otherKey] = custom;
      continue;
    }
    if (property.type === "string" && choice && !choice.multiSelect) {
      const knownValues = new Set(choice.options.map((option) => option.value));
      const text = Array.isArray(answer) ? String(answer[0] ?? "") : String(answer);
      if (knownValues.has(text) || !propertyIds.has(otherKey)) {
        content[id] = text;
      } else if (text.trim()) {
        content[otherKey] = text.trim();
      }
      continue;
    }
    const coerced = coerceOmpElicitationAnswer(property, answer);
    if (coerced !== undefined) {
      content[id] = coerced;
    }
  }

  if (Object.keys(properties).length === 0) {
    const freeText = answers.response;
    if (typeof freeText === "string" && freeText.trim()) {
      return { action: { action: "accept", content: { response: freeText } } };
    }
  }
  return { action: { action: "accept", content } };
}
export function makeOmpElicitationCancelledResponse(): EffectAcpSchema.ElicitationResponse {
  return { action: { action: "cancel" } };
}

/** omp sends "url"-mode elicitations too; headless T3 cannot open a browser for the user. */
export function makeOmpElicitationDeclineResponse(): EffectAcpSchema.ElicitationResponse {
  return { action: { action: "decline" } };
}
