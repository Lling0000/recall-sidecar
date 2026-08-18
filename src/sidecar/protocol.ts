import type { SidecarRequest } from "../types.js";

const REQUEST_KEYS = {
  dashboard_bootstrap: ["type"],
  session_start: ["type", "client", "session_id", "cwd", "transcript_path"],
  recall: ["type", "client", "session_id", "turn_id", "cwd", "prompt"],
  stop: ["type", "client", "session_id", "turn_id", "transcript_path", "cwd"],
} as const;

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`invalid_${name}`);
  }
  return value;
}

export function parseSidecarRequest(value: unknown): SidecarRequest {
  const record = objectValue(value);
  if (!record) throw new Error("invalid_request");
  const type = requiredString(record.type, "type");
  if (!(type in REQUEST_KEYS)) throw new Error("invalid_type");
  const allowed = new Set(REQUEST_KEYS[type as keyof typeof REQUEST_KEYS]);
  if (Object.keys(record).some((key) => !allowed.has(key as never))) {
    throw new Error("unexpected_request_field");
  }
  if (type === "dashboard_bootstrap") return { type };
  if (record.client !== "codex") throw new Error("invalid_client");
  const shared = {
    client: "codex" as const,
    session_id: requiredString(record.session_id, "session_id"),
    cwd: requiredString(record.cwd, "cwd"),
  };
  if (type === "session_start") {
    const transcript = record.transcript_path;
    if (transcript !== undefined && typeof transcript !== "string") {
      throw new Error("invalid_transcript_path");
    }
    return transcript === undefined
      ? { type, ...shared }
      : { type, ...shared, transcript_path: transcript };
  }
  if (type === "recall") {
    return {
      type,
      ...shared,
      turn_id: requiredString(record.turn_id, "turn_id"),
      prompt: requiredString(record.prompt, "prompt"),
    };
  }
  return {
    type: "stop",
    ...shared,
    turn_id: requiredString(record.turn_id, "turn_id"),
    transcript_path: requiredString(record.transcript_path, "transcript_path"),
  };
}
