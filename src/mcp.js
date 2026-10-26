'use strict';
// B12: an MCP server over this application's tools.
//
// The point of exposing tools over a protocol is that another assistant can use them - which means the boundary must refuse as firmly as the
// application does. A tool that throws a permission error returns a JSON-RPC error, never a partial result: an outside agent must not learn
// more from the shape of a failure than from a success.

const PROTOCOL_VERSION = '2024-11-05';

function createMcp({ tools, serverInfo = { name: 'policycenter-sim', version: '1.0.0' } } = {}) {
  if (!tools || typeof tools !== 'object') throw new Error('tools are required');

  const names = () => Object.keys(tools);

  function list() {
    return names().map((name) => ({
      name,
      description: tools[name].description || '',
      inputSchema: tools[name].inputSchema || { type: 'object', properties: {} },
    }));
  }

  /** @returns {Promise<{jsonrpc: string, id: any, result?: object, error?: object}>} */
  async function handle(user, request = {}) {
    const { id = null, method, params = {} } = request;
    const ok = (result) => ({ jsonrpc: '2.0', id, result });
    const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

    if (method === 'initialize') {
      return ok({ protocolVersion: PROTOCOL_VERSION, serverInfo, capabilities: { tools: {} } });
    }
    if (method === 'tools/list') return ok({ tools: list() });
    if (method === 'tools/call') {
      const name = params.name;
      const tool = tools[name];
      if (!tool) return fail(-32602, 'Unknown tool: ' + String(name));
      try {
        const output = await tool.run(user, params.arguments || {});
        return ok({ content: [{ type: 'text', text: typeof output === 'string' ? output : JSON.stringify(output) }] });
      } catch (err) {
        // The message is returned, the stack is not: an outside caller gets the refusal, not the internals.
        return fail(err.status && err.status >= 400 && err.status < 500 ? -32000 + 0 : -32603, err.message || 'The tool failed');
      }
    }
    return fail(-32601, 'Unknown method: ' + String(method));
  }

  return { handle, list, names };
}

module.exports = { createMcp, PROTOCOL_VERSION };
