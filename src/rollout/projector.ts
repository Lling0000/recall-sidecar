import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import {
  ROLLOUT_PROJECTION_VERSION,
  SUPPORTED_CODEX_CLI_VERSIONS,
} from "../constants.js";
import type { RolloutProjection } from "../types.js";

type ProjectionFailureCode =
  | "invalid_jsonl"
  | "unsupported_cli_version"
  | "fixture_mismatch"
  | "subagent"
  | "turn_not_found"
  | "incomplete_turn"
  | "missing_user_prompt"
  | "missing_final_answer";

export class ProjectionError extends Error {
  readonly code: ProjectionFailureCode;

  constructor(code: ProjectionFailureCode) {
    super(code);
    this.name = "ProjectionError";
    this.code = code;
  }
}

interface SessionMetaProjection {
  sessionId: string;
  cliVersion: string;
  isSubagent: boolean;
}

interface WindowProjection {
  turnId: string;
  complete: boolean;
  userPrompt: string | null;
  finalAnswer: string | null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function normalizedMessage(value: unknown): string | null {
  const message = stringValue(value)?.trim();
  return message ? message : null;
}

function isEnvironmentContext(message: string): boolean {
  return message.startsWith("<environment_context");
}

function canonicalDigest(projection: {
  sessionId: string;
  turnId: string;
  userPrompt: string;
  finalAnswer: string;
  previousUserPrompt: string | null;
}): string {
  return createHash("sha256").update(JSON.stringify(projection)).digest("hex");
}

/**
 * Reads JSONL one record at a time and immediately narrows every record to the
 * exact rollout fields allowed by Spec 3.3. Unknown record types and all other
 * payload keys are discarded and never returned or logged.
 */
export async function projectRollout(
  transcriptPath: string,
  expectedSessionId: string,
  expectedTurnId: string,
): Promise<RolloutProjection> {
  const [projection] = await projectRollouts(transcriptPath, expectedSessionId, [
    expectedTurnId,
  ]);
  if (!projection) throw new ProjectionError("turn_not_found");
  return projection;
}

export async function projectRollouts(
  transcriptPath: string,
  expectedSessionId: string,
  expectedTurnIds: readonly string[],
): Promise<RolloutProjection[]> {
  const expectedTurns = new Set(expectedTurnIds);
  if (expectedTurns.size !== expectedTurnIds.length || expectedTurns.size === 0) {
    throw new ProjectionError("turn_not_found");
  }
  let sessionMeta: SessionMetaProjection | null = null;
  const completedWindows: WindowProjection[] = [];
  let currentWindow: WindowProjection | null = null;
  let sawTaskShape = false;

  const input = createReadStream(transcriptPath, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });

  try {
    for await (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      let record: Record<string, unknown>;
      try {
        const parsed = objectValue(JSON.parse(line));
        if (!parsed) throw new Error("record_not_object");
        record = parsed;
      } catch {
        throw new ProjectionError("invalid_jsonl");
      }

      const recordType = stringValue(record.type);
      const payload = objectValue(record.payload);
      if (!payload) continue;

      if (recordType === "session_meta") {
        const sessionId = stringValue(payload.id);
        const cliVersion = stringValue(payload.cli_version);
        if (!sessionId || !cliVersion) {
          throw new ProjectionError("fixture_mismatch");
        }
        const threadSource = stringValue(payload.thread_source);
        const source = stringValue(payload.source);
        sessionMeta = {
          sessionId,
          cliVersion,
          isSubagent:
            threadSource !== "user" ||
            source === "subagent" ||
            payload.inter_agent_communication_metadata !== undefined,
        };
        continue;
      }

      if (recordType !== "event_msg") continue;
      const eventType = stringValue(payload.type);

      if (eventType === "task_started") {
        const turnId = stringValue(payload.turn_id);
        if (!turnId) throw new ProjectionError("fixture_mismatch");
        sawTaskShape = true;
        if (currentWindow && expectedTurns.has(currentWindow.turnId)) {
          throw new ProjectionError("incomplete_turn");
        }
        currentWindow = {
          turnId,
          complete: false,
          userPrompt: null,
          finalAnswer: null,
        };
        continue;
      }

      if (!currentWindow) continue;

      if (eventType === "user_message") {
        const message = normalizedMessage(payload.message);
        if (message && !isEnvironmentContext(message)) {
          currentWindow.userPrompt = message;
        }
        continue;
      }

      if (
        eventType === "agent_message" &&
        stringValue(payload.phase) === "final_answer"
      ) {
        const message = normalizedMessage(payload.message);
        if (message) currentWindow.finalAnswer = message;
        continue;
      }

      if (eventType === "task_complete") {
        const turnId = stringValue(payload.turn_id);
        if (!turnId) throw new ProjectionError("fixture_mismatch");
        sawTaskShape = true;
        if (turnId !== currentWindow.turnId) {
          if (expectedTurns.has(currentWindow.turnId) || expectedTurns.has(turnId)) {
            throw new ProjectionError("incomplete_turn");
          }
          currentWindow = null;
          continue;
        }
        currentWindow.complete = true;
        completedWindows.push(currentWindow);
        currentWindow = null;
      }
    }
  } catch (error) {
    input.destroy();
    if (error instanceof ProjectionError) throw error;
    throw new ProjectionError("invalid_jsonl");
  }

  if (!sessionMeta || !sawTaskShape) {
    throw new ProjectionError("fixture_mismatch");
  }
  if (sessionMeta.sessionId !== expectedSessionId) {
    throw new ProjectionError("turn_not_found");
  }
  if (
    !SUPPORTED_CODEX_CLI_VERSIONS.includes(
      sessionMeta.cliVersion as (typeof SUPPORTED_CODEX_CLI_VERSIONS)[number],
    )
  ) {
    throw new ProjectionError("unsupported_cli_version");
  }
  if (sessionMeta.isSubagent) throw new ProjectionError("subagent");

  return expectedTurnIds.map((expectedTurnId) => {
    const targetIndex = completedWindows.findIndex(
      (window) => window.turnId === expectedTurnId,
    );
    if (targetIndex < 0) {
      if (currentWindow?.turnId === expectedTurnId) {
        throw new ProjectionError("incomplete_turn");
      }
      throw new ProjectionError("turn_not_found");
    }
    const target = completedWindows[targetIndex];
    if (!target?.userPrompt) throw new ProjectionError("missing_user_prompt");
    if (!target.finalAnswer) throw new ProjectionError("missing_final_answer");
    const previousUserPrompt =
      targetIndex > 0 ? (completedWindows[targetIndex - 1]?.userPrompt ?? null) : null;
    const digestInput = {
      sessionId: expectedSessionId,
      turnId: expectedTurnId,
      userPrompt: target.userPrompt,
      finalAnswer: target.finalAnswer,
      previousUserPrompt,
    };
    return {
      cliVersion: sessionMeta.cliVersion,
      sessionId: expectedSessionId,
      turnId: expectedTurnId,
      userPrompt: target.userPrompt,
      finalAnswer: target.finalAnswer,
      previousUserPrompt,
      projectionVersion: ROLLOUT_PROJECTION_VERSION,
      sourceDigest: canonicalDigest(digestInput),
    };
  });
}
