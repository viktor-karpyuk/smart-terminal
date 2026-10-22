'use strict';

/**
 * Kubrik OS (kubrik.io), through its external MCP gateway (COP-21):
 * `https://mcp.kubrik.io/<module>`, or the backend's `<api>/mcp/v1/<module>`.
 * A person makes a personal API key in Kubrik OS (Profile → API keys,
 * `kos_<8>_<40>`), choosing which modules it reaches and at what tier.
 *
 * Everything about the key, the wire and the rules is `KeyMcpService`. What is
 * Kubrik's own:
 * - every module also serves `ask_agent` (its own AI agent) and
 *   `kos_proposal_status`; they are offered as `acc_ask_agent`, … so each name
 *   means one module, and `ask_agent` gets the two minutes a turn may take;
 * - below the Autonomous tier a write is not done: it comes back as
 *   `proposal_pending` with a `confirmUrl` the person opens in Kubrik OS.
 */

const { KeyMcpService } = require('./key-mcp-service');

/** The modules served outside (ExternalMcpProperties.DEFAULT_MODULES); PLAT, ORCH and COP stay inside. */
const MODULES = ['core', 'oms', 'wms', 'crm', 'cra', 'pur', 'hr', 'acc', 'dms', 'psa', 'dash'];

const PRODUCT = {
  name: 'Kubrik OS',
  table: 'kio',
  apps: MODULES,
  appNames: {
    core: 'Core', oms: 'Orders', wms: 'Warehouse', crm: 'CRM', cra: 'Credit', pur: 'Purchasing', hr: 'People',
    acc: 'Accounting', dms: 'Documents', psa: 'Projects', dash: 'Dashboards',
  },
  keyShape: /^kos_([0-9A-Za-z]{8})_[0-9A-Za-z]{40}$/,
  keyMark: 'kos_',
  keyWhere: 'Kubrik OS, Profile → API keys',
  gatewayPath: '/mcp/v1',
  site: 'erp',
  devSite: 'dev-erp',
  timeoutMs: 35_000,
  // One agent turn may take two minutes on the server (agentTimeoutSeconds).
  slowTools: { ask_agent: 150_000 },
};

class KubrikService extends KeyMcpService {
  constructor(options) {
    super(PRODUCT, options);
  }
}

module.exports = { KubrikService, MODULES, PRODUCT };
