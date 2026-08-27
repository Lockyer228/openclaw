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
      });
    for (const owner of invalidatedOwners) {
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

  resolve(
    transaction: PreparedModelRuntimeAuthTransaction,
    owners: Map<string, PreparedModelRuntimeOwner>,
    entries?: readonly { owner: PreparedModelRuntimeOwner }[],
    publishOwners?: (owners: readonly PreparedModelRuntimeOwner[]) => void,
  ): boolean {
    if (this.#transaction !== transaction) {
      return false;
    }
    if (entries) {
      if (transaction.adoptedBy) {
        return false;
      }
      const completed = entries.flatMap(({ owner }) => {
        const gate = transaction.ownerGates.get(owner);
        return gate &&
          owner.pending === gate.promise &&
          owners.get(ownerKey(owner.input)) === owner &&
          owner.snapshot &&
          !owner.needsRefresh
          ? [{ owner, gate, snapshot: owner.snapshot }]
          : [];
      });
      if (completed.length === 0 || !publishOwners) {
        return false;
      }
      // Publish the replacement projection before releasing exact-gate waiters. If projection
      // construction fails, restoring pending keeps the failed generation unavailable.
      for (const { owner } of completed) {
        owner.pending = undefined;
      }
      try {
        publishOwners(completed.map(({ owner }) => owner));
      } catch (error) {
        for (const { owner, gate } of completed) {
          if (transaction.ownerGates.get(owner) === gate && owner.pending === undefined) {
            owner.pending = gate.promise;
          }
        }
        throw error;
      }
      for (const { owner, gate, snapshot } of completed) {
        if (transaction.ownerGates.get(owner) === gate) {
          transaction.ownerGates.delete(owner);
          gate.resolve(snapshot);
        }
      }
      return false;
    }
    if (transaction.adoptedBy) {
      this.#transaction = undefined;
    } else if (transaction.ownerGates.size === 0) {
      this.#transaction = undefined;
      return true;
    } else {
      return false;
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
    return true;
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
    publishOwners?: (owners: readonly PreparedModelRuntimeOwner[]) => void;
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
        continue;
      }
      const transaction = this.#transaction;
      if (transaction) {
        this.resolve(transaction, params.owners, entries, params.publishOwners);
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
