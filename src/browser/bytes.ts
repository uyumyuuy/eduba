export function decodeBase64(value: string): Uint8Array {
  const binary = atob(value.includes(",") ? value.slice(value.indexOf(",") + 1) : value);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  }
  return btoa(binary);
}

export async function gzip(text: string): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
}

export async function gunzip(bytes: Uint8Array): Promise<string> {
  const reader = new Blob([new Uint8Array(bytes)]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 128 * 1024 * 1024) throw new Error("Edit history record exceeds 128 MiB.");
      chunks.push(value);
    }
    return await new Blob(chunks.map(chunk => new Uint8Array(chunk))).text();
  } finally { await reader.cancel(); }
}
