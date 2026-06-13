/**
 * Converts thrown values into stable diagnostic text for logs and validation errors.
 * Input: arbitrary value caught from a `catch` block.
 * Output: an Error message when available, otherwise the stringified thrown value.
 * Boundary: this helper formats diagnostics only; it must not classify or recover errors.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
