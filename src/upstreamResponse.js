export const MAX_UPSTREAM_RESPONSE_BYTES = 1024 * 1024;

function permanentUpstreamError(message) {
  const error = new Error(message);
  error.temporary = false;
  return error;
}

export function upstreamResponseSizeError(label = "Upstream metadata") {
  return permanentUpstreamError(`${label} response exceeded the size limit.`);
}

export async function readBoundedResponseText(
  response,
  {
    label = "Upstream metadata",
    maxBytes = MAX_UPSTREAM_RESPONSE_BYTES,
  } = {},
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("The upstream response byte limit is invalid.");
  }

  const declaredLengthHeader = response.headers?.get?.("content-length");
  const declaredLength = declaredLengthHeader == null
    ? Number.NaN
    : Number(declaredLengthHeader);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel?.().catch(() => {});
    throw upstreamResponseSizeError(label);
  }

  const reader = response.body?.getReader?.();
  if (!reader) {
    throw permanentUpstreamError(`${label} response was not stream-readable.`);
  }

  const chunks = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      byteLength += value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel().catch(() => {});
        throw upstreamResponseSizeError(label);
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, byteLength).toString("utf8");
}

export async function readBoundedResponseJson(response, options = {}) {
  const label = options.label ?? "Upstream metadata";
  const text = await readBoundedResponseText(response, options);
  try {
    return JSON.parse(text);
  } catch {
    throw permanentUpstreamError(`${label} response was not valid JSON.`);
  }
}
