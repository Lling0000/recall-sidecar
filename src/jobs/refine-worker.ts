import type { MemoryDatabase } from "../db/database.js";
import { ModelError } from "../model/error.js";
import { SessionRefineClient } from "../model/session-client.js";
import type {
  CheckpointTurnSource,
  SessionTurnContext,
} from "../model/session-types.js";
import type { ApiKeyProvider } from "../model/types.js";
import { ProjectionError, projectRollouts } from "../rollout/projector.js";

export class RefineWorker {
  private running: Promise<void> | null = null;
  private wakeRequested = false;
  private readonly client: SessionRefineClient;

  constructor(
    private readonly database: MemoryDatabase,
    private readonly keyProvider: ApiKeyProvider,
    client?: SessionRefineClient,
  ) {
    this.client = client ?? new SessionRefineClient();
  }

  wake(): void {
    this.wakeRequested = true;
    if (this.running) return;
    this.running = this.drain().finally(() => {
      this.running = null;
      if (this.wakeRequested) this.wake();
    });
  }

  async idle(): Promise<void> {
    await this.running;
  }

  private async drain(): Promise<void> {
    while (this.wakeRequested) {
      this.wakeRequested = false;
      let job = this.database.sessionRefines.claimNext();
      while (job) {
        await this.process(job);
        job = this.database.sessionRefines.claimNext();
      }
    }
  }

  private async process(
    job: NonNullable<ReturnType<MemoryDatabase["sessionRefines"]["claimNext"]>>,
  ): Promise<void> {
    try {
      if (!this.database.extractionEnabled()) {
        throw new WorkerError("auto_extract_disabled");
      }
      const configuration = this.database.modelSettings.getConfiguration();
      const apiKey = await this.keyProvider.get();
      if (!configuration || !apiKey) throw new WorkerError("model_not_configured");
      const batch = this.database.sessionRefines.batch(job);
      const eligible = batch.turns.filter((turn) => turn.role === "eligible");
      if (eligible.length === 0) {
        this.database.sessionRefines.finish(job.jobId, new Set(), false);
        return;
      }

      const projections = await projectRollouts(
        job.transcriptPath,
        job.nativeSessionRef,
        batch.turns.map((turn) => turn.turn_id),
      );
      const turns: SessionTurnContext[] = projections.map((projection) => ({
        turn_id: projection.turnId,
        user_prompt: projection.userPrompt,
        final_answer: projection.finalAnswer,
      }));
      const activeMemories = this.database
        .listMemories(job.repoId)
        .filter((memory) => memory.state === "active")
        .map((memory) => ({
          id: memory.id,
          version: memory.activeVersion,
          ...memory.card,
        }));
      const gate = await this.client.gate(configuration, apiKey, {
        turns,
        eligible_turn_ids: eligible.map((turn) => turn.turn_id),
        active_memories: activeMemories,
      });
      const processed = internalIds(batch.turns, gate.considered_turn_ids);
      if (!gate.result.should_refine) {
        this.database.sessionRefines.finish(job.jobId, processed, false);
        return;
      }

      const refined = await this.client.refine(configuration, apiKey, {
        turns,
        eligible_turn_ids: gate.considered_turn_ids,
        active_memories: activeMemories,
        selected_turn_ids: gate.result.selected_turn_ids,
      });
      const sources: CheckpointTurnSource[] = eligible.map((turn) => ({
        job_id: turn.job_id,
        turn_id: turn.turn_id,
      }));
      this.database.applySessionRefinement(
        job.repoId,
        job.sessionId,
        refined.result.edits,
        sources,
      );
      this.database.sessionRefines.finish(job.jobId, processed, true);
      this.database.modelSettings.clearFailure();
    } catch (error) {
      const code = workerErrorCode(error);
      this.database.sessionRefines.fail(job.jobId, code);
      if (error instanceof ModelError) {
        this.database.modelSettings.recordFailure(code);
      }
    }
  }
}

function internalIds(
  turns: Array<{ internal_turn_id: string; turn_id: string; role: string }>,
  consideredTurnIds: readonly string[],
): Set<string> {
  const considered = new Set(consideredTurnIds);
  return new Set(
    turns
      .filter((turn) => turn.role === "eligible" && considered.has(turn.turn_id))
      .map((turn) => turn.internal_turn_id),
  );
}

class WorkerError extends Error {}

function workerErrorCode(error: unknown): string {
  if (error instanceof ProjectionError || error instanceof ModelError) {
    return error.code;
  }
  if (error instanceof WorkerError && /^[a-z0-9_]+$/u.test(error.message)) {
    return error.message;
  }
  if (error instanceof Error && /^[a-z0-9_]+$/u.test(error.message)) {
    return error.message;
  }
  return "refine_failed";
}
