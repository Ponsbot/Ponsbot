export class RequestBodyError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export async function boundedJson<T>(request: Request, maximumBytes: number): Promise<T> {
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximumBytes)) {
    throw new RequestBodyError("request too large", 413);
  }
  if (!request.body) throw new RequestBodyError("request body is required", 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximumBytes) {
      await reader.cancel();
      throw new RequestBodyError("request too large", 413);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)) as T; }
  catch { throw new RequestBodyError("invalid JSON request", 400); }
}
