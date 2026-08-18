import type { IncomingMessage, ServerResponse } from "node:http";

export function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(value));
}

export function sendText(
  response: ServerResponse,
  status: number,
  contentType: string,
  value: string,
): void {
  response.statusCode = status;
  response.setHeader("content-type", contentType);
  response.end(value);
}

export async function readJsonBody(
  request: IncomingMessage,
  maxBytes = 128 * 1024,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new Error("request_body_too_large");
    chunks.push(buffer);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("invalid_json_body");
  }
  return parsed as Record<string, unknown>;
}

export function requiredString(
  value: unknown,
  field: string,
  maxLength = 10_000,
): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new Error(`invalid_${field}`);
  }
  return value;
}
