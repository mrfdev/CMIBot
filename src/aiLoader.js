import { serviceLogger } from "./logger.js";

export function isAiEnabled(config) {
  return Boolean(config?.enabled);
}

export function createLazyAiResolver(
  config,
  {
    loadAiModule = () => import("./groundedAi.js"),
    logger = serviceLogger,
    metrics,
    ...serviceOptions
  } = {},
) {
  let servicePromise = null;

  return async function resolveAiService() {
    if (!isAiEnabled(config)) {
      return null;
    }

    if (!servicePromise) {
      servicePromise = loadAiModule()
        .then(({ GroundedAiService }) => new GroundedAiService(config, {
          metrics,
          logger,
          ...serviceOptions,
        }))
        .catch((error) => {
          logger.warn("ai.module_load_failed", { error });
          return null;
        });
    }

    return servicePromise;
  };
}
