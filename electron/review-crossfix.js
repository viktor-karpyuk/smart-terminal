'use strict';

/*
 * A fix that needs another repository, made there and offered as a pull
 * request of its own.
 *
 * The fix of a front-end finding said, in so many words, "the backend has to
 * return cashSessionOpenedAt first" — and stopped, because that is another
 * repository. When that repository is one the reviewer also has, stopping is
 * the wrong answer. Two steps, each a button:
 *
 *   prepare — a new branch in a separate copy of the other repository, from
 *             the branch the original pull request targets (or its default),
 *             the change made by Claude, committed, the check run. Nothing
 *             leaves the copy; the diff is shown.
 *   publish — the branch pushed (a new one, never forced) and a pull request
 *             opened for it. The front-end fix can then run again, told where
 *             the other half is.
 */

const fs = require('node:fs');
const path = require('node:path');
const rules = require('./review-rules');
const { describeEvent } = require('./review-engine');

const RUN_TIMEOUT = 30 * 60 * 1000;
const CHECK_TIMEOUT = 15 * 60 * 1000;

class CrossFix {
  constructor({ store, git, claude, engine, forge, scratch, language = () => 'español' }) {
    this.store = store;
    this.git = git;
    this.claude = claude;
    this.engine = engine;
    this.forge = forge;
    this.scratch = scratch;
    this.language = language;
  }

  key(fixId, index) {
    return `crossfix:${fixId}:${Number(index)}`;
  }

  state(fixId, index) {
    try {
      const raw = this.store.pref(this.key(fixId, index));
      return raw ? { ...JSON.parse(raw), busy: this.engine.activity.has(this.key(fixId, index)) } : null;
    } catch {
      return null;
    }
  }

  save(fixId, index, job, repoId, prId) {
    this.store.setPref(this.key(fixId, index), job ? JSON.stringify({ ...job, at: new Date().toISOString() }) : null);
    this.engine.changed(repoId, prId);
  }

  /** The repository a fix named, by its name as configured here (or its slug). */
  targetFor(name) {
    const wanted = String(name ?? '').trim().toLowerCase();
    return this.store.repos({ withHidden: true }).find((repo) => repo.name.toLowerCase() === wanted || String(repo.slug ?? '').toLowerCase() === wanted) ?? null;
  }

  context(fixId, index) {
    const fix = this.store.fix(fixId);
    if (!fix) throw new Error('That fix is gone.');
    const item = (fix.elsewhere ?? [])[Number(index)];
    if (!item) throw new Error('That fix did not ask for a change elsewhere.');
    const finding = this.store.finding(fix.findingId);
    const source = this.engine.requireRepo(fix.repoId);
    const pr = this.engine.prOrThrow(fix.repoId, fix.prId);
    const target = this.targetFor(item.repo);
    if (!target) throw new Error(`"${item.repo}" is not one of the repositories configured here. Add it on the Repositories page first.`);
    if (target.id === source.id) throw new Error('That is this same repository: the fix can be made here.');
    this.engine.requireClone(target);
    return { fix, item, finding, source, pr, target };
  }

