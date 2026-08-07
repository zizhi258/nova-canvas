/**
 * Shared image response helpers for browser and relay generation clients.
 *
 * This module deliberately depends only on Web APIs that are available in the
 * browser and in the edge runtime.  Keeping the base64 decoder and MIME
 * detection here prevents each response adapter from drifting independently.
 */

export function detectImageMimeType(name: string, bytes: Uint8Array) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".webp") || (bytes[0] === 0x52 && bytes[1] === 0x49)) return "image/webp";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg") || (bytes[0] === 0xff && bytes[1] === 0xd8)) return "image/jpeg";
  return "image/png";
}

export function decodeBase64Image(value: string) {
  const normalized = value.includes(",") ? value.split(",").pop()! : value;
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
