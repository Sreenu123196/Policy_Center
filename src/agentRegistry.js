'use strict';
// B17: the system of record for agents.
//
// Three things were previously implicit and are now written down: which agents exist, what each may authorise, and whether it is
// running. A stopped agent is refused at the registry, so the stop does not depend on every caller remembering to check - and a
// global stop covers the case where nobody knows which agent is misbehaving.

const { AppError } = require('./appError');

function createAgentRegistry({ store, aops }) {
  const agents = () => {
    store.data.agents = store.data.agents || [];
    return store.data.agents;
  };
  const state = () => {
    store.data.agentRegistry = store.data.agentRegistry || { stoppedAll: false, stoppedAllBy: null, stoppedAllAt: null };
    return store.data.agentRegistry;
  };

  function register(user, input = {}) {
    if (!input.name) throw new AppError(422, 'a name is required');
    if (!input.domain) throw new AppError(422, 'a domain is required');
    const existing = agents().find((a) => a.name === input.name);
    if (existing) throw new AppError(409, 'An agent called ' + input.name + ' already exists');
    const agent = {
      id: 'AG-' + String(store.next('agent')).padStart(5, '0'),
      name: input.name,
      domain: input.domain,
      allowedActions: input.allowedActions || [],
      authority: input.authority !== undefined ? Number(input.authority) : 0,
      status: 'running',
      createdBy: user && user.id,
      createdAt: new Date().toISOString(),
      stoppedBy: null,
      stoppedAt: null,
      stopReason: null,
    };
    agents().push(agent);
    return agent;
  }

  function get(id) {
    const agent = agents().find((a) => a.id === id || a.name === id);
    if (!agent) throw new AppError(404, 'Agent not found');
    return agent;
  }

  function stop(user, id, reason) {
    const agent = get(id);
    if (agent.status === 'stopped') return agent;
    agent.status = 'stopped';
    agent.stoppedBy = user && user.id;
    agent.stoppedAt = new Date().toISOString();
    agent.stopReason = reason || null;
    return agent;
  }

  function resume(user, id) {
    const agent = get(id);
    agent.status = 'running';
    agent.resumedBy = user && user.id;
    agent.resumedAt = new Date().toISOString();
    return agent;
  }

  /** The one-click stop: every agent, with who did it and why. */
  function stopAll(user, reason) {
    const book = state();
    book.stoppedAll = true;
    book.stoppedAllBy = user && user.id;
    book.stoppedAllAt = new Date().toISOString();
    book.stoppedAllReason = reason || null;
    for (const agent of agents()) {
      if (agent.status !== 'stopped') {
        agent.status = 'stopped';
        agent.stoppedBy = user && user.id;
        agent.stoppedAt = book.stoppedAllAt;
        agent.stopReason = 'global stop' + (reason ? ': ' + reason : '');
      }
    }
    return { ...book, stopped: agents().length };
  }

  function resumeAll(user) {
    const book = state();
    book.stoppedAll = false;
    book.resumedAllBy = user && user.id;
    book.resumedAllAt = new Date().toISOString();
    // Resuming lifts the global stop and restarts whatever it stopped; an agent stopped on its own stays stopped until someone
    // resumes it deliberately.
    for (const agent of agents()) {
      if (agent.status === 'stopped' && String(agent.stopReason || '').startsWith('global stop')) {
        agent.status = 'running';
        agent.stopReason = null;
      }
    }
    return book;
  }

  /**
   * May this agent take this action for this amount? Checked against the registry (running, action permitted, own authority) and
   * then the procedure, so the English and the registry cannot disagree silently.
   */
  function mayAct(id, { action, amount, role } = {}) {
    const agent = get(id);
    if (state().stoppedAll) {
      return { allowed: false, agent, reason: 'All agents are stopped; nothing may act until they are resumed.' };
    }
    if (agent.status !== 'running') {
      return { allowed: false, agent, reason: 'Agent ' + agent.name + ' is stopped.' };
    }
    if (action && agent.allowedActions.length && !agent.allowedActions.includes(action)) {
      return { allowed: false, agent, reason: agent.name + ' is not permitted to ' + action + '.' };
    }
    if (amount !== undefined && Number(amount) > agent.authority) {
      return { allowed: false, agent, reason: agent.name + ' may authorise up to ' + agent.authority + ', not ' + Number(amount) + '.' };
    }
    if (aops && action) {
      const result = aops.check({ action, role, amount });
      if (!result.allowed) return { allowed: false, agent, reason: result.reason, procedure: result.procedure };
      return { allowed: true, agent, reason: result.reason, procedure: result.procedure };
    }
    return { allowed: true, agent, reason: agent.name + ' may act.' };
  }

  return { register, get, list: () => agents(), stop, resume, stopAll, resumeAll, mayAct, state };
}

module.exports = { createAgentRegistry };
