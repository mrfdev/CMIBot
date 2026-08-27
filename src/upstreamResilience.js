const TEMPORARY_HTTP_STATUSES = new Set([408, 425, 429]);
const MAX_TRACKED_CIRCUITS = 256;

function defaultSleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function normalizePositiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    return fallback;
  }
  return Math.min(number, maximum);
}

function normalizeNonNegativeInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    return fallback;
  }
  return Math.min(number, maximum);
}

function isTemporaryHttpStatus(status) {
  return TEMPORARY_HTTP_STATUSES.has(status) || (status >= 500 && status <= 599);
}

export class UpstreamHttpError extends Error {
  constructor(status, { retryAfterMs = 0 } = {}) {
    super(`Upstream request failed with HTTP ${status}.`);
    this.name = "UpstreamHttpError";
    this.status = Number(status);
    this.retryAfterMs = normalizeNonNegativeInteger(retryAfterMs, 0);
    this.temporary = isTemporaryHttpStatus(this.status);
  }
}

export class UpstreamCircuitOpenError extends Error {
  constructor() {
    super("The upstream circuit is temporarily open.");
    this.name = "UpstreamCircuitOpenError";
    this.code = "UPSTREAM_CIRCUIT_OPEN";
    this.temporary = true;
  }
}

export function parseRetryAfter(value, nowMs = Date.now()) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    return 0;
  }

  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    return Math.max(0, Math.ceil(Number(trimmed) * 1000));
  }

  const retryAt = Date.parse(trimmed);
  return Number.isFinite(retryAt) ? Math.max(0, retryAt - nowMs) : 0;
}

export function isTemporaryUpstreamError(error) {
  if (typeof error?.temporary === "boolean") {
    return error.temporary;
  }
  if (["AbortError", "TimeoutError", "TypeError"].includes(error?.name)) {
    return true;
  }
  if (
    [
      "ECONNABORTED",
      "ECONNREFUSED",
      "ECONNRESET",
      "EHOSTUNREACH",
      "ENETDOWN",
      "ENETUNREACH",
      "ENOTFOUND",
      "ETIMEDOUT",
    ].includes(error?.code)
  ) {
    return true;
  }

  // This helper wraps only network transport and response-body reads. Unknown
  // errors at that boundary are treated as transient; semantic validation runs
  // after the resilient request and therefore still fails immediately.
  return true;
}

function retryReason(error) {
  if (error instanceof UpstreamHttpError) {
    return "http";
  }
  if (["AbortError", "TimeoutError"].includes(error?.name) || error?.code === "ETIMEDOUT") {
    return "timeout";
  }
  return "network";
}

export function createUpstreamResilience(options = {}) {
  const maxAttempts = normalizePositiveInteger(options.maxAttempts, 3, 5);
  const baseDelayMs = normalizeNonNegativeInteger(options.baseDelayMs, 250, 60_000);
  const maxDelayMs = Math.max(
    baseDelayMs,
    normalizeNonNegativeInteger(options.maxDelayMs, 2_000, 60_000),
  );
  const failureThreshold = normalizePositiveInteger(options.failureThreshold, 3, 100);
  const cooldownMs = normalizePositiveInteger(options.cooldownMs, 300_000, 86_400_000);
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const logger = options.logger;
  const metrics = options.metrics;
  const circuits = new Map();

  function getCircuit(key) {
    if (circuits.has(key)) {
      return circuits.get(key);
    }
    if (circuits.size >= MAX_TRACKED_CIRCUITS) {
      return null;
    }
    const circuit = {
      state: "closed",
      consecutiveFailures: 0,
      openedAt: 0,
      probeInFlight: false,
    };
    circuits.set(key, circuit);
    return circuit;
  }

  function acquire(circuit) {
    if (!circuit) {
      return true;
    }
    if (circuit.state === "closed") {
      return true;
    }
    if (circuit.state === "open") {
      if (now() - circuit.openedAt < cooldownMs) {
        metrics?.recordUpstreamCircuit?.({ outcome: "rejected" });
        return false;
      }
      circuit.state = "half-open";
      circuit.probeInFlight = false;
      logger?.info?.("versions.circuit_half_opened");
    }
    if (circuit.probeInFlight) {
      metrics?.recordUpstreamCircuit?.({ outcome: "rejected" });
      return false;
    }
    circuit.probeInFlight = true;
    return true;
  }

  function recordSuccess(circuit) {
    if (!circuit) {
      return;
    }
    const recovered = circuit.state !== "closed";
    circuit.state = "closed";
    circuit.consecutiveFailures = 0;
    circuit.openedAt = 0;
    circuit.probeInFlight = false;
    if (recovered) {
      metrics?.recordUpstreamCircuit?.({ outcome: "closed" });
      logger?.info?.("versions.circuit_closed");
    }
  }

  function recordTemporaryFailure(circuit) {
    if (!circuit) {
      return;
    }
    circuit.probeInFlight = false;
    circuit.consecutiveFailures += 1;
    if (circuit.state === "half-open" || circuit.consecutiveFailures >= failureThreshold) {
      circuit.state = "open";
      circuit.openedAt = now();
      metrics?.recordUpstreamCircuit?.({ outcome: "opened" });
      logger?.warn?.("versions.circuit_opened", {
        consecutiveFailures: circuit.consecutiveFailures,
        cooldownMs,
      });
    }
  }

  function calculateDelay(attempt, error) {
    const exponentialDelay = Math.min(maxDelayMs, baseDelayMs * (2 ** (attempt - 1)));
    const boundedRandom = Math.max(0, Math.min(1, Number(random()) || 0));
    const jitteredDelay = Math.round(exponentialDelay * (0.75 + boundedRandom * 0.5));
    const retryAfterMs = Math.min(maxDelayMs, normalizeNonNegativeInteger(error?.retryAfterMs, 0));
    return Math.min(maxDelayMs, Math.max(jitteredDelay, retryAfterMs));
  }

  async function execute(key, operation) {
    const circuit = getCircuit(String(key));
    if (!acquire(circuit)) {
      throw new UpstreamCircuitOpenError();
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const result = await operation({ attempt });
        recordSuccess(circuit);
        return result;
      } catch (error) {
        const temporary = isTemporaryUpstreamError(error);
        if (!temporary) {
          recordSuccess(circuit);
          throw error;
        }
        if (attempt >= maxAttempts) {
          recordTemporaryFailure(circuit);
          throw error;
        }

        const delayMs = calculateDelay(attempt, error);
        metrics?.recordUpstreamRetry?.();
        logger?.warn?.("versions.upstream_retry", {
          attempt,
          delayMs,
          reason: retryReason(error),
          ...(Number.isSafeInteger(error?.status) ? { statusCode: error.status } : {}),
        });
        if (delayMs > 0) {
          await sleep(delayMs);
        }
      }
    }

    throw new Error("Upstream retry loop ended unexpectedly.");
  }

  function getSnapshot() {
    let open = 0;
    let halfOpen = 0;
    for (const circuit of circuits.values()) {
      if (circuit.state === "open") {
        open += 1;
      } else if (circuit.state === "half-open") {
        halfOpen += 1;
      }
    }
    return {
      tracked: circuits.size,
      open,
      halfOpen,
    };
  }

  return {
    execute,
    getSnapshot,
  };
}
