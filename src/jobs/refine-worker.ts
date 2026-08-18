import { COMPARE_CARD_LIMIT } from "../constants.js";
import type { MemoryDatabase } from "../db/database.js";
import { ModelError, StrictModelClient } from "../model/client.js";
import type { ApiKeyProvider, ExtractionInput } from "../model/types.js";
import { ProjectionError, projectRollout } from "../rollout/projector.js";
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

  constructor(
    private readonly database: MemoryDatabase,
    private readonly keyProvider: ApiKeyProvider,
    client?: StrictModelClient,
  ) {
    this.client = client ?? new StrictModelClient(database.modelSettings);
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
      this.database.applyExtractResult(
        job.jobId,
        job.repoId,
        result,
        job.sessionId,
        job.nativeTurnRef,
        revision,
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
