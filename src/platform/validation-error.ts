// Carries every problem found with some input, so a screen can show them all at once instead of one at a time.
// Shared by all modules, so it lives in Platform.
export class ValidationError extends Error {
  readonly errors: string[];

  constructor(errors: string[]) {
    super(errors.join('; '));
    this.name = 'ValidationError';
    this.errors = errors;
  }
}
