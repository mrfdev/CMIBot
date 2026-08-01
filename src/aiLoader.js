export function isAiEnabled(config) {
  return Boolean(config?.enabled && config?.apiKey);
}

export function createLazyAiResolver(config, { loadAiModule = () => import("./ai.js") } = {}) {
  let rerankerPromise = null;

  return async function resolveAiReranker() {
    if (!isAiEnabled(config)) {
      return null;
    }

    if (!rerankerPromise) {
      rerankerPromise = loadAiModule()
        .then(({ AiReranker }) => new AiReranker(config))
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(`[LookupBot] OpenAI module could not be loaded: ${message}`);
          return null;
        });
    }

    return rerankerPromise;
  };
}
