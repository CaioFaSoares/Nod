// Typed client for the Nod API. The page talks to the backend only through here.
// Method names and types come from shared/types.ts (ApiContract).
import type { Method, Params, PushEvents, Result } from '../shared/types';

export function call<M extends Method>(
  method: M,
  ...params: Params<M> extends void ? [] : [Params<M>]
): Promise<Result<M>> {
  return tiny.api.call(method, params[0] ?? {}) as Promise<Result<M>>;
}

export function on<E extends keyof PushEvents>(event: E, fn: (data: PushEvents[E]) => void): () => void {
  return tiny.api.on(event, fn as (data: unknown) => void);
}

/** Readable message of an error coming from the backend. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'unknown error';
}
