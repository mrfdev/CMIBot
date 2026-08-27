import { serviceLogger } from "./logger.js";

export function isAiEnabled(config) {
  return Boolean(config?.enabled && config?.apiKey);
}

export function createLazyAiResolver(
  config,
  { loadAiModule = () => import("./ai.js"), logger = serviceLogger, metrics } = {},
) {
  let rerankerPromise = null;

  return async function resolveAiReranker() {
    if (!isAiEnabled(config)) {
      return null;
    }

    if (!rerankerPromise) {
      rerankerPromise = loadAiModule()
        .then(({ AiReranker }) => new AiReranker(config, { metrics }))
        .catch((error) => {
          logger.warn("ai.module_load_failed", { error });
          return null;
        });
    }

    return rerankerPromise;
  };
}
