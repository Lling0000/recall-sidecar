export class ModelError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ModelError";
  }
}
