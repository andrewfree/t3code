import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type ProviderInstanceMutation,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/ai";

import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as EnvironmentHandlers from "./handlers.ts";
import { EnvironmentToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("environment:preferences");
const threadId = ThreadId.make("thread:preferences");
const caller: McpInvocationContext.McpInvocationScope = {
  environmentId,
  requestNamespace: "provider:preferences",
  thread: {
    threadId,
    providerSessionId: "provider:preferences",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration" as const]),
  issuedAt: 0,
};
const layerEnvironment = Layer.mock(Environment.ServerEnvironment)({
  getDescriptor: Effect.succeed({
    environmentId,
    label: "Test",
    platform: { os: "linux", arch: "x64" },
    serverVersion: "0.0.0",
    capabilities: { repositoryIdentity: false },
  }),
});

it.effect("updates preferences for a thread caller through the /mcp registration", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({
        name: "t3_environment_preferences_update",
        arguments: { newWorktreesStartFromOrigin: true },
      })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, caller),
        Effect.provideService(
          McpSchema.McpServerClient,
          McpSchema.McpServerClient.of({
            clientId: 1,
            protocolVersion: "2025-06-18",
            clientCapabilities: {},
            clientInfo: { name: "preferences", version: "1" },
            initializePayload: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "preferences", version: "1" },
            },
            getClient: Effect.die("unused"),
          }),
        ),
      );
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({ newWorktreesStartFromOrigin: true });
  }).pipe(
    Effect.provide(
      McpHttpServer.layerEnvironmentToolkit.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
          }),
        ),
        Layer.provide(layerEnvironment),
        Layer.provide(Settings.layerTest()),
      ),
    ),
  ),
);

const instanceId = ProviderInstanceId.make("temporary_provider");
const instance = {
  driver: ProviderDriverKind.make("claudeAgent"),
  displayName: "Temporary provider",
  config: { binaryPath: "/test/provider" },
};
const decodeFailure = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ code: Schema.String })),
);

const callProviderUpdate = (mutation: ProviderInstanceMutation) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server.callTool({
      name: "t3_provider_instance_update",
      arguments: { mutation },
    });
  }).pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, caller),
    Effect.provideService(
      McpSchema.McpServerClient,
      McpSchema.McpServerClient.of({
        clientId: 1,
        protocolVersion: "2025-06-18",
        clientCapabilities: {},
        clientInfo: { name: "providers", version: "1" },
        initializePayload: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "providers", version: "1" },
        },
        getClient: Effect.die("unused"),
      }),
    ),
  );

const providerServer = (shell: OrchestrationV2ThreadShell) =>
  McpHttpServer.layerEnvironmentToolkit.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(shell),
      }),
    ),
    Layer.provide(layerEnvironment),
    Layer.provideMerge(Settings.layerTest()),
  );

it.effect("updates one provider through /mcp and returns only mutation metadata", () =>
  Effect.gen(function* () {
    const settings = yield* Settings.ServerSettingsService;
    const before = yield* settings.getSettings;
    const created = yield* callProviderUpdate({ operation: "create", instanceId, instance });
    expect(created.isError).toBe(false);
    expect(created.structuredContent).toEqual({ instanceId, operation: "create", updated: true });
    expect(yield* settings.getSettings).toMatchObject({
      providerInstances: { [instanceId]: instance },
    });
    const duplicate = yield* callProviderUpdate({ operation: "create", instanceId, instance });
    expect(duplicate.isError).toBe(true);
    expect(
      decodeFailure(
        duplicate.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
      ),
    ).toEqual({ code: "orchestration_error" });
    const stale = yield* callProviderUpdate({
      operation: "remove",
      instanceId,
      expectedInstance: { ...instance, displayName: "Stale" },
    });
    expect(stale.isError).toBe(true);
    expect(
      decodeFailure(stale.content.map((part) => (part.type === "text" ? part.text : "")).join("")),
    ).toEqual({ code: "orchestration_error" });
    yield* settings.updateSettings({ newWorktreesStartFromOrigin: true });
    const removed = yield* callProviderUpdate({
      operation: "remove",
      instanceId,
      expectedInstance: instance,
    });
    expect(removed.isError).toBe(false);
    expect(removed.structuredContent).toEqual({ instanceId, operation: "remove", updated: true });
    expect(yield* settings.getSettings).toEqual({ ...before, newWorktreesStartFromOrigin: true });
    for (const result of [created, duplicate, stale, removed]) {
      const encoded = JSON.stringify(result);
      expect(encoded).not.toContain(instance.config.binaryPath);
      expect(encoded).not.toContain(instance.displayName);
    }
  }).pipe(Effect.provide(providerServer(liveThreadShell(threadId)))),
);

