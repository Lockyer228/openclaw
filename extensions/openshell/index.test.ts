import type {
  OpenClawPluginApi,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import {
  getSandboxBackendFactory,
  getSandboxBackendManager,
  getSandboxBackendWorkdirResolver,
  type CreateSandboxBackendParams,
} from "openclaw/plugin-sdk/sandbox";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "./index.js";
import { createOpenShellBackendSandboxConfig } from "./src/openshell.test-support.js";

function readBackend() {
  return {
    factory: getSandboxBackendFactory("openshell"),
    manager: getSandboxBackendManager("openshell"),
    resolveWorkdir: getSandboxBackendWorkdirResolver("openshell"),
  };
}

const workdirParams: CreateSandboxBackendParams = {
  sessionKey: "agent:openshell-lifecycle:main",
  scopeKey: "agent:openshell-lifecycle:main",
  workspaceDir: "/tmp/openclaw-openshell-lifecycle/workspace",
  agentWorkspaceDir: "/tmp/openclaw-openshell-lifecycle/workspace",
  cfg: createOpenShellBackendSandboxConfig(),
};

describe("OpenShell plugin registration lifecycle", () => {
  const stops: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const stop of stops.splice(0).toReversed()) {
      await stop();
    }
  });

  async function registerGeneration(remoteWorkspaceDir: string) {
    const services: OpenClawPluginService[] = [];
    const api = createTestPluginApi({
      id: "openshell",
      pluginConfig: { remoteWorkspaceDir },
      registerService: (service) => services.push(service),
    });
    const context: OpenClawPluginServiceContext = {
      config: {},
      stateDir: "/tmp/openclaw-openshell-lifecycle",
      logger: api.logger,
    };
    plugin.register(api);
    const stop = async () => {
      for (const service of services.toReversed()) {
        await service.stop?.(context);
      }
    };
    stops.push(stop);
    for (const service of services) {
      await service.start(context);
    }
    return { backend: readBackend(), stop };
  }

  it("restores all backend hooks after each plugin generation stops", async () => {
    const original = readBackend();
    for (const remoteWorkspaceDir of ["/sandbox/first", "/sandbox/second", "/agent/third"]) {
      const generation = await registerGeneration(remoteWorkspaceDir);
      expect(generation.backend.factory).toEqual(expect.any(Function));
      expect(generation.backend.manager).toEqual({
        describeRuntime: expect.any(Function),
        removeRuntime: expect.any(Function),
      });
      expect(generation.backend.resolveWorkdir?.(workdirParams)).toBe(remoteWorkspaceDir);

      await generation.stop();
      expect(readBackend()).toEqual(original);
      await generation.stop();
      expect(readBackend()).toEqual(original);
    }
  });

  it.each(["older-first", "newer-first"] as const)(
    "preserves the live backend when plugin generations stop %s",
    async (order) => {
      const original = readBackend();
      const older = await registerGeneration("/sandbox/older");
      const newer = await registerGeneration("/sandbox/newer");
      expect(readBackend()).toEqual(newer.backend);

      const first = order === "older-first" ? older : newer;
      const last = order === "older-first" ? newer : older;
      await first.stop();
      expect(readBackend()).toEqual(last.backend);
      await last.stop();
      expect(readBackend()).toEqual(original);
      await first.stop();
      expect(readBackend()).toEqual(original);
    },
  );

  it.each([
    "discovery",
    "tool-discovery",
    "setup-only",
    "setup-runtime",
    "cli-metadata",
  ] satisfies OpenClawPluginApi["registrationMode"][])(
    "does not register runtime hooks or services in %s mode",
    (registrationMode) => {
      const original = readBackend();
      const services: OpenClawPluginService[] = [];
      plugin.register(
        createTestPluginApi({
          registrationMode,
          pluginConfig: { remoteWorkspaceDir: "/outside-managed-roots" },
          registerService: (service) => services.push(service),
        }),
      );
      expect(services).toEqual([]);
      expect(readBackend()).toEqual(original);
    },
  );
});
