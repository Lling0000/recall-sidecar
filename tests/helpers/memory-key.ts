import type { ApiKeyProvider } from "../../src/model/types.js";

export class MemoryKeyProvider implements ApiKeyProvider {
  private value: string | null;

  constructor(initial: string | null = null) {
    this.value = initial;
  }

  async get(): Promise<string | null> {
    return this.value;
  }

  async set(value: string): Promise<void> {
    this.value = value;
  }

  async delete(): Promise<void> {
    this.value = null;
  }
}
