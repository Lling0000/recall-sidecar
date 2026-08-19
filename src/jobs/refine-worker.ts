import { COMPARE_CARD_LIMIT } from "../constants.js";
import type { MemoryDatabase } from "../db/database.js";
import { ModelError, StrictModelClient } from "../model/client.js";
import { SessionRefineClient } from "../model/session-client.js";
import type { SessionTurnContext } from "../model/session-types.js";
import type { ApiKeyProvider, ExtractionInput } from "../model/types.js";
import {
  ProjectionError,
  projectRollout,
  projectRollouts,
} from "../rollout/projector.js";
import type { ExtractResult, RolloutProjection } from "../types.js";
import { shouldIncludePreviousTurn } from "./previous-turn.js";

const SKIP_RESULT: ExtractResult = {
  action: "skip",
  target_memory_id: null,
  base_version: null,
  memory: null,
};

export class RefineWorker {
  private running: Promise<void> | null = null;
  private wakeRequested = false;
  private readonly client: StrictModelClient;
  private readonly sessionClient: SessionRefineClient;

  constructor(
    private readonly database: MemoryDatabase,
    private readonly keyProvider: ApiKeyProvider,
    client?: StrictModelClient,
    sessionClient?: SessionRefineClient,
    private readonly checkpointTurnInterval = 25,
  ) {
    this.client = client ?? new StrictModelClient();
    this.sessionClient = sessionClient ?? new SessionRefineClient();
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
      let job = this.database.claimNextJob();
      while (job) {
        await this.process(job);
        job = this.database.claimNextJob();
      }
      let sessionJob = this.database.sessionRefines.claimNext();
      while (sessionJob) {
        await this.processSessionRefine(sessionJob);
        sessionJob = this.database.sessionRefines.claimNext();
      }
    }
  }

  private async process(job: NonNullable<ReturnType<MemoryDatabase["claimNextJob"]>>) {
    try {
      if (!this.database.extractionEnabled()) {
        throw new WorkerError("auto_extract_disabled");
      }
      const configuration = this.database.modelSettings.getConfiguration();
      const apiKey = await this.keyProvider.get();
      if (!configuration || !apiKey) throw new WorkerError("model_not_configured");
      const projection = await projectRollout(
        job.transcriptPath,
        job.nativeSessionRef,
        job.nativeTurnRef,
      );
      this.database.recordProjection(
        job.turnId,
        projection.sourceDigest,
        projection.projectionVersion,
      );

      const includePrevious =
        shouldIncludePreviousTurn(projection.userPrompt) &&
        projection.previousUserPrompt !== null;
      let input = this.input(projection, includePrevious, job.repoId);
      let response = await this.client.extract(configuration, apiKey, input);
      let result = response.result;
      let revision = 1;

      if (result.action === "need_prev_turn" && !includePrevious) {
        if (!projection.previousUserPrompt) result = SKIP_RESULT;
        else {
          input = this.input(projection, true, job.repoId);
          response = await this.client.extract(configuration, apiKey, input);
          result =
            response.result.action === "need_prev_turn" ? SKIP_RESULT : response.result;
          revision = 2;
        }
      }
      this.database.sessionRefines.stage(
        job.jobId,
        job.repoId,
        job.sessionId,
        job.nativeTurnRef,
        result,
        revision,
      );
      this.database.sessionRefines.enqueue(
        job.sessionId,
        job.repoId,
        "turn_interval",
        this.checkpointTurnInterval,
      );
      this.database.modelSettings.clearFailure();
    } catch (error) {
      const code = workerErrorCode(error);
      this.database.markJobFailed(job.jobId, code);
      if (error instanceof ModelError) {
        this.database.modelSettings.recordFailure(code);
      }
    }
  }

  private async processSessionRefine(
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
      if (batch.candidates.length === 0) {
        this.database.sessionRefines.finish(job.jobId, [], new Set(), false);
        return;
      }

      const projections = await projectRollouts(
        job.transcriptPath,
        job.nativeSessionRef,
        batch.candidates.map((candidate) => candidate.turn_id),
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
      const gate = await this.sessionClient.gate(configuration, apiKey, {
        turns,
        candidates: batch.candidates,
        active_memories: activeMemories,
      });
      const batchJobIds = batch.candidates.map((candidate) => candidate.job_id);
      if (!gate.result.should_refine) {
        this.database.sessionRefines.finish(job.jobId, batchJobIds, new Set(), false);
        return;
      }

      const refined = await this.sessionClient.refine(configuration, apiKey, {
        turns,
        candidates: batch.candidates,
        active_memories: activeMemories,
        selected_turn_ids: gate.result.candidate_turn_ids,
      });
      this.database.applySessionRefinement(
        job.repoId,
        job.sessionId,
        refined.result.edits,
        batch.candidates,
      );
      const consumed = new Set(
        refined.result.edits.map((edit) => {
          const candidate = batch.candidates.find(
            (value) => value.turn_id === edit.source_turn_id,
          );
          if (!candidate) throw new WorkerError("session_refine_source_missing");
          return candidate.job_id;
        }),
      );
      this.database.sessionRefines.finish(job.jobId, batchJobIds, consumed, true);
      this.database.modelSettings.clearFailure();
    } catch (error) {
      const code = workerErrorCode(error);
      this.database.sessionRefines.fail(job.jobId, code);
      if (error instanceof ModelError) {
        this.database.modelSettings.recordFailure(code);
      }
    }
  }

  private input(
    projection: RolloutProjection,
    includePrevious: boolean,
    repoId: string,
  ): ExtractionInput {
    const searchPrompt = includePrevious
      ? `${projection.previousUserPrompt ?? ""}\n${projection.userPrompt}`
      : projection.userPrompt;
    const input: ExtractionInput = {
      user_prompt: projection.userPrompt,
      final_answer: projection.finalAnswer,
      compare_cards: this.database.searchCards(
        repoId,
        searchPrompt,
        COMPARE_CARD_LIMIT,
      ),
    };
    if (includePrevious && projection.previousUserPrompt) {
      input.prev_user_prompt = projection.previousUserPrompt;
    }
    return input;
  }
}

class WorkerError extends Error {}

function workerErrorCode(error: unknown): string {
  if (error instanceof ProjectionError || error instanceof ModelError) {
    return error.code;
  }
  if (error instanceof WorkerError && /^[a-z0-9_]+$/u.test(error.message)) {
    return error.message;
  }
  return "refine_failed";
}
