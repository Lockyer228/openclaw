import { createDeferredCore } from "../shared/deferred.js";

export type RuntimeConfigWriteApplicationStatus = "applied" | "superseded" | "failed" | "stopped";

export type RuntimeConfigWriteApplicationClaim = {
  settle: (status: RuntimeConfigWriteApplicationStatus) => void;
};

type RuntimeConfigWriteApplication = {
  result: Promise<RuntimeConfigWriteApplicationStatus>;
  readonly claimed: boolean;
  claim: () => RuntimeConfigWriteApplicationClaim | null;
};

const runtimeConfigWriteApplications = new WeakMap<object, RuntimeConfigWriteApplication>();

/** Creates a single-owner receipt for one persisted config write. */
export function createRuntimeConfigWriteApplication(): RuntimeConfigWriteApplication {
  let claimed = false;
  const result = createDeferredCore<RuntimeConfigWriteApplicationStatus>();
  return {
    result: result.promise,
    get claimed() {
      return claimed;
    },
    claim: () => {
      if (claimed) {
        return null;
      }
      claimed = true;
      return { settle: result.resolve };
    },
  };
}

/** Attaches a private application receipt without changing the config notification contract. */
export function attachRuntimeConfigWriteApplication<T extends object>(
  target: T,
  application: RuntimeConfigWriteApplication | undefined,
): T {
  if (application) {
    runtimeConfigWriteApplications.set(target, application);
  }
  return target;
}

/** Returns the private application receipt attached to a write or notification. */
export function getRuntimeConfigWriteApplication(
  target: object,
): RuntimeConfigWriteApplication | undefined {
  return runtimeConfigWriteApplications.get(target);
}
