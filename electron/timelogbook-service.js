'use strict';

/**
 * Timelogbook v4, through the MCP servers its agent door exposes:
 * `https://mcp.timelogbook.com/<app>`, or the gateway's
 * `<api>/agent/mcp/v1/<app>`. A person makes an API key in Timelogbook
 * (Profile → API keys, `tlbk_<8>_<40>`). Everything about the key, the wire and
 * the rules is `KeyMcpService`; what is Timelogbook's own is which apps there
 * are and what a Claude session is handed about one task.
 */

const { KeyMcpService, KeyMcpError, apiBase: baseOf, mcpUrl: urlOf, siteOf: siteFor, cut } = require('./key-mcp-service');

/** The apps of the suite with a server (AppCode in Timelogbook; `home` delegates and has none). */
const APPS = ['me', 'tasks', 'projects', 'crm', 'people', 'billing', 'admin', 'marketing'];

const PRODUCT = {
  name: 'Timelogbook',
  table: 'tlb',
  apps: APPS,
  appNames: { me: 'My work', tasks: 'Tasks', projects: 'Projects', crm: 'CRM', people: 'People', billing: 'Billing', admin: 'Console', marketing: 'Marketing' },
  keyShape: /^tlbk_([0-9A-Za-z]{8})_[0-9A-Za-z]{40}$/,
  keyMark: 'tlbk_',
  keyWhere: 'Timelogbook, Profile → API keys',
  gatewayPath: '/agent/mcp/v1',
  site: 'app',
  devSite: 'dev',
  timeoutMs: 20_000,
};

const apiBase = (input) => baseOf(input, 'your Timelogbook');
const mcpUrl = (base, app) => urlOf(base, app, PRODUCT.gatewayPath);
const siteOf = (base) => siteFor(base, PRODUCT.site, PRODUCT.devSite);
/** The app a tool belongs to: its name starts with the app's code (`tasks_get_board`). */
const appOf = (tool) => {
  const head = String(tool ?? '').split('_')[0];
  return APPS.includes(head) ? head : null;
};
const keyPrefix = (key) => {
  const m = PRODUCT.keyShape.exec(String(key ?? ''));
  return m ? m[1] : null;
};

class TimelogbookService extends KeyMcpService {
  constructor(options) {
    super(PRODUCT, options);
  }

  /**
   * What a Claude session is handed about one task: what Timelogbook says of
   * it, in its own words, and what to do with it.
   */
  async brief({ key, title }) {
    const taskKey = String(key ?? '').trim();
    if (!taskKey) throw new KeyMcpError('Which task?');
    const lines = [`I am working on the Timelogbook task ${taskKey}${title ? ` — ${String(title).slice(0, 200)}` : ''}.`];
    const has = (name) => this.tools().some((t) => t.name === name);
    await this.reach();
    const facts = [];
    const tryRun = async (name, args) => {
      if (!has(name)) return;
      try {
        const r = await this.run(name, args);
        if (!r.isError && r.text) facts.push(`${name}:\n${cut(r.text, 12_000)}`);
      } catch (error) {
        this.log(`[timelogbook] brief: ${name} failed: ${error.message}`);
      }
    };
    // A personal task (T-42) opens in My work; a project task (KBK-12) in Tasks.
    if (/^T-\d+$/i.test(taskKey)) await tryRun('me_get_task', { key: taskKey });
    else await tryRun('tasks_get_task', { key: taskKey });
    if (!facts.length) await tryRun('me_search_my_tasks', { q: taskKey });
    if (facts.length) lines.push('', 'What Timelogbook says about it:', '', ...facts);
    lines.push('', this.claudeOn()
      ? 'You can read more from Timelogbook with the timelogbook MCP tools (comments, the board, the sprint). Read the task, look at this repository, and tell me how you would approach it before changing anything.'
      : 'Read the task, look at this repository, and tell me how you would approach it before changing anything.');
    return { ok: true, title: taskKey, text: lines.join('\n') };
  }

  async extraVerb(name, args) {
    if (name === 'brief') return this.brief(args);
    return undefined;
  }
}

module.exports = { TimelogbookService, TimelogbookError: KeyMcpError, apiBase, mcpUrl, siteOf, appOf, keyPrefix, APPS };
