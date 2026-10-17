'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Chatbot, TOOLS, runTool } = require('../src/chatbot');
const { setup, account, autoSubmission } = require('./helpers');

function bookWithPolicy() {
  const env = setup('2026-03-01');
  const { pc, users, run } = env;
  const acct = run(() => account(pc, users.agent));
  const job = run(() => autoSubmission(pc, users.agent, acct, '2026-03-01'));
  run(() => pc.quote(job.id, users.agent));
  run(() => pc.bind(job.id, users.agent));
  return { ...env, acct, job, policyNumber: pc.policy(job.policyId).policyNumber };
}

// Stand-in for the Anthropic client's streaming API: replays scripted responses as stream events
// (text arrives word by word) and records each request.
function fakeClient(responses) {
  const requests = [];
  return {
    requests,
    beta: {
      messages: {
        stream: (params) => {
          requests.push(JSON.parse(JSON.stringify(params)));
          const message = responses.shift();
          const events = [];
          message.content.forEach((block, index) => {
            events.push({ type: 'content_block_start', index, content_block: block.type === 'text' ? { type: 'text', text: '' } : block });
            if (block.type === 'text') {
              for (const piece of block.text.match(/\S+\s*/g) || []) events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: piece } });
            }
            events.push({ type: 'content_block_stop', index });
          });
          return {
            async *[Symbol.asyncIterator]() { yield* events; },
            finalMessage: async () => message,
          };
        },
      },
    },
  };
}

test('tool definitions are well formed and every tool runs', () => {
  const { pc, users, policyNumber, job } = bookWithPolicy();
  for (const t of TOOLS) {
    assert.equal(t.input_schema.type, 'object');
    assert.equal(t.input_schema.additionalProperties, false);
  }
  const inputs = {
    search: { query: 'Insured' }, get_account: { account: 'A0000001' }, get_policy: { policy: policyNumber },
    get_job: { job: job.jobNumber }, get_rating_worksheet: { record: policyNumber, coverage: 'Collision' },
    list_work_queue: {}, portfolio_summary: { product: 'PersonalAuto' }, list_policies: { sort: 'premium_desc', limit: 5 },
    get_product_rules: { topic: 'Homeowners' },
  };
  for (const t of TOOLS) assert.ok(runTool(pc, users.uw, t.name, inputs[t.name]), t.name);
  const ws = runTool(pc, users.uw, 'get_rating_worksheet', inputs.get_rating_worksheet);
  assert.ok(ws.costs.length > 0 && ws.costs.every((c) => c.item.includes('Collision')));
});

test('claude mode: runs the tool loop, returns the answer, keeps history append-only', async () => {
  const { pc, users, policyNumber } = bookWithPolicy();
  const client = fakeClient([
    { stop_reason: 'tool_use', content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'tool_use', id: 'tu1', name: 'get_policy', input: { policy: policyNumber } }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: `${policyNumber} is in force.` }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Follow-up answer.' }] },
  ]);
  const bot = new Chatbot(pc, { client });
  assert.equal(bot.status().mode, 'claude');

  const r = await bot.chat({ message: 'Summarize this policy', context: { page: 'policy', record: policyNumber } }, users.agent);
  assert.equal(r.reply, `${policyNumber} is in force.`);
  assert.deepEqual(r.toolsUsed, ['get_policy']);
  const second = client.requests[1];
  const toolResult = second.messages[3].content[0];
  assert.equal(toolResult.type, 'tool_result');
  assert.equal(toolResult.tool_use_id, 'tu1');
  assert.equal(JSON.parse(toolResult.content).policyNumber, policyNumber);
  assert.equal(second.model, 'claude-haiku-5-5');
  assert.equal(second.fallbacks, undefined, 'Haiku 5.5 has no server-side fallback');
  assert.equal(second.betas, undefined);
  assert.deepEqual(second.output_config, { effort: 'low' });
  assert.match(second.messages[0].content, /Viewing: policy, record PA-/);

  await bot.chat({ conversationId: r.conversationId, message: 'And the billing?' }, users.agent);
  const third = client.requests[2];
  // Earlier turns (including the thinking block) are sent back unchanged.
  assert.deepEqual(third.messages.slice(0, 5), second.messages.concat([{ role: 'assistant', content: [{ type: 'text', text: `${policyNumber} is in force.` }] }]));
});

