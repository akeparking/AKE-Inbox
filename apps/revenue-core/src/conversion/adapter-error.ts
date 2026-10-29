export class AdapterError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
    readonly uncertain = false,
  ) {
    super(message);
  }
}
