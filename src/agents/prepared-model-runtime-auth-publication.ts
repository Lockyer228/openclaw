import { createDeferredCore, type Deferred } from "../shared/deferred.js";
import { PreparedModelRuntimePublicationSupersededError } from "./prepared-model-runtime.errors.js";
import { ownerKey, resolveConfiguredOwner } from "./prepared-model-runtime.owner.js";
import type {
  PreparedModelRuntimeOwner,
  PreparedModelRuntimeReplacementGateId,
  PreparedModelRuntimeSnapshot,
} from "./prepared-model-runtime.types.js";

export type PreparedModelRuntimeAuthMutation = {
  agentDir?: string;
  affectsInheritedStores: boolean;
};

type PreparedModelRuntimeAuthTransaction = {
  adoptedBy?: PreparedModelRuntimeReplacementGateId;
  ownerGates: Map<PreparedModelRuntimeOwner, Deferred<PreparedModelRuntimeSnapshot>>;
  publicationQueued: boolean;
  readyOwners: Set<PreparedModelRuntimeOwner>;
};

export class PreparedModelRuntimeAuthPublicationOwner {
  readonly #events: PreparedModelRuntimeAuthMutation[] = [];
  #transaction: PreparedModelRuntimeAuthTransaction | undefined;

  enqueue(
    event: PreparedModelRuntimeAuthMutation,
    invalidatedOwners: readonly PreparedModelRuntimeOwner[],
  ): PreparedModelRuntimeAuthTransaction {
    this.#events.push(event);
    const transaction =
      this.#transaction ??
      (this.#transaction = {
        ownerGates: new Map(),
        publicationQueued: false,
        readyOwners: new Set(),
      });
    for (const owner of invalidatedOwners) {
      transaction.readyOwners.delete(owner);
      let gate = transaction.ownerGates.get(owner);
      if (!gate) {
        gate = createDeferredCore<PreparedModelRuntimeSnapshot>();
        transaction.ownerGates.set(owner, gate);
        void gate.promise.catch(() => undefined);
      }
      owner.pending = gate.promise;
    }
    return transaction;
  }

  claimPublication(transaction: PreparedModelRuntimeAuthTransaction): boolean {
    if (transaction.publicationQueued) {
      return false;
    }
    transaction.publicationQueued = true;
    return true;
  }

  isCurrent(transaction: PreparedModelRuntimeAuthTransaction): boolean {
    return this.#transaction === transaction;
  }

  adopt(gateId: PreparedModelRuntimeReplacementGateId): void {
    if (this.#transaction) {
      this.#transaction.adoptedBy = gateId;
    }
  }

  adoptTransaction(
    transaction: PreparedModelRuntimeAuthTransaction,
    gateId: PreparedModelRuntimeReplacementGateId,
  ): void {
    if (this.#transaction === transaction) {
      transaction.adoptedBy = gateId;
    }
  }

  prepareAdoptedCommit(
    gateId: PreparedModelRuntimeReplacementGateId,
  ): PreparedModelRuntimeAuthTransaction | undefined {
    const transaction = this.#transaction;
    if (transaction?.adoptedBy !== gateId) {
      return undefined;
    }
    this.clearOwnerGates(transaction);
    return transaction;
  }

  prepareCommit(transaction: PreparedModelRuntimeAuthTransaction): boolean {
    if (this.#transaction !== transaction) {
      return false;
    }
    this.clearOwnerGates(transaction);
    return true;
  }

  owners(transaction: PreparedModelRuntimeAuthTransaction): readonly PreparedModelRuntimeOwner[] {
    return [...transaction.ownerGates.keys()];
  }

  resolve(
    transaction: PreparedModelRuntimeAuthTransaction,
    owners: Map<string, PreparedModelRuntimeOwner>,
  ): void {
    if (this.#transaction === transaction) {
      this.#transaction = undefined;
    }
    this.clearOwnerGates(transaction);
    for (const [owner, gate] of transaction.ownerGates) {
      const published =
        owners.get(ownerKey(owner.input)) ?? resolveConfiguredOwner(owners, owner.input);
      if (published?.snapshot && !published.needsRefresh && !published.pending) {
        gate.resolve(published.snapshot);
      } else {
        gate.reject(
          new PreparedModelRuntimePublicationSupersededError(
            `prepared model runtime publication was superseded for ${owner.input.agentDir}`,
          ),
        );
      }
    }
  }

  reject(transaction: PreparedModelRuntimeAuthTransaction, error: Error): void {
    if (this.#transaction === transaction) {
      this.#transaction = undefined;
    }
    this.clearOwnerGates(transaction);
    for (const gate of transaction.ownerGates.values()) {
      gate.reject(error);
    }
  }

  rejectAdopted(gateId: PreparedModelRuntimeReplacementGateId, error: Error): void {
    if (this.#transaction?.adoptedBy === gateId) {
      this.reject(this.#transaction, error);
    }
  }

  async drain(params: {
    owners: Map<string, PreparedModelRuntimeOwner>;
    publish: (
      entries: Array<{
        owner: PreparedModelRuntimeOwner;
        input: PreparedModelRuntimeOwner["input"];
      }>,
    ) => Promise<void>;
    commit?: () => void;
    onOwnerFailure?: (error: unknown) => void;
  }): Promise<void> {
    while (this.#events.length > 0) {
      const events = this.#events.splice(0);
      const entries = [...params.owners.values()]
        .filter((owner) =>
          events.some(
            (event) =>
              event.affectsInheritedStores ||
              owner.input.agentDir === event.agentDir ||
              owner.input.inheritedAuthDir === event.agentDir,
          ),
        )
        .map((owner) => ({ owner, input: owner.input }));
      try {
        await params.publish(entries);
        for (const { owner } of entries) {
          if (!owner.needsRefresh) {
            this.#transaction?.readyOwners.add(owner);
          }
        }
      } catch (error) {
        if (this.#transaction?.adoptedBy) {
          // The replacement transaction exclusively settles adopted gates from its own result.
          throw error;
        }
        const failedOwners = entries.filter(
          ({ owner }) =>
            !this.#events.some(
              (event) =>
                event.affectsInheritedStores ||
                owner.input.agentDir === event.agentDir ||
                owner.input.inheritedAuthDir === event.agentDir,
            ),
        );
        for (const { owner } of failedOwners) {
          this.#transaction?.readyOwners.delete(owner);
          const gate = this.#transaction?.ownerGates.get(owner);
          if (gate) {
            if (owner.pending === gate.promise) {
              owner.pending = undefined;
            }
            this.#transaction?.ownerGates.delete(owner);
            gate.reject(error);
          }
        }
        if (failedOwners.length > 0) {
          params.onOwnerFailure?.(error);
        }
        // Newer events remain owned by this worker even when they target independent owners.
        if (this.#events.length === 0 && this.#transaction?.readyOwners.size === 0) {
          throw error;
        }
      }
    }
    // The queue check and commit share one synchronous section so no mutation can be orphaned.
    params.commit?.();
  }

  reset(error: Error): void {
    if (this.#transaction) {
      this.reject(this.#transaction, error);
    }
    this.#events.length = 0;
  }

  private clearOwnerGates(transaction: PreparedModelRuntimeAuthTransaction): void {
    for (const [owner, gate] of transaction.ownerGates) {
      if (owner.pending === gate.promise) {
        owner.pending = undefined;
      }
    }
  }
}
