import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../frontend/js/api.js', import.meta.url), 'utf8');
const { api } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

// Exercise the actual browser API module without adding a frontend build system.
test('chat suggestions sends JSON and the notebook session to the same-origin endpoint', async () => {
  const originalFetch = globalThis.fetch;
  let call;
  globalThis.fetch = async (url, options) => {
    call = { url, options };
    return new Response(JSON.stringify({ available: false, queries: [] }));
  };
  try {
    const scenario = { oxygen_pct: 34, gravity_g: 0.16 };
    const messages = [{ role: 'user', content: 'Explain BASS-II' }];
    const result = await api.chatSuggestions({ messages, notebookTitle: 'Lunar', scenario, sessionId: 'notebook-1' });
    assert.deepEqual(result, { available: false, queries: [] });
    assert.equal(call.url, '/api/chat/suggestions');
    assert.equal(call.options.method, 'POST');
    assert.equal(call.options.headers['Content-Type'], 'application/json');
    assert.equal(call.options.headers['X-Session-Id'], 'notebook-1');
    assert.deepEqual(JSON.parse(call.options.body), { messages, notebook_title: 'Lunar', scenario });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('chat suggestions supplies defaults and reuses the stored session', async () => {
  const originalFetch = globalThis.fetch;
  const originalStorage = globalThis.sessionStorage;
  let call;
  globalThis.sessionStorage = { getItem: () => 'stored-session' };
  globalThis.fetch = async (url, options) => {
    call = { url, options };
    return new Response(JSON.stringify({ available: false, queries: [] }));
  };
  try {
    await api.chatSuggestions();
    assert.equal(call.options.headers['X-Session-Id'], 'stored-session');
    assert.deepEqual(JSON.parse(call.options.body), { messages: [], notebook_title: '', scenario: null });
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.sessionStorage = originalStorage;
  }
});

test('chat suggestions reports HTTP errors', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('Unavailable', { status: 503 });
  try {
    await assert.rejects(api.chatSuggestions({ sessionId: 'notebook-1' }), /API 503/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
