import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createVectrClient } from '../server/vectr.js';

describe('Vectr client', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('returns embedding on successful call', async () => {
    const fakeVector = Array.from({ length: 384 }, () => 0.5);
    const fetchMock = mock.fn(async () => ({
      ok: true,
      json: async () => ({ embedding: fakeVector }),
    }));
    mock.method(globalThis, 'fetch', fetchMock);

    const vectr = createVectrClient('http://127.0.0.1:3901', 5000);
    const result = await vectr.embed('test text');

    assert.ok(Array.isArray(result));
    assert.equal(result.length, 384);
    assert.equal(fetchMock.mock.calls[0].arguments[0], 'http://127.0.0.1:3901/embed');
  });

  it('returns null when Vectr is unreachable', async () => {
    const fetchMock = mock.fn(async () => {
      throw new Error('Connection refused');
    });
    mock.method(globalThis, 'fetch', fetchMock);

    const vectr = createVectrClient('http://127.0.0.1:3901', 5000);
    const result = await vectr.embed('test text');

    assert.equal(result, null);
  });

  it('returns null on dimension mismatch', async () => {
    const wrongVector = Array.from({ length: 256 }, () => 0.5);
    const fetchMock = mock.fn(async () => ({
      ok: true,
      json: async () => ({ embedding: wrongVector }),
    }));
    mock.method(globalThis, 'fetch', fetchMock);

    const vectr = createVectrClient('http://127.0.0.1:3901', 5000);
    const result = await vectr.embed('test text');

    assert.equal(result, null);
  });

  it('returns null on HTTP error', async () => {
    const fetchMock = mock.fn(async () => ({
      ok: false,
      status: 500,
    }));
    mock.method(globalThis, 'fetch', fetchMock);

    const vectr = createVectrClient('http://127.0.0.1:3901', 5000);
    const result = await vectr.embed('test text');

    assert.equal(result, null);
  });

  it('truncates text to 8192 characters', async () => {
    const longText = 'a'.repeat(10000);
    const fakeVector = Array.from({ length: 384 }, () => 0.1);
    const fetchMock = mock.fn(async () => ({
      ok: true,
      json: async () => ({ embedding: fakeVector }),
    }));
    mock.method(globalThis, 'fetch', fetchMock);

    const vectr = createVectrClient('http://127.0.0.1:3901', 5000);
    await vectr.embed(longText);

    const body = JSON.parse(fetchMock.mock.calls[0].arguments[1].body);
    assert.equal(body.text.length, 8192);
  });
});
