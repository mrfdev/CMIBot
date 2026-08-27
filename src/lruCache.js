function normalizeMaximumSize(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export function createBoundedLruCache(maximumSize) {
  const maxSize = normalizeMaximumSize(maximumSize);
  const values = new Map();

  return {
    get(key) {
      if (!values.has(key)) {
        return { hit: false, value: undefined };
      }

      const value = values.get(key);
      values.delete(key);
      values.set(key, value);
      return { hit: true, value };
    },
    set(key, value) {
      if (maxSize === 0) {
        return { stored: false, evicted: false };
      }

      if (values.has(key)) {
        values.delete(key);
      }
      values.set(key, value);

      let evicted = false;
      if (values.size > maxSize) {
        const leastRecentlyUsedKey = values.keys().next().value;
        values.delete(leastRecentlyUsedKey);
        evicted = true;
      }

      return { stored: true, evicted };
    },
    clear() {
      const removed = values.size;
      values.clear();
      return removed;
    },
    get size() {
      return values.size;
    },
    get maxSize() {
      return maxSize;
    },
  };
}
