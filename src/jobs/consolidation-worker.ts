import type { MemoryDatabase } from "../db/database.js";
import { KnowledgeConsolidationClient } from "../model/consolidation-client.js";
import { ModelError } from "../model/error.js";
import type { ApiKeyProvider } from "../model/types.js";

const SCHEDULE_CHECK_MS = 60 * 60 * 1_000;

export class KnowledgeConsolidationWorker {
  private running: Promise<void> | null = null;
  private wakeRequested = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly database: MemoryDatabase,
    private readonly keyProvider: ApiKeyProvider,
    private readonly client = new KnowledgeConsolidationClient(),
  ) {}

  start(): void {
    if (this.timer) return;
    this.wake();
    this.timer = setInterval(() => this.wake(), SCHEDULE_CHECK_MS);
    this.timer.unref();
  }

  wake(): void {
    this.wakeRequested = true;
    if (this.running) return;
    this.running = this.drain().finally(() => {
      this.running = null;
      if (this.wakeRequested) this.wake();
    });
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }

  async idle(): Promise<void> {
    await this.running;
  }

  private async drain(): Promise<void> {
    while (this.wakeRequested) {
      this.wakeRequested = false;
      if (!this.database.extractionEnabled()) continue;
      this.database.consolidations.enqueueDue();
      let job = this.database.consolidations.claimNext();
      while (job) {
        await this.process(job);
        job = this.database.consolidations.claimNext();
      }
    }
  }

  private async process(
    job: NonNullable<ReturnType<MemoryDatabase["consolidations"]["claimNext"]>>,
  ): Promise<void> {
    try {
      const configuration = this.database.modelSettings.getConfiguration();
      const apiKey = await this.keyProvider.get();
      if (!configuration || !apiKey) throw new Error("model_not_configured");
      const active = this.database.consolidations.activeMemories(job.repoId);
      if (active.length < 1) {
        this.database.consolidations.complete(job.jobId, []);
        return;
      }
      const result = await this.client.consolidate(configuration, apiKey, {
        active_memories: active,
      });
      this.database.consolidations.complete(job.jobId, result.result.suggestions);
      this.database.modelSettings.clearFailure();
    } catch (error) {
      const code = errorCode(error);
      this.database.consolidations.fail(job.jobId, code);
      if (error instanceof ModelError) this.database.modelSettings.recordFailure(code);
    }
  }
}

function errorCode(error: unknown): string {
  if (error instanceof ModelError) return error.code;
  if (error instanceof Error && /^[a-z0-9_]+$/u.test(error.message)) {
    return error.message;
  }
  return "consolidation_failed";
}
