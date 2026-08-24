// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  getPreparedModelRuntimeMocks,
  resetPreparedModelRuntimeHarness,
} from "./prepared-model-runtime.test-harness.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  acquireAgentRunPreparedModelRuntime,
  loadPublishedGatewayReplyDispatchRuntime,
  registerPreparedModelRuntimePublicationListener,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";

const mocks = getPreparedModelRuntimeMocks();

describe("prepared model runtime reload auth adoption", () => {
  beforeEach(() => {
    resetPreparedModelRuntimeHarness();
  });

  it("commits auth invalidation inside the active lifecycle publication", async () => {
    mocks.configuredAgentIds = ["default", "worker"];
    const initialConfig = {};
    const replacementConfig = { agents: { defaults: { model: "openai/gpt-5.5" } } };
    await refreshPreparedModelRuntimeSnapshots(initialConfig, { gatewayLifecycle: true });
    const configBuild = createDeferred<{ agentDir: string; wrote: false }>();
    const authBuild = createDeferred<{ agentDir: string; wrote: false }>();
    const order: string[] = [];
    const events: string[] = [];
    const unregister = registerPreparedModelRuntimePublicationListener((event) => {
      events.push(event.phase);
      if (event.phase === "published") {
        order.push("config-published");
      }
    });
    let defaultBuildCount = 0;
    mocks.ensureOpenClawModelsJson.mockImplementation(async (_config, agentDir) => {
      if (agentDir !== "/tmp/unused-agent") {
        return { agentDir: String(agentDir), wrote: false };
      }
      defaultBuildCount += 1;
      if (defaultBuildCount === 1) {
        order.push("config-build-start");
        return await configBuild.promise;
      }
      order.push("auth-drain-start");
      return await authBuild.promise;
    });

    const publication = refreshPreparedModelRuntimeSnapshots(replacementConfig, {
      gatewayLifecycle: true,
    });
    void publication.catch(() => undefined);
    await vi.waitFor(() => expect(order).toContain("config-build-start"));
    order.push("auth-mutation");
    mocks.mutationListener?.({ agentDir: "/tmp/unused-agent", affectsInheritedStores: false });
    const affectedRead = loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }).then(
      (runtime) => {
        order.push("affected-dispatch-resolved");
        return runtime;
      },
    );
    const siblingRead = loadPublishedGatewayReplyDispatchRuntime({ agentId: "worker" });
    void affectedRead.catch(() => undefined);
    void siblingRead.catch(() => undefined);
    order.push("config-build-finish");
    configBuild.resolve({ agentDir: "/tmp/unused-agent", wrote: false });
    await vi.waitFor(() => expect(order).toContain("auth-drain-start"));
    await expect(
      Promise.race([publication.then(() => "settled"), Promise.resolve("pending")]),
    ).resolves.toBe("pending");
    await expect(
      Promise.race([affectedRead.then(() => "settled"), Promise.resolve("pending")]),
    ).resolves.toBe("pending");

    order.push("auth-drain-finish");
    authBuild.resolve({ agentDir: "/tmp/unused-agent", wrote: false });
    await expect(publication).resolves.toBeUndefined();
    const [affectedRuntime, siblingRuntime] = await Promise.all([affectedRead, siblingRead]);
    unregister();

    expect(events.filter((phase) => phase === "published")).toHaveLength(1);
    expect(events).not.toContain("failed");
    expect(mocks.warn).not.toHaveBeenCalled();
    expect(affectedRuntime?.config).toBe(replacementConfig);
    expect(siblingRuntime?.config).toBe(replacementConfig);
    expect(order).toEqual([
      "config-build-start",
      "auth-mutation",
      "config-build-finish",
      "auth-drain-start",
      "auth-drain-finish",
      "config-published",
      "affected-dispatch-resolved",
    ]);
    const buildCountAfterPublication = mocks.ensureOpenClawModelsJson.mock.calls.length;
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(buildCountAfterPublication);
    const lease = await acquireAgentRunPreparedModelRuntime({
      agentId: "default",
      agentDir: "/tmp/unused-agent",
      config: replacementConfig,
      workspaceDir: "/tmp/unused-workspace",
    });
    expect(lease.snapshot.config).toBe(replacementConfig);
    lease.release();
  });

  it("adopts an in-flight auth gate into a same-owner config reload", async () => {
    mocks.configuredAgentIds = ["default"];
    const initialConfig = {};
    const replacementConfig = { plugins: {} };
    await refreshPreparedModelRuntimeSnapshots(initialConfig, { gatewayLifecycle: true });
    const authBuild = createDeferred<{ agentDir: string; wrote: false }>();
    const configBuild = createDeferred<{ agentDir: string; wrote: false }>();
    const events: string[] = [];
    const unregister = registerPreparedModelRuntimePublicationListener((event) => {
      events.push(event.phase);
    });
    mocks.ensureOpenClawModelsJson
      .mockImplementationOnce(async () => await authBuild.promise)
      .mockImplementationOnce(async () => await configBuild.promise);

    mocks.mutationListener?.({ agentDir: "/tmp/unused-agent", affectsInheritedStores: false });
    await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2));
    const authWaiter = loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" });
    void authWaiter.catch(() => undefined);
    const reload = refreshPreparedModelRuntimeSnapshots(replacementConfig, {
      gatewayLifecycle: true,
    });
    void reload.catch(() => undefined);
    authBuild.resolve({ agentDir: "/tmp/unused-agent", wrote: false });
    await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(3));
    await expect(
      Promise.race([authWaiter.then(() => "settled"), Promise.resolve("pending")]),
    ).resolves.toBe("pending");

    configBuild.resolve({ agentDir: "/tmp/unused-agent", wrote: false });
    await expect(reload).resolves.toBeUndefined();
    const runtime = await authWaiter;
    unregister();

    expect(runtime?.config).toBe(replacementConfig);
    expect(events.filter((phase) => phase === "published")).toHaveLength(1);
    expect(events).not.toContain("failed");
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("rejects an adopted auth gate when config reload fails and permits recovery", async () => {
    mocks.configuredAgentIds = ["default"];
    const initialConfig = {};
    const replacementConfig = { plugins: {} };
    await refreshPreparedModelRuntimeSnapshots(initialConfig, { gatewayLifecycle: true });
    const authBuild = createDeferred<{ agentDir: string; wrote: false }>();
    const reloadError = new Error("replacement config failed");
    mocks.ensureOpenClawModelsJson
      .mockImplementationOnce(async () => await authBuild.promise)
      .mockRejectedValueOnce(reloadError);

    mocks.mutationListener?.({ agentDir: "/tmp/unused-agent", affectsInheritedStores: false });
    await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2));
    const authWaiter = loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" });
    void authWaiter.catch(() => undefined);
    const reload = refreshPreparedModelRuntimeSnapshots(replacementConfig, {
      gatewayLifecycle: true,
    });
    void reload.catch(() => undefined);
    authBuild.resolve({ agentDir: "/tmp/unused-agent", wrote: false });

    await expect(reload).rejects.toBe(reloadError);
    await expect(authWaiter).rejects.toBe(reloadError);
    await expect(loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" })).rejects.toThrow(
      "prepared reply dispatch runtime owner was not published for default",
    );

    await refreshPreparedModelRuntimeSnapshots(replacementConfig, { gatewayLifecycle: true });
    await expect(
      loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }),
    ).resolves.toMatchObject({ config: replacementConfig });
  });

  it("continues with a corrective auth mutation after the earlier build fails", async () => {
    mocks.configuredAgentIds = ["default"];
    const config = {};
    const agentDir = "/tmp/unused-agent";
    await refreshPreparedModelRuntimeSnapshots(config, { gatewayLifecycle: true });
    const firstBuild = createDeferred<{ agentDir: string; wrote: false }>();
    const secondBuild = createDeferred<{ agentDir: string; wrote: false }>();
    const firstError = new Error("superseded auth build failed");
    mocks.ensureOpenClawModelsJson
      .mockImplementationOnce(async () => await firstBuild.promise)
      .mockImplementationOnce(async () => await secondBuild.promise);

    mocks.mutationListener?.({ agentDir, affectsInheritedStores: false });
    await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2));
    const dispatch = loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" });
    void dispatch.catch(() => undefined);
    mocks.mutationListener?.({ agentDir, affectsInheritedStores: false });
    firstBuild.reject(firstError);
    await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(3));
    await expect(
      Promise.race([dispatch.then(() => "settled"), Promise.resolve("pending")]),
    ).resolves.toBe("pending");

    secondBuild.resolve({ agentDir, wrote: false });
    await expect(dispatch).resolves.toMatchObject({ agentId: "default", agentDir });
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("publishes an independent queued owner after another auth build fails", async () => {
    mocks.configuredAgentIds = ["default", "worker", "research"];
    const config = {};
    await refreshPreparedModelRuntimeSnapshots(config, { gatewayLifecycle: true });
    const workerBuild = createDeferred<{ agentDir: string; wrote: false }>();
    const researchBuild = createDeferred<{ agentDir: string; wrote: false }>();
    const workerError = new Error("worker auth build failed");
    mocks.ensureOpenClawModelsJson.mockImplementation(async (_config, agentDir) => {
      if (agentDir === "/tmp/configured-worker") {
        return await workerBuild.promise;
      }
      if (agentDir === "/tmp/configured-research") {
        return await researchBuild.promise;
      }
      return { agentDir: String(agentDir), wrote: false };
    });

    mocks.mutationListener?.({
      agentDir: "/tmp/configured-worker",
      affectsInheritedStores: false,
    });
    await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(4));
    const workerDispatch = loadPublishedGatewayReplyDispatchRuntime({ agentId: "worker" });
    void workerDispatch.catch(() => undefined);
    mocks.mutationListener?.({
      agentDir: "/tmp/configured-research",
      affectsInheritedStores: false,
    });
    const researchDispatch = loadPublishedGatewayReplyDispatchRuntime({ agentId: "research" });
    void researchDispatch.catch(() => undefined);
    workerBuild.reject(workerError);
    await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(5));
    await expect(workerDispatch).rejects.toBe(workerError);
    await expect(
      Promise.race([researchDispatch.then(() => "settled"), Promise.resolve("pending")]),
    ).resolves.toBe("pending");

    researchBuild.resolve({ agentDir: "/tmp/configured-research", wrote: false });
    await expect(researchDispatch).resolves.toMatchObject({
      agentId: "research",
      agentDir: "/tmp/configured-research",
    });
    await expect(loadPublishedGatewayReplyDispatchRuntime({ agentId: "worker" })).rejects.toThrow(
      "prepared reply dispatch runtime owner was not published for worker",
    );
    expect(mocks.warn).toHaveBeenCalledOnce();
    expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining(workerError.message));
  });
});