it.effect.each([
  { runtimeMode: "approval-required", interactionMode: "default" },
  { runtimeMode: "full-access", interactionMode: "plan" },
] as const)("refuses provider updates from restricted caller modes %o", (modes) =>
  Effect.gen(function* () {
    const settings = yield* Settings.ServerSettingsService;
    const before = yield* settings.getSettings;
    const result = yield* callProviderUpdate({ operation: "create", instanceId, instance });
    expect(result.isError).toBe(true);
    expect(
      decodeFailure(result.content.map((part) => (part.type === "text" ? part.text : "")).join("")),
    ).toEqual({ code: "capability_denied" });
    expect(yield* settings.getSettings).toEqual(before);
  }).pipe(Effect.provide(providerServer({ ...liveThreadShell(threadId), ...modes }))),
);

it.effect.each(["preferences", "provider"] as const)(
  "refuses a %s update when the caller's turn ends while it waits",
  (kind) =>
    Effect.gen(function* () {
      const caller = yield* Ref.make<OrchestrationV2ThreadShell>(liveThreadShell(threadId));
      const updates = yield* Ref.make(0);
      // Completes once the declaration's own check has read the caller.
      const checked = yield* Deferred.make<void>();
      const layerDependencies = Layer.mergeAll(
        ThreadCommandExecutor.layer,
        Layer.succeed(McpInvocationContext.McpInvocationContext, {
          environmentId,
          requestNamespace: "provider:preferences",
          thread: {
            threadId,
            providerSessionId: "provider:preferences",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
          client: undefined,
          capabilities: new Set(["orchestration" as const]),
          issuedAt: 0,
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: () =>
            Ref.get(caller).pipe(Effect.tap(() => Deferred.succeed(checked, undefined))),
        }),
        Layer.mock(Environment.ServerEnvironment)({
          getDescriptor: Effect.succeed({
            environmentId,
            label: "Test",
            platform: { os: "linux", arch: "x64" },
            serverVersion: "0.0.0",
            capabilities: { repositoryIdentity: false },
          }),
        }),
        Layer.mock(Settings.ServerSettingsService)({
          getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
          updateSettings: () =>
            Ref.update(updates, (count) => count + 1).pipe(Effect.as(DEFAULT_SERVER_SETTINGS)),
          updateProviderInstance: () =>
            Ref.update(updates, (count) => count + 1).pipe(Effect.as(DEFAULT_SERVER_SETTINGS)),
        }),
      );
      yield* Effect.gen(function* () {
        const toolkit = yield* EnvironmentToolkit;
        const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
        const held = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        // A turn-completion command holds the thread's lock.
        const holder = yield* executor
          .withLock(
            threadId,
            Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(held);
        const request =
          kind === "preferences"
            ? toolkit
                .handle("t3_environment_preferences_update", {
                  newWorktreesStartFromOrigin: true,
                })
                .pipe(
                  Stream.unwrap,
                  Stream.runCollect,
                  Effect.map((results) =>
                    results.some(
                      ({ result }) => "code" in result && result.code === "parent_not_active",
                    ),
                  ),
                )
            : toolkit
                .handle("t3_provider_instance_update", {
                  mutation: { operation: "create", instanceId, instance },
                })
                .pipe(
                  Stream.unwrap,
                  Stream.runCollect,
                  Effect.map((results) =>
                    results.some(
                      ({ result }) => "code" in result && result.code === "parent_not_active",
                    ),
                  ),
                );
        const update = yield* request.pipe(Effect.forkChild);
        // The update passed its first check and waits for the lock; the turn then ends.
        yield* Deferred.await(checked);
        yield* Ref.update(caller, (shell) => ({ ...shell, activeRunId: null }));
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(holder);
        const result = yield* Fiber.join(update);
        expect(result).toBe(true);
        expect(yield* Ref.get(updates)).toBe(0);
      }).pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(EnvironmentHandlers.layer).pipe(
            Layer.provideMerge(layerDependencies),
          ),
        ),
      );
    }),
);
