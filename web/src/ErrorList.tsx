import { ApiError } from './api.js';

// How a failed call is shown. A business refusal (422) lists every problem; a missing permission (403) and a network
// failure get a plain sentence. Nothing technical is shown to the person.
export function describeError(error: unknown): { heading: string; lines: string[] } {
  if (error instanceof ApiError) {
    if (error.status === 403) return { heading: `You are not allowed to do this: ${error.message}`, lines: [] };
    if (error.status === 401) return { heading: 'Please sign in again', lines: [] };
    if (error.status === 404) return { heading: error.message, lines: [] };
    if (error.status === 0) return { heading: error.message, lines: [] };
    if (error.errors.length > 0) return { heading: 'Please correct the following:', lines: error.errors };
    return { heading: error.message, lines: [] };
  }
  return { heading: 'Something went wrong', lines: [] };
}

export function ErrorList({ error }: { error: unknown }) {
  if (error === null || error === undefined) return null;
  const { heading, lines } = describeError(error);
  return (
    <div role="alert" className="error">
      <p>{heading}</p>
      {lines.length > 0 && (
        <ul>
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
