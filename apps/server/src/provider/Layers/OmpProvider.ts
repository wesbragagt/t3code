/**
 * OmpProvider — status probe + model discovery for the oh-my-pi (`omp`) CLI.
 *
 * omp advertises no model metadata on `initialize` (unlike Grok's
 * `_meta.modelState`) and no legacy `models` field on `session/new` (unlike
 * Cursor's `CursorListAvailableModelsResponse`). The only place models are
 * discoverable is the `"model"` select config option returned once a real
 * session is opened, so model discovery here opens and tears down a scratch
 * ACP session rather than reading `initialize` alone.
 *
 * @module OmpProvider
 */
import {
  type CustomModelSetting,
  type ModelCapabilities,
  type OmpSettings,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import { makeOmpAcpRuntime, ompModelsFromConfigOptions } from "../acp/OmpAcpSupport.ts";

const OMP_PRESENTATION = {
  displayName: "oh-my-pi",
  supportsConversationRollback: false,
  showInteractionModeToggle: true,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });

const VERSION_PROBE_TIMEOUT_MS = 4_000;
// Model discovery opens a real ACP session (initialize + authenticate +
// session/new), unlike a bare `initialize` probe, so it gets a more
// generous budget than VERSION_PROBE_TIMEOUT_MS.
const OMP_ACP_SESSION_PROBE_TIMEOUT_MS = 15_000;

function ompModelsFromSettings(
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = [],
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

export function buildInitialOmpProviderSnapshot(
  ompSettings: OmpSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = ompModelsFromSettings(ompSettings.customModels);

    if (!ompSettings.enabled) {
      return buildServerProvider({
        presentation: OMP_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "oh-my-pi is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking oh-my-pi CLI availability...",
      },
    });
  });
}

const runOmpCliCommand = (
  ompSettings: OmpSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const command = ompSettings.binaryPath || "omp";
    const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

/**
 * Opens a scratch `omp acp` session (initialize + authenticate +
 * session/new) in `cwd`, reads the negotiated `"model"` config option, and
 * tears the process down. This is the only way to discover omp's model
 * list — see the module doc.
 */
const discoverOmpModelsViaAcpSession = (
  ompSettings: OmpSettings,
  environment: NodeJS.ProcessEnv,
  cwd: string,
) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const acp = yield* makeOmpAcpRuntime({
      ompSettings,
      environment,
      childProcessSpawner,
      cwd,
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
    yield* acp.start();
    const configOptions = yield* acp.getConfigOptions;
    return ompModelsFromConfigOptions(configOptions);
  }).pipe(Effect.scoped);

export const checkOmpProviderStatus = Effect.fn("checkOmpProviderStatus")(function* (
  ompSettings: OmpSettings,
  environment: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = ompModelsFromSettings(ompSettings.customModels);

  if (!ompSettings.enabled) {
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "oh-my-pi is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runOmpCliCommand(ompSettings, ["--version"], environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("oh-my-pi CLI health check failed.", { errorTag: error._tag });
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: ompSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "oh-my-pi CLI (`omp`) is not installed or not on PATH."
          : "Failed to execute oh-my-pi CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: ompSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "oh-my-pi CLI is installed but timed out while running `omp --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("oh-my-pi CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
    });
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: ompSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "oh-my-pi CLI is installed but failed to run.",
      },
    });
  }

  const acpExit = yield* discoverOmpModelsViaAcpSession(ompSettings, environment, cwd).pipe(
    Effect.timeoutOption(OMP_ACP_SESSION_PROBE_TIMEOUT_MS),
    Effect.exit,
  );
  const discoveredModels = Exit.isSuccess(acpExit)
    ? Option.getOrUndefined(acpExit.value)
    : undefined;
  const acpFailed = Exit.isFailure(acpExit) || discoveredModels === undefined;
  if (acpFailed) {
    yield* Effect.logWarning("oh-my-pi ACP session probe failed or timed out.", {
      errorTag: Exit.isFailure(acpExit) ? causeErrorTag(acpExit.cause) : "Timeout",
    });
  }

  const models =
    discoveredModels && discoveredModels.length > 0
      ? ompModelsFromSettings(
          ompSettings.customModels,
          discoveredModels.map((model) => ({
            slug: model.id,
            name: model.displayName,
            isCustom: false,
            capabilities: EMPTY_CAPABILITIES,
          })),
        )
      : fallbackModels;

  // omp has no distinct "are you logged in" signal: it reuses whatever
  // credentials/profile the CLI already has, so a successful ACP session
  // probe does not prove authenticated model access. Auth stays "unknown"
  // rather than guessing — honestly advertising what we cannot verify.
  return buildServerProvider({
    presentation: OMP_PRESENTATION,
    enabled: ompSettings.enabled,
    checkedAt,
    models,
    probe: {
      installed: true,
      version,
      status: acpFailed ? "warning" : "ready",
      auth: { status: "unknown" },
      ...(acpFailed
        ? {
            message:
              "oh-my-pi CLI is installed but the ACP session probe failed. Model options may be incomplete.",
          }
        : {}),
    },
  });
});

export const enrichOmpSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  const { snapshot, publishSnapshot } = input;

  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("oh-my-pi version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