test('tools run as the signed-in user: agents cannot read other producers\' records', async () => {
  const { pc, users, policyNumber } = bookWithPolicy();
  const other = pc.user('agent2');
  const client = fakeClient([
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu1', name: 'get_policy', input: { policy: policyNumber } }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Not found.' }] },
  ]);
  await new Chatbot(pc, { client }).chat({ message: `Show ${policyNumber}` }, other);
  const result = client.requests[1].messages[3].content[0];
  assert.equal(result.is_error, true);
  assert.match(result.content, /not found/i);
  assert.ok(users.agent);
});

test('offline mode answers lookups, referrals and summaries without an API key', async () => {
  const { pc, users, policyNumber, job } = bookWithPolicy();
  const bot = new Chatbot(pc, { client: null });
  assert.equal(bot.status().mode, 'offline');
  const p = await bot.chat({ message: `Tell me about ${policyNumber}` }, users.uw);
  assert.equal(p.mode, 'offline');
  assert.match(p.reply, new RegExp(`${policyNumber}.*In Force`));
  const j = await bot.chat({ message: 'what about this job?', context: { page: 'job', record: job.jobNumber } }, users.uw);
  assert.match(j.reply, /Submission/);
  const s = await bot.chat({ message: 'Summarize the book of business' }, users.uw);
  assert.match(s.reply, /1 policies/);
  await assert.rejects(bot.chat({ message: '   ' }, users.uw), /empty/);
});

test('live answers: text streams as deltas, lookups announce themselves, bad tool input is rejected', async () => {
  const { pc, users, policyNumber } = bookWithPolicy();
  const client = fakeClient([
    { stop_reason: 'tool_use', content: [{ type: 'text', text: 'Let me check. ' }, { type: 'tool_use', id: 'tu1', name: 'get_policy', input: { policy: policyNumber } }, { type: 'tool_use', id: 'tu2', name: 'list_policies', input: { limit: 500 } }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'The policy is in force with no open jobs.' }] },
  ]);
  const events = [];
  const r = await new Chatbot(pc, { client }).chat({ message: 'Status?' }, users.uw, (type, data) => events.push([type, data]));
  const deltas = events.filter(([t]) => t === 'delta').map(([, d]) => d.text);
  assert.ok(deltas.length > 5, 'answer arrives in many small pieces');
  assert.equal(deltas.join(''), 'Let me check. \nThe policy is in force with no open jobs.');
  assert.equal(r.reply, 'The policy is in force with no open jobs.');
  assert.deepEqual(events.filter(([t]) => t === 'tool').map(([, d]) => d.label), [`Looking up policy ${policyNumber}`]);
  const results = client.requests[1].messages[3].content;
  assert.equal(results[1].is_error, true, 'out-of-range limit is not executed');
  assert.match(results[1].content, /INVALID_INPUT/);
  assert.ok(client.requests[0].tools.every((t) => t.eager_input_streaming === true));
});

