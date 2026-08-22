export function installGracefulShutdown({
  stop,
  processTarget = process,
  log = (message) => console.log(message),
  logError = (message, error) => console.error(message, error),
  signals = ["SIGINT", "SIGTERM"],
} = {}) {
  if (typeof stop !== "function") {
    throw new TypeError("installGracefulShutdown requires a stop function.");
  }

  let shutdownPromise = null;
  const handlers = new Map();

  const beginShutdown = (signal) => {
    if (shutdownPromise) {
      return shutdownPromise;
    }

    log(`Received ${signal}; shutting down.`);
    shutdownPromise = Promise.resolve()
      .then(() => stop(signal))
      .then(() => {
        log("LookupBot stopped cleanly.");
        processTarget.exit(0);
      })
      .catch((error) => {
        logError("LookupBot shutdown failed.", error);
        processTarget.exit(1);
      });
    return shutdownPromise;
  };

  for (const signal of signals) {
    const handler = () => {
      void beginShutdown(signal);
    };
    handlers.set(signal, handler);
    processTarget.on(signal, handler);
  }

  return () => {
    for (const [signal, handler] of handlers) {
      processTarget.off(signal, handler);
    }
  };
}
