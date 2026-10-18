import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApi } from './api.js';

// The client is tested against a stand-in for fetch, so no server is needed.
function fakeFetch(status: number, body: unknown) {
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
}

describe('the API client', () => {
  it('sends the signed-in user on every call, and an idempotency key on every POST', async () => {
    const fetchStub = fakeFetch(200, { items: [], total: 0, limit: 50, offset: 0 });
    const api = createApi({ getUser: () => 'asha.agent', fetch: fetchStub });
    await api.listAccounts();
    const [url, init] = fetchStub.mock.calls[0]!;
    expect(url).toBe('/v1/accounts?limit=200');
    expect((init!.headers as Record<string, string>)['X-User']).toBe('asha.agent');
    expect((init!.headers as Record<string, string>)['Idempotency-Key']).toBeUndefined();

    const post = fakeFetch(201, { id: 'c1' });
    await createApi({ getUser: () => 'asha.agent', fetch: post }).createContact(
      { kind: 'person', name: 'Asha Rao', address: { line1: 'x', city: 'y', state: 'z', pinCode: '500081' } },
      'key-123',
    );
    const sent = post.mock.calls[0]![1]!;
    expect(sent.method).toBe('POST');
    expect((sent.headers as Record<string, string>)['Idempotency-Key']).toBe('key-123');
    expect(JSON.parse(sent.body as string).name).toBe('Asha Rao');
  });

  it('turns a refused request into an ApiError that carries every problem', async () => {
    const api = createApi({ getUser: () => 'asha.agent', fetch: fakeFetch(422, { error: 'validation_failed', message: 'The request was refused', errors: ['The PIN code is not valid', 'The name is required'] }) });
    const error = await api.quote('j', 'b', 'k').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 422, code: 'validation_failed', errors: ['The PIN code is not valid', 'The name is required'] });
  });

  it('names the fields of a request that is not shaped right', async () => {
    const api = createApi({ getUser: () => null, fetch: fakeFetch(400, { error: 'bad_request', message: 'The request is not shaped right', issues: [{ path: 'date', message: 'A date is written yyyy-mm-dd' }] }) });
    const error = (await api.policyAsOf('PL-1', 'x').catch((e: unknown) => e)) as ApiError;
    expect(error.errors).toEqual(['date: A date is written yyyy-mm-dd']);
  });

  it('says so when the server cannot be reached', async () => {
    const api = createApi({ getUser: () => null, fetch: (async () => Promise.reject(new TypeError('failed'))) as unknown as typeof fetch });
    expect(await api.listAccounts().catch((e: unknown) => e)).toMatchObject({ status: 0, code: 'network' });
  });
});