  /** The branch the change starts from: the one the original pull request targets, when the other repository has it. */
  async baseFor(target, wanted) {
    const has = async (branch) => Boolean(branch) && (await this.git.run(target.localPath, ['ls-remote', '--exit-code', '--heads', 'origin', branch])).ok;
    if (await has(wanted)) return wanted;
    const head = await this.git.run(target.localPath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    const fallback = head.ok ? head.stdout.trim().replace(/^origin\//, '') : '';
    for (const branch of [fallback, 'develop', 'main', 'master']) if (await has(branch)) return branch;
    throw new Error(`Could not find a branch to start from in ${target.name}.`);
  }

  async prepare(fixId, index) {
    const { item, finding, source, pr, target } = this.context(fixId, index);
    const key = this.key(fixId, index);
    const activity = this.engine.activity;
    if (activity.has(key)) throw new Error('That change is already being made.');
    activity.start(key, { kind: 'crossfix', repoId: source.id, prId: pr.id, repoName: source.name, title: `${target.name}: ${finding?.title ?? ''}`.slice(0, 120) });
    this.save(fixId, index, { state: 'PREPARING', target: target.name }, source.id, pr.id);
    const log = (text) => activity.line(key, text);
    const dir = path.join(this.scratch, `crossfix-${rules.slug(target.name)}-${String(fixId).slice(0, 8)}-${Number(index)}`);
    try {
      const base = await this.baseFor(target, pr.targetBranch);
      log(`Starting from ${target.name} ${base}…`);
      const got = await this.engine.inClone(target.localPath, () => this.git.fetch(target.localPath, base));
      if (!got.ok) throw new Error(`Could not read ${base} of ${target.name}: ${String(got.output ?? '').slice(0, 300)}`);
      fs.rmSync(dir, { recursive: true, force: true });
      const cloned = await this.git.cloneLocal(target.localPath, dir);
      if (!cloned.ok) throw new Error(`Could not copy ${target.name}: ${String(cloned.output ?? '').slice(0, 300)}`);
      const upstream = `refs/remotes/upstream/${base}`;
      const fetched = await this.git.run(dir, ['fetch', 'origin', `+refs/remotes/origin/${base}:${upstream}`]);
      if (!fetched.ok) throw new Error(`Could not read ${base}: ${fetched.output.slice(0, 300)}`);
      const branch = await this.freeBranch(target, `${pr.sourceBranch}-for-${rules.slug(source.name)}`);
      const made = await this.git.run(dir, ['checkout', '-q', '-b', branch, upstream]);
      if (!made.ok) throw new Error(`Could not start ${branch}: ${made.output.slice(0, 300)}`);
      const start = await this.git.head(dir);

      const result = await this.claude.run({
        kind: 'fix',
        cwd: dir,
        prompt: crossFixPrompt({ item, finding, source, pr, target, base, branch, language: this.language() }),
        model: target.defaultModel || rules.DEPTHS.INTERMEDIATE.model,
        allowedTools: rules.FIX_TOOLS,
        disallowedTools: rules.FIX_DENIED,
        schema: CROSSFIX_SCHEMA,
        timeout: RUN_TIMEOUT,
        register: (handle) => activity.patch(key, { handle }),
        onEvent: (event) => log(describeEvent(event)),
      });
      if (!result.ok) throw new Error((result.stderr || 'It finished without a result.').slice(0, 500));
      const outcome = result.structured && typeof result.structured === 'object' ? result.structured : {};
      if (!(await this.git.isDirty(dir))) {
        throw new Error(`Nothing was changed in ${target.name}: ${String(outcome.reason || outcome.summary || 'no reason given').slice(0, 600)}`);
      }
      const title = String(outcome.title || `${item.change.split('\n')[0]}`).replace(/\s+/g, ' ').trim().slice(0, 120);
      const sha = await this.git.commitAll(dir, `${title}\n\nFor ${source.name} #${pr.id} (${pr.sourceBranch}).`);
      log(`Committed ${sha.slice(0, 7)} on ${branch} in the copy.`);
      const check = await this.check(target, dir, log);
      const stat = (await this.git.run(dir, ['diff', '--stat', start, sha])).stdout.trim().slice(0, 4000);
      const diff = (await this.git.run(dir, ['diff', start, sha])).stdout.slice(0, 200000);
      const job = { state: 'PREPARED', target: target.name, targetId: target.id, base, branch, sha, check, stat, diff, title, summary: String(outcome.summary ?? '').slice(0, 2000), dir };
      this.save(fixId, index, job, source.id, pr.id);
      return this.state(fixId, index);
    } catch (error) {
      this.save(fixId, index, { state: 'FAILED', target: target.name, error: String(error?.message ?? error).slice(0, 800) }, source.id, pr.id);
      throw error;
    } finally {
      activity.end(key);
      this.engine.changed(source.id, pr.id);
    }
  }

  /** A branch name nobody has on the remote yet: the plain one, or the plain one numbered. */
  async freeBranch(target, wanted) {
    const name = wanted.replace(/[^A-Za-z0-9._/-]+/g, '-').replace(/-+/g, '-');
    for (let n = 1; n < 20; n += 1) {
      const candidate = n === 1 ? name : `${name}-${n}`;
      const taken = (await this.git.run(target.localPath, ['ls-remote', '--exit-code', '--heads', 'origin', candidate])).ok;
      if (!taken) return candidate;
    }
    throw new Error(`Every name like ${name} is taken in ${target.name}.`);
  }

  async check(repo, dir, log) {
    const command = String(repo.checkCommand ?? '').trim();
    if (!command) return null;
    log(`Checking: ${command}`);
    const started = Date.now();
    const result = await this.git.shell(dir, command, { timeout: CHECK_TIMEOUT });
    const seconds = Math.round((Date.now() - started) / 1000);
    const state = result.timedOut ? 'TIMEOUT' : result.ok ? 'PASSED' : 'FAILED';
    log(state === 'PASSED' ? `Check passed in ${seconds}s.` : `Check ${state.toLowerCase()} after ${seconds}s.`);
    return { state, seconds, output: String(result.output ?? '').slice(-4000) };
  }

  /** The prepared branch pushed — new, never forced — and a pull request opened for it. */
  async publish(fixId, index) {
    const { finding, source, pr, target } = this.context(fixId, index);
    const job = this.state(fixId, index);
    if (!job || job.state !== 'PREPARED') throw new Error('There is no prepared change to publish.');
    if (!this.git.isRepo(job.dir)) throw new Error('The copy with the change is gone. Prepare it again.');
    const remote = await this.git.remoteUrl(target.localPath);
    if (!remote) throw new Error(`${target.name}'s clone has no origin to push to.`);
    const pushed = await this.git.run(job.dir, ['push', remote, `${job.sha}:refs/heads/${job.branch}`]);
    if (!pushed.ok) throw new Error(`Could not push ${job.branch}: ${pushed.output.slice(-300)}`);
    const description = [
      `${job.summary || job.title}`,
      '',
      `Needed by ${source.name} #${pr.id} — ${pr.title}${pr.url ? `\n${pr.url}` : ''}`,
      finding ? `\nFor the finding: ${finding.title}` : '',
    ].join('\n').trim();
    const opened = await this.forge.of(target).createPr({ title: job.title, description, source: job.branch, destination: job.base });
    const done = { ...job, state: 'OPENED', prId: opened.id, url: opened.url, diff: undefined };
    delete done.busy;
    this.save(fixId, index, done, source.id, pr.id);
    fs.rmSync(job.dir, { recursive: true, force: true });
    // So it shows on the dashboard and can be reviewed like any other.
    this.engine.refreshPrs(target.id, { force: true }).catch(() => null);
    return { ok: true, prId: opened.id, url: opened.url, repo: target.name, branch: job.branch };
  }

  discard(fixId, index) {
    const job = this.state(fixId, index);
    if (job?.busy) throw new Error('Still working on it. Cancel the run first.');
    if (job?.dir) fs.rmSync(job.dir, { recursive: true, force: true });
    const fix = this.store.fix(fixId);
    this.save(fixId, index, null, fix?.repoId, fix?.prId);
    return { ok: true };
  }
}

const CROSSFIX_SCHEMA = {
  type: 'object',
  properties: { title: { type: 'string' }, summary: { type: 'string' }, files: { type: 'array', items: { type: 'string' } }, reason: { type: 'string' } },
  required: ['title', 'summary'],
};

/** The other half of a fix, asked of the other repository. */
function crossFixPrompt({ item, finding, source, pr, target, base, branch, language }) {
  return [
    `Hay que hacer un cambio en ${target.name} para que otro repositorio, ${source.name}, pueda arreglar un problema.`,
    `Estás parado en una rama nueva, ${branch}, que sale de ${base}, en una copia aparte de ${target.name}.`,
    '',
    'POR QUÉ',
    `- PR de ${source.name}: #${pr.id} ${pr.title} (rama ${pr.sourceBranch})`,
    ...(finding ? [`- El hallazgo: ${finding.title}`, `  ${String(finding.body ?? '').replace(/\s+/g, ' ').slice(0, 1500)}`] : []),
    '',
    `LO QUE HACE FALTA EN ${target.name}`,
    item.change,
    '',
    'QUÉ TENÉS QUE HACER',
    '1. Encontrá dónde vive eso en este repositorio y hacé el cambio más chico que lo resuelva de verdad.',
    '2. Seguí cómo está hecho lo de alrededor: mismos nombres, mismas capas, mismo estilo.',
    '3. Si hay tests de lo que tocás y agregar uno es directo, agregalo.',
    '',
    'LÍMITES',
    '- Nada que no haga falta para esto. No reformatees, no renombres, no agregues dependencias.',
    '- No hagas commit ni push: de eso se encarga la herramienta.',
    '- Si no se puede hacer sin una decisión que no te corresponde, no toques nada y explicalo en reason.',
    '',
    'RESPUESTA',
    `El JSON del esquema: \`title\` (una línea, el título del commit y del PR, en ${language}), \`summary\``,
    `(qué cambiaste y por qué, dos a cuatro líneas en ${language}), \`files\`, y \`reason\` si no cambiaste nada.`,
  ].join('\n');
}

module.exports = { CrossFix, crossFixPrompt, CROSSFIX_SCHEMA };
