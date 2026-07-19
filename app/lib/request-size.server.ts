export class RequestSizeLimitError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Request body exceeds the ${maxBytes}-byte limit.`);
    this.name = "RequestSizeLimitError";
  }
}

export async function readFormDataWithinLimit(
  request: Request,
  maxBytes: number,
) {
  const declaredLength = readContentLength(request);

  if (declaredLength !== null && declaredLength > maxBytes) {
    throw new RequestSizeLimitError(maxBytes);
  }

  if (!request.body) {
    return request.formData();
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  for (
    let result = await reader.read();
    !result.done;
    result = await reader.read()
  ) {
    const { value } = result;
    totalBytes += value.byteLength;

    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new RequestSizeLimitError(maxBytes);
    }

    chunks.push(value);
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;

  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const contentType = request.headers.get("content-type");

  if (!contentType) {
    throw new Error("Form submission is missing its Content-Type header.");
  }

  return new Response(body, {
    headers: { "Content-Type": contentType },
  }).formData();
}

function readContentLength(request: Request) {
  const value = request.headers.get("content-length");

  if (!value) return null;
  const bytes = Number(value);

  return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
}
