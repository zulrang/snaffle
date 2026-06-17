/**
 * Explicit success/failure value, used instead of exceptions for all *domain*
 * validation and decisions.
 *
 * The spine is a control plane: a smart constructor rejecting bad input, or a
 * classifier returning a verdict, is ordinary control flow, not an exceptional
 * condition. Modelling those as `Result` keeps the failure in the type signature
 * where the caller is forced to handle it, rather than relying on a thrown error
 * that some layer might silently swallow. Exceptions are reserved for genuine
 * programmer faults and infrastructure failure.
 */
export type Result<T, E> = Ok<T> | Err<E>;

export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

export const isOk = <T, E>(result: Result<T, E>): result is Ok<T> => result.ok;
export const isErr = <T, E>(result: Result<T, E>): result is Err<E> => !result.ok;

/** Transform the success value, leaving an error untouched. */
export const map = <T, E, U>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> =>
  result.ok ? ok(fn(result.value)) : result;

/** Transform the error value, leaving a success untouched. */
export const mapErr = <T, E, F>(result: Result<T, E>, fn: (error: E) => F): Result<T, F> =>
  result.ok ? result : err(fn(result.error));

/** Chain a fallible step; short-circuits on the first error. */
export const flatMap = <T, E, U>(
  result: Result<T, E>,
  fn: (value: T) => Result<U, E>,
): Result<U, E> => (result.ok ? fn(result.value) : result);

/** Extract the value or fall back to a default. */
export const unwrapOr = <T, E>(result: Result<T, E>, fallback: T): T =>
  result.ok ? result.value : fallback;

/**
 * Collect a list of results into a single result of a list, short-circuiting on
 * the first error. Useful for validating a batch of declared facts at once.
 */
export const all = <T, E>(results: readonly Result<T, E>[]): Result<readonly T[], E> => {
  const values: T[] = [];
  for (const result of results) {
    if (!result.ok) return result;
    values.push(result.value);
  }
  return ok(values);
};
