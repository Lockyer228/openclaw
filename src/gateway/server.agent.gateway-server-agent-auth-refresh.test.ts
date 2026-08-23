import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { WebSocket } from "ws";
import { createDeferred } from "../../test/helpers/promise.js";
import { resolveAgentDir } from "../agents/agent-scope.js";
import { setRuntimeAuthProfileStoreSnapshot } from "../agents/auth-profiles/runtime-snapshots.js";
import {
  loadPublishedGatewayReplyDispatchRuntime,
  registerPreparedModelRuntimePublicationListener,
} from "../agents/prepared-model-runtime.js";
import { installConnectedSessionStoreGatewaySuite } from "./test-helpers.connected-session-store.js";
import {
  agentCommandMock,
  agentDiscoveryMock,
  installGatewayTestHooks,
  onceMessage,
  prepareGatewayReplyRuntimeForTest,
  testState,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const gatewaySuite = installConnectedSessionStoreGatewaySuite("openclaw-gw-auth-refresh-", {
  client: {
    id: "gateway-client",
    version: "1.0.0",
    platform: "test",
    mode: "backend",
  },
});

type AgentRpcFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: { runId?: string; status?: string };
  error?: { code?: string; message?: string };
};

function sendAgentRpc(socket: WebSocket, params: { agentId: string; runId: string }) {
  const accepted = onceMessage<AgentRpcFrame>(
    socket,
    (frame) =>
      frame.type === "res" && frame.id === params.runId && frame.payload?.status === "accepted",
  );
  const final = onceMessage<AgentRpcFrame>(
    socket,
    (frame) =>
      frame.type === "res" && frame.id === params.runId && frame.payload?.status !== "accepted",
  );
  socket.send(
    JSON.stringify({
      type: "req",
      id: params.runId,
      method: "agent",
      params: {
        agentId: params.agentId,
        message: `dispatch ${params.runId}`,
        idempotencyKey: params.runId,
      },
    }),
  );
  return { accepted, final };
}

function agentCommandCallsFor(runId: string) {
  return vi
    .mocked(agentCommandMock)
    .mock.calls.filter(([options]) => (options as { runId?: string }).runId === runId);
}

async function prepareAuthDispatchAgents(affectedAgentId: string) {
  testState.agentsConfig = {
    list: [{ id: "main", default: true }, { id: affectedAgentId }],
  };
  agentDiscoveryMock.enabled = true;
  agentDiscoveryMock.models = [{ id: "claude-opus-4-6", provider: "anthropic", input: ["text"] }];
  const { clearConfigCache, clearRuntimeConfigSnapshot, getRuntimeConfig } =
    await import("../config/io.js");
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  await prepareGatewayReplyRuntimeForTest({ force: true });
  const config = getRuntimeConfig();
  return {
    agentDir: resolveAgentDir(config, affectedAgentId),
    runtime: await loadPublishedGatewayReplyDispatchRuntime({ agentId: affectedAgentId }),
  };
}

