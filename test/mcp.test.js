'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMcp } = require('../src/mcp');

// An outside assistant may use these tools, and must meet the same refusals as a person inside the app.

const tools = {
  aop_check: {
    description: 'Ask whether an action is permitted',
    inputSchema: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] },
    run: async (user, args) => ({ allowed: args.action === 'claim.refer', role: user.role }),
  },
  secret_tool: {
    description: 'Forbidden to agents',
    run: async (user) => {
      if (user.role === 'Agent') { const err = new Error('Agents may not use this tool'); err.status = 403; throw err; }
      return 'ok';
    },
  },
};

const user = { id: 'u1', role: 'Adjuster' };

test('initialize answers with a protocol version and the server name', async () => {
  const mcp = createMcp({ tools });
  const response = await mcp.handle(user, { id: 1, method: 'initialize' });
  assert.equal(response.result.protocolVersion, '2024-11-05');
  assert.equal(response.result.serverInfo.name, 'policycenter-sim');
});

test('tools/list advertises the schema, so a caller can form a valid request', async () => {
  const mcp = createMcp({ tools });
  const response = await mcp.handle(user, { id: 2, method: 'tools/list' });
  const names = response.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['aop_check', 'secret_tool']);
  const schema = response.result.tools.find((t) => t.name === 'aop_check').inputSchema;
  assert.deepEqual(schema.required, ['action']);
});

test('tools/call returns the result as text content', async () => {
  const mcp = createMcp({ tools });
  const response = await mcp.handle(user, { id: 3, method: 'tools/call', params: { name: 'aop_check', arguments: { action: 'claim.refer' } } });
  assert.equal(response.error, undefined);
  const payload = JSON.parse(response.result.content[0].text);
  assert.equal(payload.allowed, true);
  assert.equal(payload.role, 'Adjuster');
});

test('a permission refusal comes back as an error, not a result', async () => {
  const mcp = createMcp({ tools });
  const response = await mcp.handle({ id: 'u2', role: 'Agent' }, { id: 4, method: 'tools/call', params: { name: 'secret_tool' } });
  assert.ok(response.error, 'the refusal is an error');
  assert.match(response.error.message, /may not use this tool/);
  assert.equal(response.result, undefined);
});

test('an unknown tool and an unknown method are protocol errors', async () => {
  const mcp = createMcp({ tools });
  const unknownTool = await mcp.handle(user, { id: 5, method: 'tools/call', params: { name: 'nope' } });
  assert.equal(unknownTool.error.code, -32602);
  const unknownMethod = await mcp.handle(user, { id: 6, method: 'resources/list' });
  assert.equal(unknownMethod.error.code, -32601);
});

test('a tool that throws an unexpected error does not leak its stack', async () => {
  const mcp = createMcp({ tools: { boom: { run: async () => { throw new Error('database on fire'); } } } });
  const response = await mcp.handle(user, { id: 7, method: 'tools/call', params: { name: 'boom' } });
  assert.match(response.error.message, /database on fire/);
  assert.equal(JSON.stringify(response).includes('at '), false, 'no stack frames in the reply');
});
