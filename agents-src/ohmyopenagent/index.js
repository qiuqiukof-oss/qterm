'use strict';
// OhMyOpenAgent core — 可被其他模块 require 的编排 API（骨架）。
function createOrchestrator(config) {
  const agents = (config && config.agents) || [];
  return {
    list() { return agents.map((a) => a.id); },
    async run(agentId, prompt) {
      const a = agents.find((x) => x.id === agentId);
      if (!a) throw new Error(`未注册的智能体: ${agentId}`);
      return { agent: agentId, prompt, dispatched: true };
    },
  };
}

module.exports = { createOrchestrator, version: require('./package.json').version };