describe("gateway agent auth refresh dispatch", () => {
  beforeEach(() => {
    vi.mocked(agentCommandMock).mockClear();
  });

  afterEach(() => {
    testState.agentsConfig = undefined;
  });

  test("waits for an affected auth generation without blocking siblings", async () => {
    const affectedAgentId = "auth-wait";
    const affectedRunId = "idem-agent-auth-wait";
    const siblingRunId = "idem-agent-auth-sibling";
    const before = await prepareAuthDispatchAgents(affectedAgentId);
    const publicationGate = createDeferred<{ agentDir: string; wrote: false }>();
    const modelsConfig = await import("../agents/models-config.js");
    const ensureOpenClawModelsJson = modelsConfig.ensureOpenClawModelsJson;
    const ensureSpy = vi
      .spyOn(modelsConfig, "ensureOpenClawModelsJson")
      .mockImplementation(async (config, agentDir, options) =>
        agentDir === before.agentDir
          ? await publicationGate.promise
          : await ensureOpenClawModelsJson(config, agentDir, options),
      );
    const published = createDeferred();
    const unregister = registerPreparedModelRuntimePublicationListener((event) => {
      if (event.phase === "published") {
        published.resolve();
      }
    });
    try {
      setRuntimeAuthProfileStoreSnapshot(
        {
          version: 1,
          profiles: {
            "anthropic:default": {
              type: "api_key",
              provider: "anthropic",
              key: "fresh-generation-key",
            },
          },
        },
        before.agentDir,
      );

      const affected = sendAgentRpc(gatewaySuite.ws, {
        agentId: affectedAgentId,
        runId: affectedRunId,
      });
      await affected.accepted;
      const sibling = sendAgentRpc(gatewaySuite.ws, { agentId: "main", runId: siblingRunId });
      await sibling.accepted;
      await expect(sibling.final).resolves.toMatchObject({ ok: true, payload: { status: "ok" } });
      expect(agentCommandCallsFor(siblingRunId)).toHaveLength(1);
      expect(agentCommandCallsFor(affectedRunId)).toHaveLength(0);
      await expect(
        Promise.race([affected.final.then(() => "settled"), Promise.resolve("pending")]),
      ).resolves.toBe("pending");

      publicationGate.resolve({ agentDir: before.agentDir, wrote: false });
      await published.promise;
      const after = await loadPublishedGatewayReplyDispatchRuntime({ agentId: affectedAgentId });
      expect(after).not.toBe(before.runtime);
      await expect(affected.final).resolves.toMatchObject({
        ok: true,
        payload: { status: "ok" },
      });
      const affectedCalls = agentCommandCallsFor(affectedRunId);
      expect(affectedCalls).toHaveLength(1);
      expect(affectedCalls[0]?.[4]).toMatchObject({
        config: after?.config,
        pluginGeneration: after?.pluginGeneration,
      });
    } finally {
      unregister();
      ensureSpy.mockRestore();
    }
  });

  test("never reuses an affected projection after auth publication rejects", async () => {
    const affectedAgentId = "auth-reject";
    const runId = "idem-agent-auth-reject";
    const before = await prepareAuthDispatchAgents(affectedAgentId);
    const modelsConfig = await import("../agents/models-config.js");
    const ensureOpenClawModelsJson = modelsConfig.ensureOpenClawModelsJson;
    const ensureSpy = vi
      .spyOn(modelsConfig, "ensureOpenClawModelsJson")
      .mockImplementation(async (config, agentDir, options) => {
        if (agentDir === before.agentDir) {
          throw new Error("auth publication rejected");
        }
        return await ensureOpenClawModelsJson(config, agentDir, options);
      });
    const failed = createDeferred();
    const unregister = registerPreparedModelRuntimePublicationListener((event) => {
      if (event.phase === "failed") {
        failed.resolve();
      }
    });
    try {
      setRuntimeAuthProfileStoreSnapshot(
        {
          version: 1,
          profiles: {
            "anthropic:default": {
              type: "api_key",
              provider: "anthropic",
              key: "rejected-generation-key",
            },
          },
        },
        before.agentDir,
      );
      await failed.promise;
      await expect(
        loadPublishedGatewayReplyDispatchRuntime({ agentId: affectedAgentId }),
      ).rejects.toThrow(
        `prepared reply dispatch runtime owner was not published for ${affectedAgentId}`,
      );

      const dispatched = sendAgentRpc(gatewaySuite.ws, { agentId: affectedAgentId, runId });
      await expect(dispatched.accepted).resolves.toMatchObject({
        ok: true,
        payload: { status: "accepted" },
      });
      await expect(dispatched.final).resolves.toMatchObject({
        ok: false,
        payload: { status: "error" },
        error: {
          code: "UNAVAILABLE",
          message: expect.stringContaining(
            `prepared reply dispatch runtime owner was not published for ${affectedAgentId}`,
          ),
        },
      });
      expect(agentCommandCallsFor(runId)).toHaveLength(0);
    } finally {
      unregister();
      ensureSpy.mockRestore();
    }
  });
});
