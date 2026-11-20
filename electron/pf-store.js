'use strict';

const crypto = require('node:crypto');

/**
 * What the Port Forward extension remembers: the forwards somebody defined,
 * the groups they sit in, and the profiles — named sets of forwards that are
 * switched on together.
 *
 * Its own tables in the app's database, prefixed `pf_`, created if they are not
 * there — the same way Databases, Jenkins and Teams keep theirs. Nothing here
 * is a secret: a forward is a cluster's name, a namespace, a target and ports.
 * The credentials are kubeconfig's, and stay there.
 */

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS pf_group (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL UNIQUE,
     position INTEGER NOT NULL DEFAULT 0
   );
   CREATE TABLE IF NOT EXISTS pf_forward (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     context TEXT NOT NULL DEFAULT '',
     namespace TEXT NOT NULL DEFAULT '',
     kind TEXT NOT NULL DEFAULT 'pod',
     target TEXT NOT NULL,
     ports TEXT NOT NULL,
     address TEXT NOT NULL DEFAULT '127.0.0.1',
     auto_start INTEGER NOT NULL DEFAULT 0,
     auto_restart INTEGER NOT NULL DEFAULT 1,
     ttl_minutes INTEGER NOT NULL DEFAULT 0,
     group_id TEXT,
     position INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL
   );
   CREATE TABLE IF NOT EXISTS pf_profile (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL UNIQUE
   );
   CREATE TABLE IF NOT EXISTS pf_profile_forward (
     profile_id TEXT NOT NULL,
     forward_id TEXT NOT NULL,
     PRIMARY KEY (profile_id, forward_id)
   );`,
];

const MAX_FORWARDS = 500;
const MAX_GROUPS = 100;
const MAX_PROFILES = 100;
/** Ports of one target carried by one kubectl. More than this is a mistake, not a forward. */
const MAX_PORTS = 12;

/** What kubectl can resolve to a pod. The same list the Kubernetes panel forwards to. */
const KINDS = ['pod', 'service', 'deployment', 'statefulset', 'replicaset', 'daemonset'];

/**
 * Where a forward may listen. An address, or `localhost`; nothing else is
 * passed to `--address`. `0.0.0.0` is allowed and is asked about first — it
 * makes the port reachable by everybody on the network.
 */
function isAddress(value) {
  const text = String(value ?? '');
  if (text === 'localhost') return true;
  const parts = text.split('.');
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function port(value, what, { zero = false } = {}) {
  const number = Number(value);
  if (!Number.isInteger(number) || number > 65535 || number < (zero ? 0 : 1)) {
    throw new Error(zero ? `${what} is a port between 1 and 65535, or empty to be given one` : `${what} is a port between 1 and 65535`);
  }
  return number;
}

/** A name that cannot be mistaken for a flag by kubectl. */
function argument(value, what, max = 253) {
  const text = String(value ?? '').trim().slice(0, max);
  if (!text) throw new Error(`${what} is missing`);
  if (text.startsWith('-')) throw new Error(`${what} cannot start with "-"`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\s]/.test(text)) throw new Error(`${what} cannot contain spaces`);
  return text;
}

/** What a form sent, checked and made regular. Throws with a sentence when it is not a forward. */
function cleanForward(input) {
  const given = input && typeof input === 'object' ? input : {};
  const kind = String(given.kind ?? 'pod').toLowerCase();
  if (!KINDS.includes(kind)) throw new Error(`A ${kind || 'thing like that'} cannot be forwarded to`);
  const target = argument(given.target, 'The name of what to forward to');
  const namespace = argument(given.namespace || 'default', 'The namespace');
  const context = String(given.context ?? '').trim().slice(0, 400);
  if (context.startsWith('-')) throw new Error('The cluster cannot start with "-"');
  const list = Array.isArray(given.ports) ? given.ports : [];
  if (!list.length) throw new Error('A forward needs at least one port');
  if (list.length > MAX_PORTS) throw new Error(`A forward carries at most ${MAX_PORTS} ports`);
  const ports = list.map((one) => ({
    local: port(one?.local === '' || one?.local == null ? 0 : one.local, 'The local port', { zero: true }),
    remote: port(one?.remote, 'The port to forward to'),
  }));
  const taken = ports.map((one) => one.local).filter(Boolean);
  if (new Set(taken).size !== taken.length) throw new Error('Two of its ports ask for the same local port');
  const address = String(given.address ?? '127.0.0.1').trim() || '127.0.0.1';
  if (!isAddress(address)) throw new Error('The address to listen on is 127.0.0.1, localhost, 0.0.0.0 or another address of this machine');
  const ttl = Number(given.ttlMinutes ?? 0);
  return {
    name: String(given.name ?? '').trim().slice(0, 120) || target,
    context,
    namespace,
    kind,
    target,
    ports,
    address,
    autoStart: given.autoStart === true,
    autoRestart: given.autoRestart !== false,
    ttlMinutes: Number.isInteger(ttl) && ttl > 0 ? Math.min(ttl, 7 * 24 * 60) : 0,
    groupId: given.groupId ? String(given.groupId) : null,
  };
}

/** Two forwards that would be the same kubectl: what an import uses to not add one twice. */
function signature(forward) {
  const ports = forward.ports.map((one) => `${one.local}:${one.remote}`).join(',');
  return [forward.context, forward.namespace, forward.kind, forward.target, ports].join('\u0001');
}

class PfStore {
  constructor(db) {
    this.db = db;
    db.exec('CREATE TABLE IF NOT EXISTS pf_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    const row = db.prepare("SELECT v FROM pf_meta WHERE k = 'version'").get();
    let version = Number(row?.v ?? 0);
    for (; version < MIGRATIONS.length; version += 1) {
      db.exec(MIGRATIONS[version]);
      db.prepare("INSERT INTO pf_meta (k, v) VALUES ('version', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v").run(String(version + 1));
    }
  }

  #shown(row) {
    let ports = [];
    try {
      ports = JSON.parse(row.ports);
    } catch {
      ports = [];
    }
    return {
      id: row.id,
      name: row.name,
      context: row.context,
      namespace: row.namespace,
      kind: row.kind,
      target: row.target,
      ports: Array.isArray(ports) ? ports.map((one) => ({ local: Number(one.local) || 0, remote: Number(one.remote) || 0 })) : [],
      address: row.address,
      autoStart: row.auto_start === 1,
      autoRestart: row.auto_restart === 1,
      ttlMinutes: row.ttl_minutes,
      groupId: row.group_id ?? null,
    };
  }

  forwards() {
    return this.db.prepare('SELECT * FROM pf_forward ORDER BY position, name COLLATE NOCASE').all().map((row) => this.#shown(row));
  }

  forward(id) {
    const row = this.db.prepare('SELECT * FROM pf_forward WHERE id = ?').get(String(id ?? ''));
    return row ? this.#shown(row) : null;
  }

  /** Add a forward, or change the one whose id this carries. */
  saveForward(input) {
    const clean = cleanForward(input);
    if (clean.groupId && !this.group(clean.groupId)) clean.groupId = null;
    const id = input?.id ? String(input.id) : null;
    if (id) {
      if (!this.forward(id)) throw new Error('That forward is not here any more');
      this.db
        .prepare(
          `UPDATE pf_forward SET name = ?, context = ?, namespace = ?, kind = ?, target = ?, ports = ?, address = ?,
             auto_start = ?, auto_restart = ?, ttl_minutes = ?, group_id = ? WHERE id = ?`,
        )
        .run(clean.name, clean.context, clean.namespace, clean.kind, clean.target, JSON.stringify(clean.ports), clean.address,
          clean.autoStart ? 1 : 0, clean.autoRestart ? 1 : 0, clean.ttlMinutes, clean.groupId, id);
      return this.forward(id);
    }
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM pf_forward').get().n;
    if (count >= MAX_FORWARDS) throw new Error(`There are already ${MAX_FORWARDS} forwards. Remove one first.`);
    const fresh = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO pf_forward (id, name, context, namespace, kind, target, ports, address, auto_start, auto_restart, ttl_minutes, group_id, position, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(fresh, clean.name, clean.context, clean.namespace, clean.kind, clean.target, JSON.stringify(clean.ports), clean.address,
        clean.autoStart ? 1 : 0, clean.autoRestart ? 1 : 0, clean.ttlMinutes, clean.groupId, count, Date.now());
    return this.forward(fresh);
  }

  removeForward(id) {
    const key = String(id ?? '');
    this.db.prepare('DELETE FROM pf_profile_forward WHERE forward_id = ?').run(key);
    return this.db.prepare('DELETE FROM pf_forward WHERE id = ?').run(key).changes > 0;
  }

  groups() {
    return this.db.prepare('SELECT id, name FROM pf_group ORDER BY position, name COLLATE NOCASE').all().map((row) => ({ id: row.id, name: row.name }));
  }

  group(id) {
    const row = this.db.prepare('SELECT id, name FROM pf_group WHERE id = ?').get(String(id ?? ''));
    return row ? { id: row.id, name: row.name } : null;
  }

  groupNamed(name) {
    const row = this.db.prepare('SELECT id, name FROM pf_group WHERE name = ? COLLATE NOCASE').get(String(name ?? ''));
    return row ? { id: row.id, name: row.name } : null;
  }

  /** Add a group, or rename one. A name already in use is that group, not an error: importing twice makes nothing twice. */
  saveGroup({ id, name } = {}) {
    const text = String(name ?? '').trim().slice(0, 80);
    if (!text) throw new Error('A group needs a name');
    const same = this.groupNamed(text);
    if (id) {
      if (same && same.id !== String(id)) throw new Error(`There is already a group called ${text}`);
      if (!this.db.prepare('UPDATE pf_group SET name = ? WHERE id = ?').run(text, String(id)).changes) throw new Error('That group is not here any more');
      return this.group(id);
    }
    if (same) return same;
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM pf_group').get().n;
    if (count >= MAX_GROUPS) throw new Error(`There are already ${MAX_GROUPS} groups`);
    const fresh = crypto.randomUUID();
    this.db.prepare('INSERT INTO pf_group (id, name, position) VALUES (?, ?, ?)').run(fresh, text, count);
    return this.group(fresh);
  }

  /** The group goes; what was in it stays, in no group. */
  removeGroup(id) {
    const key = String(id ?? '');
    this.db.prepare('UPDATE pf_forward SET group_id = NULL WHERE group_id = ?').run(key);
    return this.db.prepare('DELETE FROM pf_group WHERE id = ?').run(key).changes > 0;
  }

  profiles() {
    const members = this.db.prepare('SELECT forward_id FROM pf_profile_forward WHERE profile_id = ?');
    return this.db.prepare('SELECT id, name FROM pf_profile ORDER BY name COLLATE NOCASE').all().map((row) => ({
      id: row.id,
      name: row.name,
      forwards: members.all(row.id).map((one) => one.forward_id),
    }));
  }

  profile(id) {
    return this.profiles().find((one) => one.id === String(id ?? '')) ?? null;
  }

  /** A profile is a name and the forwards that are on in it. Saving one under a name in use replaces what that one holds. */
  saveProfile({ id, name, forwards } = {}) {
    const text = String(name ?? '').trim().slice(0, 80);
    if (!text) throw new Error('A profile needs a name');
    const known = new Set(this.forwards().map((one) => one.id));
    const members = [...new Set((Array.isArray(forwards) ? forwards : []).map(String))].filter((one) => known.has(one));
    const same = this.db.prepare('SELECT id FROM pf_profile WHERE name = ? COLLATE NOCASE').get(text);
    let key = id ? String(id) : same?.id ?? null;
    if (id && same && same.id !== key) throw new Error(`There is already a profile called ${text}`);
    if (key) {
      if (!this.db.prepare('UPDATE pf_profile SET name = ? WHERE id = ?').run(text, key).changes) throw new Error('That profile is not here any more');
    } else {
      const count = this.db.prepare('SELECT COUNT(*) AS n FROM pf_profile').get().n;
      if (count >= MAX_PROFILES) throw new Error(`There are already ${MAX_PROFILES} profiles`);
      key = crypto.randomUUID();
      this.db.prepare('INSERT INTO pf_profile (id, name) VALUES (?, ?)').run(key, text);
    }
    this.db.prepare('DELETE FROM pf_profile_forward WHERE profile_id = ?').run(key);
    const add = this.db.prepare('INSERT OR IGNORE INTO pf_profile_forward (profile_id, forward_id) VALUES (?, ?)');
    for (const member of members) add.run(key, member);
    return this.profile(key);
  }

  removeProfile(id) {
    const key = String(id ?? '');
    this.db.prepare('DELETE FROM pf_profile_forward WHERE profile_id = ?').run(key);
    return this.db.prepare('DELETE FROM pf_profile WHERE id = ?').run(key).changes > 0;
  }
}

module.exports = { PfStore, cleanForward, signature, isAddress, KINDS, MAX_PORTS };