test('SSE endpoint streams meta, delta and done events', async () => {
  const http = require('node:http');
  const { createApi } = require('../src/api');
  const { pc, store, policyNumber } = bookWithPolicy();
  const bot = new Chatbot(pc, { client: fakeClient([{ stop_reason: 'end_turn', content: [{ type: 'text', text: `Hello from ${policyNumber}` }] }]) });
  const api = createApi(pc, store, { chatbot: bot });
  const server = http.createServer((req, res) => { const u = new URL(req.url, 'http://x'); api(req, res, u.pathname, u.searchParams); });
  await new Promise((ok) => server.listen(0, ok));
  try {
    const res = await fetch(`http://localhost:${server.address().port}/api/chat/stream`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-User': 'uw' }, body: JSON.stringify({ message: 'hi' }) });
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const body = await res.text();
    const types = [...body.matchAll(/^event: (\w+)$/gm)].map((m) => m[1]);
    assert.equal(types[0], 'meta');
    assert.ok(types.filter((t) => t === 'delta').length >= 3);
    assert.equal(types[types.length - 1], 'done');
    const empty = await (await fetch(`http://localhost:${server.address().port}/api/chat/stream`, { method: 'POST', headers: { 'X-User': 'uw' }, body: JSON.stringify({ message: '' }) })).text();
    assert.match(empty, /event: error\ndata: .*empty/);
  } finally {
    server.close();
  }
});

test('languages: the assistant is told to answer in the user\'s language, script and mix', async () => {
  const { pc, users } = bookWithPolicy();
  const client = fakeClient([{ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }]);
  await new Chatbot(pc, { client }).chat({ message: 'J0000001 kyon blocked hai?' }, users.uw);
  const system = client.requests[0].system;
  for (const phrase of ['Hindi', 'Telugu', 'Hinglish', 'Tenglish', 'Devanagari', 'romanized']) assert.match(system, new RegExp(phrase));
  assert.match(client.requests[0].messages[0].content, /J0000001 kyon blocked hai\?$/);
  const instruction = client.requests[0].messages[1];
  assert.equal(instruction.role, 'system', 'reply style is sent as a mid-conversation system message');
  assert.match(instruction.content, /^Reply language for this answer: romanized Hinglish/);
  assert.equal(client.requests[0].messages.length, 2, 'the system message is the last entry of the first request');
});

test('languages: Telugu and Hindi script messages get medium effort, others low', async () => {
  const { pc, users } = bookWithPolicy();
  const client = fakeClient([
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'a' }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'b' }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'c' }] },
  ]);
  const bot = new Chatbot(pc, { client });
  await bot.chat({ message: 'నా దగ్గర ఎన్ని referrals ఉన్నాయి?' }, users.uw);
  await bot.chat({ message: 'मेरे पास कितने referrals हैं?' }, users.uw);
  await bot.chat({ message: 'mere kitne referrals hain?' }, users.uw);
  assert.deepEqual(client.requests.map((r) => r.output_config.effort), ['medium', 'medium', 'low']);
});

test('languages: each message is labelled with the reply style', () => {
  const { replyLanguage } = require('../src/chatbot');
  const style = (q) => replyLanguage(q).split(':')[0];
  assert.equal(style('J0000005 kyon blocked hai? short mein batao.'), 'romanized Hinglish');
  assert.equal(style('Rivera ki policy dikhao'), 'romanized Hinglish');
  assert.equal(style('J0000005 enduku block ayindi? short ga cheppu.'), 'romanized Tenglish');
  assert.equal(style('ee policy premium enduku ekkuva undi?'), 'romanized Tenglish');
  assert.match(style('J0000005 ब्लॉक क्यों है?'), /^Hindi in Devanagari/);
  assert.match(style('J0000005 ఎందుకు బ్లాక్ అయింది?'), /^Telugu in Telugu script/);
  assert.match(style('What is the premium in this policy?'), /^the same language/);
});

test('languages: offline mode understands Hindi, Telugu, Hinglish and Tenglish keywords', async () => {
  const { pc, users, policyNumber } = bookWithPolicy();
  const bot = new Chatbot(pc, { client: null });
  const ask = async (message, context) => (await bot.chat({ message, context }, users.uw)).reply;
  const onPolicy = { page: 'policy', record: policyNumber };

  assert.match(await ask('मेरे रेफरल दिखाओ'), /referral/i, 'Hindi: show my referrals');
  assert.match(await ask('naa pending referrals enti?'), /referral/i, 'Tenglish: what are my pending referrals');
  assert.match(await ask('kitne policies hain?'), /You can see \d+ accounts/, 'Hinglish: how many policies');
  assert.match(await ask('మొత్తం ఎన్ని పాలసీలు ఉన్నాయి?'), /You can see \d+ accounts/, 'Telugu: how many policies in total');
  assert.match(await ask('ee policy premium enduku ekkuva undi?', onPolicy), new RegExp(policyNumber), 'Tenglish: this policy');
  assert.match(await ask('इस पॉलिसी के बारे में बताओ', onPolicy), new RegExp(policyNumber), 'Hindi: about this policy');
  assert.match(await ask('Insured ki policy dikhao'), /Here is what I found/, 'Hinglish name search');
  assert.match(await ask('ఈ పాలసీ గురించి చెప్పు', onPolicy), /English only/, 'native script gets an English-only note offline');
  assert.ok(!(await ask('What is the summary?', onPolicy)).includes(`**${policyNumber}**`), 'English "is" does not mean "this record"');
});
