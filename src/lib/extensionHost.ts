/**
 * Hosting a whole view that came with an extension.
 *
 * A preview was easy to make safe: text in, HTML out, run in a worker with no
 * DOM and shown in a frame that runs no scripts. A panel cannot work that way,
 * because a panel is worked in — it has to answer a click, ask a question and
 * draw the answer. So it gets scripts, and the question becomes where.
 *
 * In a frame with `sandbox="allow-scripts"` and deliberately *not*
 * `allow-same-origin`. That combination puts the document in an opaque origin
 * of its own: it cannot touch this page, cannot read a cookie or a stored value
 * belonging to the app, has no `window.api`, no `require`, no filesystem, and
 * no way to navigate anything but itself. Everything it wants from the app it
 * has to ask for by message, and every message lands on the table below, which
 * is a fixed list of names rather than anything derived from what was asked.
 *
 * Two things remain true and are said rather than implied. Such a frame can
 * still reach the network — the renderer has no CSP yet, which is the next
 * thing worth closing. And a panel can be wrong: it can throw, hang or draw
 * nonsense. It cannot take the app with it, which is the line that matters.
 */

/** Reading the repository. Free: none of it changes anything. */
const READ_VERBS = [
  'root',
  'status',
  'graph',
  'refs',
  'compare',
  'commitFiles',
  'head',
  'diff',
] as const;

/**
 * Changing the repository.
 *
 * Allowed, because a graph you cannot check out a branch from is a picture, not
 * a tool — and an extension was installed on purpose, from the repository, by
 * somebody who wanted what it does. What it is not allowed to do is anything
 * that is not on this list.
 */
const WRITE_VERBS = [
  'stage',
  'unstage',
  'commit',
  'push',
  'pull',
  'fetch',
  'checkout',
  'createBranch',
  'renameBranch',
  'trackRemote',
  'deleteBranch',
  'merge',
  'rebase',
  'abortMerge',
  'revert',
  'stash',
  'stashPop',
] as const;

/**
 * Reading a cluster. Free, in the same sense: none of it changes anything.
 *
 * Namespaced, unlike the git verbs, because there are now two things an
 * extension can be talking to and a bare `list` would not say which. The git
 * names stay bare so the graph extension keeps working; anything new is
 * prefixed.
 */
const KUBE_READ = [
  'can',
  'contexts',
  'reachable',
  'resources',
  'list',
  'manifest',
  'object',
  'describe',
  'logs',
  'events',
  'top',
  'summary',
  'topology',
  'plan',
  'brief',
  'prometheus',
  'history',
  'promQuery',
  'promNow',
] as const;

/**
 * Changing a cluster.
 *
 * A shorter list than git's, and deliberately so. There is no `drain`, no
 * `cordon` of a whole pool, no `edit`, no `exec` that runs a command of the
 * extension's choosing. What is here is what a dashboard is for: take one thing
 * away, make more or fewer of it, roll it, put an edited manifest back.
 */
const KUBE_WRITE = [
  'remove',
  'scale',
  'restart',
  'apply',
  'configure',
  'cordon',
  'cordonMany',
  'rollback',
  'pause',
  'suspend',
  'trigger',
] as const;

/**
 * The long-running ones: following a log, holding a port open, and watching a
 * kind for changes — which is the same shape as the other two and replaces the
 * asking-again that a table would otherwise have to do.
 */
const KUBE_STREAM = ['follow', 'stopFollow', 'forward', 'stopForward', 'forwards', 'openForward', 'watch', 'stopWatch', 'drain'] as const;

/**
 * The two that reach into the app rather than into a cluster.
 *
 * `shell` opens a real terminal tab running `kubectl exec` — a real pty, with a
 * real TTY, because a shell drawn inside a panel is a toy and everybody who has
 * used one knows it. `ask` opens a Claude session that has already been handed
 * everything about the object.
 *
 * Neither takes a command or a prompt from the extension. It names an object;
 * the app writes the command line and the app writes the words. That is the
 * whole reason these can exist at all: an extension that could compose the text
 * going into a Claude session could ask it to do anything.
 */
const KUBE_APP = ['shell', 'terminal', 'ask', 'askPlan'] as const;

/**
 * Helm, which is a different tool and gets a different door.
 *
 * Reading is free. Of the three that change something, two can take a running
 * system away — a rollback replaces what is deployed with what used to be, and
 * an uninstall removes the lot — so both stop and ask.
 */
const HELM_READ = ['version', 'releases', 'history', 'values', 'manifest', 'notes'] as const;
const HELM_WRITE = ['rollback', 'uninstall'] as const;

/**
 * Maven and Gradle.
 *
 * Reading is the project's own files and, for Gradle, one question put to
 * Gradle itself. There is no write verb at all: a build panel changes nothing
 * on disk by itself. The one thing that is not a read is `run`, which opens a
 * real terminal under the panel with the goal in it — and like `kube.shell`,
 * the panel names the goal and the app writes the command line.
 */
const BUILD_READ = ['root', 'project', 'tasks', 'dependencies'] as const;
const BUILD_APP = ['run'] as const;

const BUILD_VERBS = new Map<string, Channel>([
  ...BUILD_READ.map((name) => [name, 'build'] as [string, Channel]),
  ...BUILD_APP.map((name) => [name, 'app'] as [string, Channel]),
]);

const HELM_VERBS = new Map<string, Channel>([
  ...HELM_READ.map((name) => [name, 'helm'] as [string, Channel]),
  ...HELM_WRITE.map((name) => [name, 'helm'] as [string, Channel]),
]);

/**
 * Spring Boot, which is the app's own machine rather than a cluster.
 *
 * Reading is the folder and the running things. Starting and stopping change
 * nothing that is not the person's own process, so neither stops to ask — an
 * IDE does not ask before Run, and this is that button. `shell` and `ask` are
 * the same two doors into the app as the cluster's, and take the same shape:
 * the panel names an application or a run, the app writes the words.
 */
const SPRING_READ = ['projects', 'jdks', 'configs', 'runs', 'output', 'actuator', 'brief'] as const;
const SPRING_WRITE = ['saveConfig', 'start', 'stop', 'forget', 'setLogLevel'] as const;
const SPRING_APP = ['shell', 'ask', 'debugger'] as const;

const SPRING_VERBS = new Map<string, Channel>([
  ...SPRING_READ.map((name) => [name, 'spring'] as [string, Channel]),
  ...SPRING_WRITE.map((name) => [name, 'spring'] as [string, Channel]),
  ...SPRING_APP.map((name) => [name, 'app'] as [string, Channel]),
]);

/**
 * Code Reviewer, which reviews pull requests with the person's own Claude Code.
 *
 * Reading costs nothing. Most writing is ordinary and reversible — a review is
 * a draft, a finding is published with a click, a fix is written in a workshop
 * copy — so it does not stop to ask; the reviewer this clones puts a modal only
 * in front of what cannot be taken back, and so does this list (see
 * `needsConsent`). `shell` and `ask` are the app's doors, not the reviewer's:
 * a terminal in the clone or the workshop, and a Claude session handed a brief
 * the app wrote.
 */
const REVIEW_READ = [
  'fixDiff', 'workshopDiff', 'due',
  'overview', 'dashboard', 'repos', 'repo', 'prs', 'pr', 'files', 'diff', 'commits', 'commitFiles', 'commitDiff',
  'guidelines', 'usage', 'activity', 'viewed', 'fileText', 'importInspect', 'models', 'depths', 'rerunCheck', 'followUpText', 'brief', 'paths', 'migrationInventory',
  'detectRemote', 'bus',
  'fixTimes', 'watchBudget', 'migrationClashes', 'previewFix',
] as const;
const REVIEW_WRITE = [
  'pickFolder', 'saveRepo', 'testRepo', 'deleteRepo', 'hideRepo', 'saveSettings', 'saveGuideline', 'deleteGuideline',
  'importClaudeMd', 'importRun', 'setViewed', 'replyToComment', 'autoRunNow', 'openUrl', 'refreshPrs', 'refreshAll', 'searchHistory', 'loadPr',
  'review', 'reviewMany', 'cancel', 'cancelRun', 'verify', 'finalPass', 'saveReviewBody', 'publishReview', 'publishFinding',
  'publishAll', 'recheckFinding', 'dismissFinding', 'closeFinding', 'settleFinding', 'editFinding', 'addNote', 'updateNote', 'deleteNote', 'publishNote',
  'checkConflicts', 'checkMigrations', 'migrationPlan', 'renumberMigrations',
  'conflictsAnalyze', 'conflictsResolve', 'conflictsPush', 'conflictsDiscard', 'conflictsCancel', 'tellConflicts', 'notifyFindings', 'matchAuthor',
  'crossfixPrepare', 'crossfixPublish', 'crossfixDiscard',
  'draftReply', 'draftAll', 'saveReplyDraft', 'publishReply', 'dismissReply', 'dismissAllReplies', 'followUp',
  'adopt', 'closeRequest', 'fix', 'fixAll', 'retryFixReply', 'giveBack', 'discardWorkshop', 'push', 'dropFix',
  'setWorkshopBrief', 'setFixDepth', 'setFixPresets', 'addWorkshopTask',
  'remind', 'sweepReminders', 'escalateNow', 'speak',
  'approve', 'unapprove', 'requestChanges', 'undoRequestChanges', 'decline', 'merge',
] as const;
const REVIEW_APP = ['shell', 'ask'] as const;

/**
 * Something worth saying, to somebody, from any extension at all.
 *
 * Routed through the app rather than at a delivery extension by name: the
 * caller says who and what, and the app decides which installed extension
 * carries it. A panel that could name another extension's service would be a
 * panel that can speak as somebody else — and a caller that named Teams would
 * have to be rewritten the day a Slack one arrives.
 */
const DELIVER = 'deliver';

/**
 * The Teams panel's own calls.
 *
 * `send` is deliberately not among them. An extension asks the *app* to deliver
 * something and the app decides which delivery extension answers — a panel that
 * could call another extension's service by name is a panel that can speak as
 * somebody else.
 */
const TEAMS_READ = ['overview', 'botState'] as const;
const TEAMS_WRITE = ['saveConnection', 'saveSettings', 'test', 'saveChannel', 'forgetChannel', 'testChannel', 'compose', 'setAppStance', 'setAppCap', 'matchPerson', 'approve', 'skip', 'retry', 'saveBot', 'renameBotRoom', 'forgetBotRoom', 'signIn', 'signOut'] as const;
// `deliverFor` is deliberately absent: the app makes that call, naming the
// caller itself, so no panel can send under another extension's name.
const TEAMS_VERBS = new Map<string, Channel>(
  [...TEAMS_READ, ...TEAMS_WRITE].map((name) => [name, 'teams'] as [string, Channel]),
);

/**
 * Jenkins. Reading is separate from changing, and "changing" includes the
 * servers themselves: `testServer` makes a request to whatever address it is
 * given, with whatever credentials it is given, so an extension that may only
 * read builds must not be able to point it somewhere else.
 */
const JENKINS_READ = [
  'overview', 'home', 'tree', 'views', 'viewJobs', 'smart', 'search', 'job', 'build', 'stages', 'log',
  'followLog', 'stopLog', 'brief', 'queue', 'agents', 'archive',
  // The dashboard: what is running, what happened over a range, and what was running at one moment.
  'dashboard', 'timeline', 'runningAt',
  // Why a build failed and why one does not start; checking a Jenkinsfile; what the local archive remembers.
  'failingStep', 'whyNotRunning', 'lint', 'replayScript', 'searchArchive', 'seenBefore', 'notes', 'link', 'presets',
  // Whether Claude sessions may look at Jenkins, and what they looked at.
  'claudeAccess',
  // Launching: what to launch next and with what, what was launched before, the services-by-environment board, and the dashboard's richer views.
  'launchpad', 'launchHistory', 'launchPlan', 'paramPlan', 'promoteCandidates', 'schedules', 'board', 'heatmap', 'insights', 'report', 'wallboard',
  // What the person is told about, per server — and a panel saying it is looking, so the server is read often while it is.
  'notifySettings', 'watch', 'teamsRooms',
  // Waiting for an approval, what changed since the last green build, and the test results.
  'pendingInput', 'compare', 'tests',
] as const;
const JENKINS_WRITE = [
  'saveServer', 'testServer', 'deleteServer', 'run', 'stop', 'follow', 'favorite', 'cancelQueued',
  // What finished builds leave on this computer: how much, for how long, and getting rid of it.
  'archiveSettings', 'save', 'forget',
  // Servers from a JSON file the person picks: it adds credentials, so it is the servers' own permission.
  'importServers',
  // The same file the other way: it writes the tokens in the clear, so it is a change and asks first.
  'exportServers',
  // Starting builds in new ways, and what is kept only on this computer (notes, parameter sets).
  'replay', 'restartFromStage', 'noteSet', 'noteDelete', 'openInBrowser', 'presetSave', 'presetDelete',
  'claudeAccessSave',
  // Starting several builds, promoting one environment's build to the next, and starting one later.
  'runMany', 'promote', 'scheduleRun', 'scheduleCancel', 'boardSettings',
  // Asking the job's own script on Jenkins what its reactive parameters hold for the values the form has now (it runs that script).
  'paramRefresh',
  'notifySettingsSave', 'teamsRoomSave',
  // Answering a pipeline's question, starting a build again, switching a job or an agent on and off.
  'inputSubmit', 'inputAbort', 'rebuild', 'jobEnabled', 'nodeToggle',
  /*
   * Certificates. Looking at one is a WRITE on purpose: `certificate` opens a
   * connection to whatever address it is given, so an extension that may only
   * read builds must not be able to probe addresses with it — the same reason
   * `testServer` is here.
   */
  'certificate', 'trustCertificate', 'forgetCertificate',
] as const;
/** A Claude session handed what the app gathered about a build. */
const JENKINS_APP = ['ask'] as const;
/**
 * Remote: the phone's server. Its panel is the only thing that should touch it —
 * turning it on opens a port — so no permission grants these to an extension from
 * outside; `permissionFor` says so.
 */
const REMOTE_READ = ['overview', 'status'] as const;
const REMOTE_WRITE = ['setEnabled', 'setPort', 'setBind', 'pair', 'cancelPairing', 'revoke', 'disconnect', 'release', 'open'] as const;
const REMOTE_VERBS = new Map<string, Channel>(
  [...REMOTE_READ, ...REMOTE_WRITE].map((name) => [name, 'remote'] as [string, Channel]),
);

/**
 * Timelogbook. `connect` sends the key to whatever address it is given, so it
 * is a write for the same reason Jenkins' `testServer` is; `run` is a write
 * because a tool may change things — the app asks the person before any tool
 * Timelogbook does not mark read-only, whoever asked, unless the person switched
 * that off for Claude sessions (`writesAccessSave`).
 */
const TIMELOGBOOK_READ = ['overview', 'brief', 'claudeAccess'] as const;
const TIMELOGBOOK_WRITE = ['connect', 'disconnect', 'run', 'claudeAccessSave', 'writesAccessSave', 'openInBrowser', 'openLink'] as const;
/** A Claude session handed a task. */
const TIMELOGBOOK_APP = ['ask'] as const;
const TIMELOGBOOK_VERBS = new Map<string, Channel>([
  ...TIMELOGBOOK_READ.map((name) => [name, 'timelogbook'] as [string, Channel]),
  ...TIMELOGBOOK_WRITE.map((name) => [name, 'timelogbook'] as [string, Channel]),
  ...TIMELOGBOOK_APP.map((name) => [name, 'app'] as [string, Channel]),
]);

/** Kubrik OS: the same door as Timelogbook, to the ERP's MCP gateway. */
const KUBRIK_READ = ['overview', 'claudeAccess'] as const;
const KUBRIK_WRITE = ['connect', 'disconnect', 'run', 'claudeAccessSave', 'openInBrowser', 'openLink'] as const;
const KUBRIK_VERBS = new Map<string, Channel>(
  [...KUBRIK_READ, ...KUBRIK_WRITE].map((name) => [name, 'kubrik'] as [string, Channel]),
);

const JENKINS_VERBS = new Map<string, Channel>([
  ...JENKINS_READ.map((name) => [name, 'jenkins'] as [string, Channel]),
  ...JENKINS_WRITE.map((name) => [name, 'jenkins'] as [string, Channel]),
  ...JENKINS_APP.map((name) => [name, 'app'] as [string, Channel]),
]);

/**
 * Databases. Reading is the catalog and a table's rows, through connections
 * the person already saved. Everything that sends SQL of the panel's writing
 * is a change, and so is anything that names an address: `testConnection`
 * opens a connection to whatever host it is given, exactly like Jenkins'
 * `testServer`.
 */
const DB_READ = [
  'overview', 'parseUrl', 'databases', 'schemas', 'objects', 'table', 'routine', 'info', 'rows', 'count', 'history', 'activity', 'roles',
  // Pages that are only read — statistics, dependencies, privileges, locks, configuration — and the dashboard's counters.
  'report', 'metrics',
  // Everything a schema defines, to compare it with another.
  'snapshot',
  // What the readings of a watched server add up to. Read from this computer, not from the server.
  'trends',
  // One scheduled job, as a form needs it.
  'job',
  // Whether a routine can be stepped through, and what it takes.
  'debugInfo',
] as const;
const DB_WRITE = [
  'saveConnection', 'testConnection', 'deleteConnection', 'disconnect', 'pickFile',
  'query', 'cancel', 'closeTab', 'applyChanges', 'export', 'kill',
  'clearHistory', 'saveQuery', 'deleteQuery',
  // pg_dump, mysqldump and the way back. The file is chosen in the system's own dialog, never named by a panel.
  'backup', 'restore',
  // Rows from a file the person picks in the system's dialog: a preview first, then the import, all of it or none.
  'importPreview', 'importRun',
  // A script read from, and written to, a file chosen in the system's dialog.
  'openScript', 'saveScript',
  // Roles and users: made, changed and dropped by the app, which is the only place their password is ever written out.
  'role',
  // Having a server read every few minutes, and what is done about what that finds.
  'watch', 'readNow', 'dismissAlert',
  // Stepping through a PL/pgSQL routine, which runs it.
  'debugStart', 'debugStep', 'debugBreak', 'debugStop',
] as const;
/** A Claude session handed a table's definition, or the statement that just failed. The app gathers both. */
/** And a real terminal running the database's own client — psql, mysql, sqlite3 — already connected. The app writes the command line. */
const DB_APP = ['ask', 'shell'] as const;
const DB_VERBS = new Map<string, Channel>([
  ...DB_READ.map((name) => [name, 'db'] as [string, Channel]),
  ...DB_WRITE.map((name) => [name, 'db'] as [string, Channel]),
  ...DB_APP.map((name) => [name, 'app'] as [string, Channel]),
]);

const REVIEW_VERBS = new Map<string, Channel>([
  ...REVIEW_READ.map((name) => [name, 'review'] as [string, Channel]),
  ...REVIEW_WRITE.map((name) => [name, 'review'] as [string, Channel]),
  ...REVIEW_APP.map((name) => [name, 'app'] as [string, Channel]),
]);

const GIT_VERBS = new Set<string>([...READ_VERBS, ...WRITE_VERBS]);
const KUBE_VERBS = new Map<string, Channel>([
  ...KUBE_READ.map((name) => [name, 'kube'] as [string, Channel]),
  ...KUBE_WRITE.map((name) => [name, 'kube'] as [string, Channel]),
  ...KUBE_STREAM.map((name) => [name, 'kube-stream'] as [string, Channel]),
  ...KUBE_APP.map((name) => [name, 'app'] as [string, Channel]),
]);

export type Channel = 'git' | 'kube' | 'kube-stream' | 'app' | 'helm' | 'spring' | 'build' | 'review' | 'teams' | 'jenkins' | 'remote' | 'timelogbook' | 'kubrik' | 'db';

/**
 * Which door a call goes through, or none.
 *
 * One function rather than a set of names, because the answer is no longer only
 * yes or no: a panel now talks to two different subsystems and to the app
 * itself, and the routing is the security boundary. Anything not named here
 * does not run — there is no default channel.
 */
export function route(name: string): Channel | null {
  if (name === DELIVER) return 'app';
  if (GIT_VERBS.has(name)) return 'git';
  if (name.startsWith('kube.')) return KUBE_VERBS.get(name.slice(5)) ?? null;
  if (name.startsWith('helm.')) return HELM_VERBS.get(name.slice(5)) ?? null;
  if (name.startsWith('spring.')) return SPRING_VERBS.get(name.slice(7)) ?? null;
  if (name.startsWith('build.')) return BUILD_VERBS.get(name.slice(6)) ?? null;
  if (name.startsWith('review.')) return REVIEW_VERBS.get(name.slice(7)) ?? null;
  if (name.startsWith('teams.')) return TEAMS_VERBS.get(name.slice(6)) ?? null;
  if (name.startsWith('jenkins.')) return JENKINS_VERBS.get(name.slice(8)) ?? null;
  if (name.startsWith('remote.')) return REMOTE_VERBS.get(name.slice(7)) ?? null;
  if (name.startsWith('timelogbook.')) return TIMELOGBOOK_VERBS.get(name.slice(12)) ?? null;
  if (name.startsWith('kubrik.')) return KUBRIK_VERBS.get(name.slice(7)) ?? null;
  if (name.startsWith('db.')) return DB_VERBS.get(name.slice(3)) ?? null;
  return null;
}

/**
 * What an extension from outside the app may ask for, in words a person can
 * decide about. The same list as electron/extension-permissions.js; a test holds
 * them together.
 */
export const PERMISSIONS: Record<string, string> = {
  'git.read': 'Read the repository open in its panel: history, branches, changes',
  'git.write': 'Change that repository: commit, push, pull, switch and delete branches',
  'kube.read': 'Read your Kubernetes clusters: resources, logs, events',
  'kube.write': 'Change your clusters: delete, scale, restart, apply, forward ports',
  'helm.read': 'Read Helm releases and their values',
  'helm.write': 'Roll back or uninstall Helm releases',
  build: 'Read Maven and Gradle projects',
  spring: 'Run and stop Spring Boot applications',
  review: 'Use the Code Reviewer: pull requests, findings, comments, merges',
  teams: "Change the Teams connection's settings",
  deliver: 'Send messages to people in Teams, in its own name',
  'jenkins.read': 'Read your Jenkins servers: jobs, builds, logs, queue and agents',
  'jenkins.write': 'Change what Jenkins does: run and stop builds, and the servers this app knows',
  'timelogbook.read': 'Read Timelogbook as you: your tasks, hours and projects, through the API key you gave this app',
  'timelogbook.write': 'Change the Timelogbook connection, and run tools that change things in Timelogbook (each one asks you first)',
  'kubrik.read': 'Read Kubrik OS as you: the ERP modules your API key reaches',
  'kubrik.write': 'Change the Kubrik OS connection, and run tools that change things in Kubrik OS (each one asks you first)',
  'db.read': 'Read the databases you connected: their tables, rows and structure',
  'db.write': 'Run SQL on your databases, change rows, and change the connections this app knows',
  terminal: 'Open terminals and Claude sessions about what it shows',
};

const KUBE_READ_STREAMS = new Set(['follow', 'stopFollow', 'watch', 'stopWatch', 'forwards']);

/**
 * The permission one call needs. Reading and changing are separate wherever the
 * host already separates them; anything that opens a terminal or a Claude
 * session is `terminal`, whichever extension area it comes from, because what
 * it can lead to is the same.
 */
export function permissionFor(name: string): string | null {
  const channel = route(name);
  if (!channel) return null;
  if (name === DELIVER) return 'deliver';
  if (channel === 'app') return 'terminal';
  if (channel === 'git') return (READ_VERBS as readonly string[]).includes(name) ? 'git.read' : 'git.write';
  if (channel === 'kube') return (KUBE_READ as readonly string[]).includes(name.slice(5)) ? 'kube.read' : 'kube.write';
  if (channel === 'kube-stream') return KUBE_READ_STREAMS.has(name.slice(5)) ? 'kube.read' : 'kube.write';
  if (channel === 'helm') return (HELM_READ as readonly string[]).includes(name.slice(5)) ? 'helm.read' : 'helm.write';
  if (channel === 'jenkins') return (JENKINS_READ as readonly string[]).includes(name.slice(8)) ? 'jenkins.read' : 'jenkins.write';
  if (channel === 'timelogbook') return (TIMELOGBOOK_READ as readonly string[]).includes(name.slice(12)) ? 'timelogbook.read' : 'timelogbook.write';
  if (channel === 'kubrik') return (KUBRIK_READ as readonly string[]).includes(name.slice(7)) ? 'kubrik.read' : 'kubrik.write';
  // Opening a port on this computer is nothing an installed extension gets to ask for.
  if (channel === 'remote') return null;
  if (channel === 'db') return (DB_READ as readonly string[]).includes(name.slice(3)) ? 'db.read' : 'db.write';
  return channel;
}

/**
 * Calls no permission can grant: only what ships with the app may make them.
 *
 * `teams.compose` sends in your name and skips every rule that protects the
 * person on the other end — the hours, the ceilings, asking first — because
 * it is meant to be you pressing Send on the Teams screen. Behind the `teams`
 * permission, every extension already granted that to change a setting could
 * have written to anybody, as you, as often as it liked, and nobody would have
 * been asked again. An extension that wants to say something has `deliver`,
 * which goes through all of those rules.
 */
const SHIPPED_ONLY = new Set(['teams.compose']);

/**
 * Whether this panel may make this call. What ships with the app may call
 * anything; anything else only what its manifest asked for and its installer
 * agreed to.
 */
export function permitted(view: { trusted?: boolean; permissions?: string[] }, name: string): boolean {
  if (view.trusted) return true;
  if (SHIPPED_ONLY.has(name)) return false;
  const needed = permissionFor(name);
  const granted = view.permissions ?? [];
  if (needed === null || !granted.includes(needed)) return false;
  // Some calls reach further than their own door: asking Claude about a build reads that build's console.
  return (ALSO_NEEDS[name] ?? []).every((extra) => granted.includes(extra));
}

/**
 * What a call needs on top of the permission its door names.
 *
 * `jenkins.ask` is the app's door to a Claude session, so it needs `terminal`
 * — but it also reads a build and its console out of Jenkins to write the
 * briefing, which an extension with no word about Jenkins must not be able to
 * do by asking for a terminal.
 */
// A shell in a database can do anything a query can, so it needs what a query needs.
const ALSO_NEEDS: Record<string, string[]> = { 'jenkins.ask': ['jenkins.read'], 'timelogbook.ask': ['timelogbook.read'], 'db.ask': ['db.read'], 'db.shell': ['db.write'] };

export function allowed(name: string): boolean {
  return route(name) !== null;
}

/**
 * The calls the app stops to ask about first.
 *
 * Not because the extension is suspect — it is the same list a person should be
 * asked about anyway. In a repository that is the pair that can destroy work
 * existing nowhere else: a force push over somebody's commits, and deleting a
 * branch git itself would have refused to delete. In a cluster it is anything
 * that takes a running thing away.
 */
/**
 * Jenkins. A build is not a pod: stopping one throws away what it had done,
 * and running a deploy job is the same click whichever environment it points
 * at. So the question names the job and the server, and a job that looks like
 * production says so — the same reason the Kubernetes ones name the namespace.
 */
function jenkinsConsent(name: string, args: Record<string, unknown>): string | null {
  const where = args.serverName ? ` on ${shown(args.serverName, 60)}` : '';
  const job = shown(args.path ?? 'this job');
  const number = shown(args.number ?? '', 12);
  if (name === 'jenkins.stop') {
    return args.hard
      ? `Kill ${job} #${number}${where}?\n\nIt is stopped without being asked to clean up.`
      : `Stop ${job} #${number}${where}?\n\nWhat it has done so far is thrown away.`;
  }
  if (name === 'jenkins.inputSubmit') {
    // The pipeline's own question, in its own words — one line of it: approving without reading it is the click that goes wrong.
    return `Approve ${shown(args.message ?? 'this input', 200)} for ${job} #${number}${where}?\n\nThe build goes on past this point.`;
  }
  if (name === 'jenkins.inputAbort') {
    return `Abort ${job} #${number}${where} at its input step?\n\nThe build ends as aborted.`;
  }
  if (name === 'jenkins.jobEnabled') {
    return args.enabled === false ? `Disable ${job}${where}?\n\nIt is not built again until somebody enables it.` : null;
  }
  if (name === 'jenkins.nodeToggle') {
    // "Disconnect" leads, because the button says the question's first word.
    return args.offline === true
      ? `Disconnect ${shown(args.name ?? 'this agent', 80)}${where} (take it offline)?\n\nBuilds waiting for it do not start until it is back.`
      : null;
  }
  if (name === 'jenkins.trustCertificate') {
    const print = args.fingerprint ? `\n\nFingerprint: ${shown(args.fingerprint, 120)}` : '';
    return `Trust this certificate for ${shown(args.serverName ?? 'this Jenkins', 60)} only?\n\nConnections to that server will accept it from now on. Nothing else is trusted.${print}`;
  }
  if (name === 'jenkins.run' || name === 'jenkins.rebuild') {
    const values = args.params && typeof args.params === 'object' ? Object.values(args.params as Record<string, unknown>).map((value) => String(value ?? '')) : [];
    return looksLikeProduction(String(args.path ?? '')) || values.some(looksLikeProduction)
      ? `Run ${job}${where}?\n\nThis looks like production.`
      : null;
  }
  if (name === 'jenkins.runMany') {
    // Several at once is the click that is easy to get wrong: the count and the names are the whole question, and they are the ones the verb will run.
    const items = Array.isArray(args.items)
      ? (args.items as Array<{ path?: unknown }>).map((one) => String(one?.path ?? ''))
      : (Array.isArray(args.jobs) ? args.jobs : []).map(String);
    const list = items.slice(0, 8).map((one) => `• ${shown(one)}`).join('\n');
    const more = items.length > 8 ? `\n… and ${items.length - 8} more` : '';
    const production = items.some(looksLikeProduction);
    return `Run ${items.length || 'these'} job${items.length === 1 ? '' : 's'}${where}?\n\n${list}${more}${production ? '\n\nOne or more of these look like production.' : ''}`;
  }
  if (name === 'jenkins.promote') {
    /*
     * The verb takes `from` as { path, number } and `to` as { path }, so the
     * question names those — never the objects themselves, which read as
     * "[object Object]" — and the panel's own shorter words only when they are
     * the end of what it will really use.
     */
    const named = (value: unknown): string => {
      if (value && typeof value === 'object') {
        const one = value as { path?: unknown; number?: unknown };
        const path = String(one.path ?? '');
        return one.number !== undefined && one.number !== null ? `${path} #${String(one.number)}` : path;
      }
      return String(value ?? '');
    };
    const real = (value: unknown, label: unknown, fallback: string): string => {
      const full = named(value);
      const short = String(label ?? '');
      return shown(short && full.endsWith(short) ? short : full || fallback, 120);
    };
    const to = real(args.to, args.toLabel, 'the next environment');
    const production = looksLikeProduction(named(args.to) || to);
    return `Promote ${real(args.from, args.fromLabel, 'this build')} to ${to}${where}?\n\nIt starts ${to} with the parameters of that build.${production ? '\n\nThis looks like production.' : ''}`;
  }
  if (name === 'jenkins.scheduleRun') {
    // The time the verb will use, written by the host, not a string the panel chose.
    const at = Number(args.at);
    const when = Number.isFinite(at) && at > 0 ? new Date(at).toLocaleString() : shown(args.when ?? 'the time you chose', 60);
    return `Run ${job}${where} at ${when}?\n\nIt only runs if Smart Terminal is open then; nothing runs on its own after that.`;
  }
  if (name === 'jenkins.replay') {
    // A replay is a build with a script nobody reviewed: it runs with everything the job may touch.
    return `Replay ${job} #${number}${where} with an edited script?\n\nThe edited script runs in Jenkins with whatever access the job has.`;
  }
  if (name === 'jenkins.restartFromStage') {
    return `Restart ${job} #${number}${where} from stage "${shown(args.stage ?? '', 80)}"?\n\nIt starts a new build that skips the stages before it.`;
  }
  if (name === 'jenkins.exportServers') {
    // What the verb will write: the servers it was told, or all of them.
    const count = Array.isArray(args.ids) ? args.ids.length : null;
    const what = count === null ? 'all your Jenkins servers' : `${count} Jenkins server${count === 1 ? '' : 's'}`;
    return `Export ${what} to a file?\n\nThe file will hold the API tokens in plain text: anybody who gets it can act as you in Jenkins. Keep it somewhere safe, and delete it when you are done.`;
  }
  if (name === 'jenkins.importServers') {
    // From a file, the system's own dialog is the person's consent. From text the panel hands over, nothing was chosen: ask.
    return typeof args.text === 'string'
      ? 'Add the Jenkins servers in this text?\n\nTheir tokens are stored in this app, and a server that already exists has its token replaced.'
      : null;
  }
  if (name === 'jenkins.claudeAccessSave') {
    return args.enabled === false
      ? null
      : 'Let Claude sessions read Jenkins?\n\nEvery Claude session in this app can then read builds, logs and the dashboard — with secrets masked first — and ask you to run a job. It can never run one without asking.';
  }
  if (name === 'jenkins.forget') {
    // What it removes is on this computer only, and nothing brings back what Jenkins has already thrown away. Said from what the verb will delete.
    const path = args.path ? shown(args.path) : '';
    const what = path ? (args.number ? `the saved copy of ${path} #${shown(args.number, 12)}` : `everything saved for ${path}`) : 'everything saved for this Jenkins';
    return `Remove ${what}${where}?\n\nIt is deleted from this computer. Jenkins is not touched — but if Jenkins has already discarded it, it is gone for good.`;
  }
  if (name === 'jenkins.deleteServer') {
    return `Forget ${shown(args.serverName ?? 'this Jenkins', 60)}?\n\nIts token is removed from this app, along with the favorites and follows kept for it.`;
  }
  return null;
}

/**
 * A script cut into statements, each with its comments gone and everything
 * quoted replaced by a placeholder — so a `WHERE` inside a string is not taken
 * for a `WHERE`, and a semicolon inside a function body ends nothing.
 *
 * The same reading as electron/rdb-sql.js, which decides what is sent; a test
 * holds the two together. This one decides what a person is asked.
 */
export function sqlStatements(sql: string, engine?: string): string[] {
  const source = String(sql ?? '');
  const mysql = engine === 'mysql';
  const out: string[] = [];
  let bare = '';
  let i = 0;
  const push = () => {
    const plain = bare.replace(/\s+/g, ' ').trim();
    if (plain) out.push(plain);
    bare = '';
  };
  while (i < source.length) {
    const ch = source[i];
    const two = source.slice(i, i + 2);
    if (two === '--' || (ch === '#' && mysql)) {
      const end = source.indexOf('\n', i);
      bare += ' ';
      i = end === -1 ? source.length : end;
      continue;
    }
    if (two === '/*') {
      const end = source.indexOf('*/', i + 2);
      bare += ' ';
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      let end = i + 1;
      while (end < source.length) {
        if (mysql && source[end] === '\\' && ch !== '`' && end + 1 < source.length) { end += 2; continue; }
        if (source[end] === ch) {
          if (source[end + 1] === ch) { end += 2; continue; }
          break;
        }
        end += 1;
      }
      bare += ch === "'" ? "''" : 'q';
      i = Math.min(source.length, end + 1);
      continue;
    }
    if (ch === '$') {
      const tag = /^\$[A-Za-z_]*\$/.exec(source.slice(i, i + 64));
      if (tag) {
        const end = source.indexOf(tag[0], i + tag[0].length);
        bare += "''";
        i = end === -1 ? source.length : end + tag[0].length;
        continue;
      }
    }
    if (ch === ';') {
      i += 1;
      // Inside the body of a trigger or a routine a semicolon ends a line of it, not the statement.
      if (sqlInBody(bare)) {
        bare += ch;
        continue;
      }
      push();
      continue;
    }
    bare += ch;
    i += 1;
  }
  push();
  return out;
}

/** A CREATE TRIGGER / PROCEDURE / FUNCTION / EVENT whose BEGIN has not met its END. The same counting as electron/rdb-sql.js. */
function sqlInBody(bare: string): boolean {
  if (!/^\s*CREATE\b[\s\S]*?\b(TRIGGER|PROCEDURE|FUNCTION|EVENT)\b/i.test(bare)) return false;
  const opens = (bare.match(/\b(BEGIN|CASE)\b/gi) ?? []).length;
  const closes = (bare.match(/\bEND\b(?!\s+(IF|LOOP|WHILE|REPEAT)\b)/gi) ?? []).length;
  return opens > closes;
}

const SQL_EXPLAIN_ANALYZE = /^EXPLAIN\s*(\([^)]*\bANALYZE\b[^)]*\)|ANALYZE\b)/;
const SQL_EXPLAIN_HEAD = /^EXPLAIN\s*((\([^)]*\)|ANALYZE\b|VERBOSE\b)\s*)*/;

/**
 * The statements in a script that take something away, each in a few words: a
 * DROP, a TRUNCATE, and a DELETE or UPDATE with no WHERE. The four that are
 * typed by accident and regretted at once.
 */
export function sqlRisks(sql: string, engine?: string): string[] {
  const found: string[] = [];
  for (const bare of sqlStatements(sql, engine)) {
    let upper = bare.toUpperCase();
    if (/^EXPLAIN\b/.test(upper)) {
      // Plain EXPLAIN only plans; EXPLAIN ANALYZE runs what it explains.
      if (!SQL_EXPLAIN_ANALYZE.test(upper)) continue;
      upper = upper.replace(SQL_EXPLAIN_HEAD, '');
    }
    const words = upper.split(' ');
    if (words[0] === 'DROP') found.push(words.slice(0, 2).join(' ').slice(0, 40));
    else if (words[0] === 'TRUNCATE') found.push('TRUNCATE');
    else if (/^ALTER\b.*\bDROP\b(?!\s+(NOT\s+NULL|DEFAULT|IDENTITY|EXPRESSION)\b)/.test(upper)) found.push(`${words.slice(0, 2).join(' ')} … DROP`.slice(0, 40));
    else if (/\bDELETE\s+FROM\b/.test(upper) && !/\bWHERE\b/.test(upper)) found.push('DELETE with no WHERE');
    else if ((words[0] === 'UPDATE' || /^WITH\b.*\bUPDATE\b/.test(upper)) && /\bSET\b/.test(upper) && !/\bWHERE\b/.test(upper)) found.push('UPDATE with no WHERE');
  }
  return found;
}

/** The first words of every statement in a script that is not plainly a read — what a production connection is asked about. */
export function sqlWrites(sql: string, engine?: string): string[] {
  const found: string[] = [];
  for (const bare of sqlStatements(sql, engine)) {
    let upper = bare.toUpperCase().replace(/^[\s(]+/, '');
    if (/^EXPLAIN\b/.test(upper)) {
      if (!SQL_EXPLAIN_ANALYZE.test(upper)) continue;
      upper = upper.replace(SQL_EXPLAIN_HEAD, '');
    }
    const verb = /^[A-Z]+/.exec(upper)?.[0] ?? '';
    // A setting for the whole server is a change to the server, however it is spelt. The same test as rdb-sql.js.
    if (/^(SET\s+(GLOBAL|PERSIST|PERSIST_ONLY)\b|SET\s+@@(GLOBAL|PERSIST|PERSIST_ONLY)\.|RESET\s+PERSIST\b)/.test(upper)) {
      if (!found.includes('SET GLOBAL')) found.push('SET GLOBAL');
      continue;
    }
    if (['SHOW', 'DESCRIBE', 'DESC', 'VALUES', 'TABLE', 'BEGIN', 'START', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE', 'END', 'ABORT', 'SET', 'RESET', 'USE'].includes(verb)) continue;
    if (verb === 'SELECT' && !/\bINTO\s+(?!@|OUTFILE|DUMPFILE)/.test(upper)) continue;
    if (verb === 'WITH' && !/\b(INSERT|UPDATE|DELETE|MERGE|REPLACE)\b/.test(upper)) continue;
    if (verb && !found.includes(verb)) found.push(verb);
  }
  return found;
}

/**
 * Databases. A query tool that asked before every statement would be one
 * nobody could work in, so it asks about two things only: what takes data away
 * for good, wherever it is — and anything that changes a connection the person
 * marked as production, or named like one. The question says which connection,
 * because the same DELETE is nothing on a laptop and an incident on the other tab.
 */
function dbConsent(name: string, args: Record<string, unknown>): string | null {
  const connection = shown(args.connectionName ?? 'this connection', 60);
  const database = args.database ? `, database ${shown(args.database, 60)}` : '';
  const production = args.production === true || looksLikeProduction(String(args.connectionName ?? ''));
  const marked = production ? '\n\nThis is production.' : '';
  if (name === 'db.query') {
    const sql = String(args.sql ?? '');
    const engine = String(args.engine ?? '');
    const risks = sqlRisks(sql, engine);
    if (risks.length) {
      const list = risks.slice(0, 8).map((one) => `• ${shown(one, 60)}`).join('\n');
      const more = risks.length > 8 ? `\n… and ${risks.length - 8} more` : '';
      // The statement itself when it is short enough to read: "DROP TABLE" does not say which table.
      const said = sql.trim().length <= 240 ? `\n\n${shown(sql, 240)}` : '';
      return `Run this on ${connection}${database}?\n\n${list}${more}${said}\n\nNothing brings back what ${risks.length === 1 ? 'this takes' : 'these take'} away.${marked}`;
    }
    if (production) {
      const writes = sqlWrites(sql, engine);
      if (writes.length) return `Run this on ${connection}${database}?\n\nIt changes things: ${writes.slice(0, 8).join(', ')}.${marked}`;
    }
    return null;
  }
  if (name === 'db.applyChanges') {
    const changes = (args.changes ?? {}) as { inserts?: unknown[]; updates?: unknown[]; deletes?: unknown[] };
    const count = (list: unknown) => (Array.isArray(list) ? list.length : 0);
    const deletes = count(changes.deletes);
    const others = count(changes.inserts) + count(changes.updates);
    const table = shown(args.name ?? 'this table', 80);
    if (deletes) {
      const also = others ? ` It also saves ${others} other change${others === 1 ? '' : 's'}.` : '';
      return `Delete ${deletes} row${deletes === 1 ? '' : 's'} from ${table} on ${connection}${database}?\n\nNothing brings ${deletes === 1 ? 'it' : 'them'} back.${also}${marked}`;
    }
    if (production && others) return `Save ${others} change${others === 1 ? '' : 's'} to ${table} on ${connection}${database}?${marked}`;
    return null;
  }
  if (name === 'db.kill' && args.hard === true) {
    return `Terminate session ${shown(args.pid ?? '', 20)} on ${connection}?\n\nIts connection is closed, and whatever it had not committed is rolled back.${marked}`;
  }
  if (name === 'db.role' && args.preview !== true) {
    const role = (args.role ?? {}) as { name?: unknown; host?: unknown };
    const who = shown(role.name ?? 'this role', 80) + (role.host ? `@${shown(role.host, 60)}` : '');
    if (args.action === 'drop') {
      return `Drop the role ${who} on ${connection}?\n\nNobody signs in as it again, and whatever it was granted goes with it.${marked}`;
    }
    if (production) return `${args.action === 'create' ? 'Create' : 'Change'} the role ${who} on ${connection}?${marked}`;
    return null;
  }
  // Stepping through a routine runs it, and a routine can do anything.
  if (name === 'db.debugStart' && production) {
    return `Run ${shown(args.name ?? 'this routine', 80)} on ${connection}${database}, a line at a time?\n\nIt really runs, with the values you typed: what it changes is changed.${marked}`;
  }
  if (name === 'db.importRun' && production) {
    return `Import rows into ${shown(args.name ?? 'this table', 80)} on ${connection}${database}?${marked}`;
  }
  if (name === 'db.restore') {
    return `Restore a backup into ${connection}${database}?\n\nYou choose the file next. What it defines is created, and what is already there under the same names is replaced or collides with it.${marked}`;
  }
  if (name === 'db.deleteConnection') {
    return `Forget ${connection}?\n\nIts password is removed from this app, with the history kept for it. The database itself is not touched.`;
  }
  return null;
}

/**
 * One line of something that came from outside, fit to sit in a question.
 *
 * Job names, pipeline messages and server labels are other people's words, and
 * a blank line in one would read as a paragraph of the question itself:
 * "Approve Deploy to PROD?\n\nThis is totally safe." — so line breaks, control
 * and direction characters are flattened to spaces and the length is bounded.
 */
function shown(value: unknown, max = 120): string {
  const text = String(value ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
}

/**
 * Whether a job's name, or a parameter's value, says it is production.
 *
 * A word on its own — separated by anything that is not a letter or digit, so
 * `TIMELOG MS PROD`, `deploy-prod`, `app/prod/apply` and `ENV=production-eu`
 * all count and `reproduce-bug` does not — plus `prd`, `live`, `preprod`, and
 * the camel-case `deployProd`. Anything that reads as production asks; being
 * asked once too often is cheaper than a deploy nobody was asked about.
 */
export function looksLikeProduction(text: string): boolean {
  const value = String(text ?? '');
  return (
    /(^|[^A-Za-z0-9])(prod(uction)?|prd|live)([^A-Za-z0-9]|$)/i.test(value) ||
    /pre-?prod/i.test(value) ||
    /[a-z]Prod(uction)?(?![a-z])/.test(value)
  );
}

export function needsConsent(name: string, args: Record<string, unknown>): string | null {
  if (name === 'push' && args?.force) {
    return 'Force-push, overwriting what is on the remote?';
  }
  if (name === 'deleteBranch' && args?.force) {
    return `Delete the branch "${String(args.name ?? '')}" even though it is not merged?`;
  }
  /*
   * A rebase, unlike the two above, takes nothing away that the reflog cannot
   * give back. It is here because of where the button is: in the graph it sits
   * beside "Merge into current", the two read alike, and one of them replays
   * every commit on this branch as a new commit with a new hash. On a branch
   * anybody else has pulled, that is the difference between a merge and an
   * afternoon — and it is one click either way.
   */
  if (name === 'rebase') {
    return (
      `Rebase the current branch onto ${String(args.ref ?? 'this commit')}?\n\n` +
      'Every commit on it is replayed as a new one. If the branch is already pushed, ' +
      'what is on the remote no longer matches it.'
    );
  }

  /*
   * A cluster is not a working tree. There is no undo, no reflog and no copy on
   * disk of what was there a second ago, and the same click is harmless in a
   * scratch namespace and an outage in production. So the question always says
   * *where* as well as *what*: the namespace and the context are the whole
   * difference between the two, and a dialog that omits them is a dialog people
   * learn to click through.
   */
  if (name.startsWith('jenkins.')) return jenkinsConsent(name, args);
  if (name === 'timelogbook.claudeAccessSave' && args.on) {
    return 'Let Claude sessions use Timelogbook?\n\nEvery Claude session in this app can then read what your API key reaches, as you. Anything that would change Timelogbook is shown to you first.';
  }
  if (name === 'timelogbook.writesAccessSave' && args.on) {
    return 'Let Claude sessions change Timelogbook without asking you here?\n\nEvery Claude session in this app can then create and edit tasks, comment, log draft hours and more, as you, with no dialog. Timelogbook still decides the rest: what it wants confirmed stays a proposal, unless your API key is marked to run without confirmation.';
  }
  if (name === 'timelogbook.disconnect') {
    return 'Disconnect Timelogbook?\n\nThe API key is removed from this app. It keeps working in Timelogbook until you revoke it there.';
  }
  if (name === 'kubrik.claudeAccessSave' && args.on) {
    return 'Let Claude sessions use Kubrik OS?\n\nEvery Claude session in this app can then read what your API key reaches, as you. Anything that would change Kubrik OS is shown to you first.';
  }
  if (name === 'kubrik.disconnect') {
    return 'Disconnect Kubrik OS?\n\nThe API key is removed from this app. It keeps working in Kubrik OS until you revoke it there.';
  }
  if (name.startsWith('db.')) return dbConsent(name, args);

  if (name.startsWith('kube.')) {
    const where = whereItIs(args);
    const what = `${String(args.kind ?? 'resource')} ${String(args.name ?? '')}`.trim();
    // Several at once first: the count is the part that is easy to get wrong,
    // and one question for the lot beats five that get waved through.
    if (name === 'kube.remove' && Number(args.count) > 1) {
      // Ticked across namespaces, the first one's namespace is not where they are.
      const spread = Number(args.spread) > 1
        ? ` across ${String(args.spread)} namespaces${args.context ? ` on ${clusterName(String(args.context))}` : ''}`
        : where;
      return `Delete ${String(args.count)} ${String(args.kind ?? 'object')}s${spread}?\n\nNothing brings them back.`;
    }
    if (name === 'kube.remove') return `Delete ${what}${where}?\n\nNothing brings it back.`;
    // A dry run is a question, not a change: the server validates it and throws
    // it away. Asking about that is asking about nothing.
    if (name === 'kube.apply' && !args.dryRun) {
      /*
       * Whether something else owns this object is the thing worth knowing
       * before you change it, and the object says so itself: Helm stamps every
       * resource it installs with the release it belongs to. Editing one by
       * hand works, and then the next `helm upgrade` puts it back — which is a
       * confusing afternoon if nobody said so beforehand.
       */
      const owner = /meta\.helm\.sh\/release-name:\s*(\S+)/.exec(String(args.yaml ?? ''));
      const managed = owner
        ? `\n\nHelm installed this, as part of the release "${owner[1]}". ` +
          'The next upgrade of that release will put it back the way the chart says.'
        : '';
      // Argo CD does the same on its own clock, and sooner: it puts back what Git says, often within minutes.
      const argo = /argocd\.argoproj\.io\/(?:instance|tracking-id):\s*["']?([^"'\s:]+)/.exec(String(args.yaml ?? ''));
      const synced = argo
        ? `\n\nArgo CD manages this, as part of the application "${argo[1]}". ` +
          'If it syncs by itself it will put this back the way Git says; change it there to keep it.'
        : '';
      /*
       * What is about to be different, in the two numbers the panel counted,
       * and the one mistake an editor makes easy: a name changed in the text is
       * not a rename. The cluster is given a new object and keeps the old one.
       */
      const yaml = String(args.yaml ?? '');
      const added = Number(args.added) || 0;
      const removed = Number(args.removed) || 0;
      const lines = (n: number) => `${n} line${n === 1 ? '' : 's'}`;
      const size = added || removed
        ? `\n\n${[added ? `${lines(added)} added` : '', removed ? `${lines(removed)} removed` : ''].filter(Boolean).join(', ')}` +
          `${args.name ? ` in ${what}` : ''}.`
        : '';
      const named = /^metadata:\n(?: .*\n)*? {2}name:\s*["']?([^"'\s#]+)/m.exec(yaml)?.[1];
      const kindNow = /^kind:\s*(\S+)/m.exec(yaml)?.[1];
      const other = args.name && ((named && named !== String(args.name)) || (kindNow && args.kind && kindNow !== String(args.kind)))
        ? `\n\nThis text is ${kindNow ?? String(args.kind)} ${named ?? String(args.name)}, not ${what}. ` +
          `Applying it makes or changes that one and leaves ${String(args.name)} as it is.`
        : '';
      return `Apply this manifest${where}?${size}${other}${managed}${synced}`;
    }
    /*
     * Changing a few fields, and the question says which.
     *
     * "Apply this manifest?" is a question nobody can answer without reading the
     * manifest. A patch is small enough to say out loud, and what it says is
     * exactly what will be different a second from now — so the dialog lists it,
     * and scaling to zero still says what scaling to zero means.
     */
    if (name === 'kube.configure' && !args.dryRun) {
      const lines = Array.isArray(args.summary) ? args.summary.map((line) => `• ${String(line)}`) : [];
      const zero = Number((args.patch as { spec?: { replicas?: number } })?.spec?.replicas) === 0
        ? '\n\nAt zero replicas everything it runs stops.'
        : '';
      return `Change ${what}${where}?\n\n${lines.join('\n')}${zero}`;
    }
    if (name === 'kube.scale' && Number(args.replicas) === 0) {
      return `Scale ${what} to zero${where}?\n\nEverything it runs stops.`;
    }
    /*
     * A rollback is the one that reads as safe and is not. It does not undo the
     * last change; it replaces the workload's template with an older one, and
     * everything changed since — a bumped limit, a new environment variable, a
     * different image somebody pushed on Friday — goes back with it.
     */
    if (name === 'kube.rollback') {
      return (
        `Roll ${what} back to ${args.revision ? `revision ${String(args.revision)}` : 'its previous revision'}` +
        `${where}?\n\nEverything changed since that revision goes with it, not only the last change.`
      );
    }
    // Suspending is reversible and takes nothing away, but it does stop work
    // from happening, which somebody will otherwise wait for in silence.
    if (name === 'kube.suspend' && args.on !== false) {
      return `Stop ${what} running${where}?\n\nIt stays, and fires nothing until it is resumed.`;
    }
    if (name === 'kube.trigger') {
      return `Run ${String(args.name ?? 'this cron job')} now${where}?\n\nIt makes a real job, off schedule.`;
    }
    // A whole pool at once: one question that says how many, rather than six that get waved through.
    if (name === 'kube.cordonMany' && args.on !== false) {
      const many = Array.isArray(args.names) ? args.names.length : 0;
      return `Stop scheduling new pods onto ${many} node${many === 1 ? '' : 's'}${args.pool ? ` of ${String(args.pool)}` : ''}${where}?\n\nWhat already runs there keeps running. Uncordon puts them back.`;
    }
    if (name === 'kube.cordon' && args.on !== false) {
      return `Stop scheduling new pods onto ${String(args.name ?? 'this node')}${where}?`;
    }
    /*
     * The one that was deliberately left out until it could be watched. A drain
     * moves everything off a node — which is a normal thing to do before
     * replacing one, and an outage if the thing being moved has nowhere to go.
     */
    if (name === 'kube.drain') {
      return (
        `Move everything off ${String(args.name ?? 'this node')}${args.step ? ` (node ${String(args.step)}${args.pool ? ` of ${String(args.pool)}` : ''})` : ''}${where}?\n\n` +
        'Every pod on it is evicted, one at a time. It stops if a disruption budget will not allow it, ' +
        'and you will see that happen in the dock.'
      );
    }

  }
/*
   * Helm's two. A rollback is not obviously destructive until you have watched
   * one — it replaces what is deployed with what used to be, including the
   * things that were deliberately changed since — so it says which revision is
   * being left behind as well as which is coming back.
   */
  if (name === 'helm.rollback') {
    return (
      `Roll ${String(args.name ?? 'this release')} back to revision ${String(args.revision ?? '?')}` +
      `${whereItIs(args)}?\n\nEverything changed since that revision goes with it.`
    );
  }
  if (name === 'helm.uninstall') {
    return (
      `Uninstall ${String(args.name ?? 'this release')}${whereItIs(args)}?\n\n` +
      'Everything the chart installed is deleted.'
    );
  }

  /*
   * The reviewer's irreversible ones. Everything else it does is a draft, a
   * click that can be undone on the PR, or a commit in a workshop copy. These
   * change a shared branch, close somebody's PR, or throw away the only copy of
   * a fix — and each question says which PR and which branch, because "Merge?"
   * with no noun in it is a dialog people learn to click through.
   */
  if (name.startsWith('review.')) {
    const pr = args?.prId ? ` #${String(args.prId)}` : '';
    const repo = args?.repoName ? ` of ${String(args.repoName)}` : '';
    /*
     * Not the merge. The panel's own merge form is the confirmation — it names
     * the target, the strategy and anything still pending, and nothing merges
     * until its Merge button is pressed — so a dialog on top of it asked the
     * same question twice, and was the one people learned to click through.
     */
    if (name === 'review.decline') {
      return `Decline pull request${pr}${repo}?\n\nThe reason is posted as a comment first, and the PR is closed.`;
    }
    /*
     * Commits on other people's branches, pushed. The question lists every
     * rename and every branch, because those are exactly what the authors will
     * find when they next pull.
     */
    if (name === 'review.renumberMigrations') {
      const lines = Array.isArray(args?.summary) ? args.summary.map(String).slice(0, 20) : [];
      const comment = args?.comment === false ? '' : ' Each pull request is told in its thread.';
      return `Renumber the clashing migrations and push to ${lines.length ? 'these branches' : 'the branches that lose a number'}?\n\n${lines.join('\n')}\n\nOne commit on each branch, never forced: if a branch moved, it is left alone.${comment} Any environment that already ran an old number will see the renamed file as a new migration.`;
    }
    if (name === 'review.push') {
      return `Push ${String(args?.count ?? 'the')} commit(s) to origin/${String(args?.branch ?? '?')}?\n\nEverybody who pulls the branch gets them. It is never forced: if the remote moved, git refuses.`;
    }
    if (name === 'review.deleteRepo') {
      return `Stop reviewing ${String(args?.repoName ?? 'this repository')} and delete everything stored about it?\n\nReviews, findings, drafts and history go. Nothing on GitHub or Bitbucket changes.`;
    }
    if (name === 'review.discardWorkshop') {
      return `Delete the fix workshop of pull request${pr}${repo}?\n\nIts commits are gone unless they were handed back to your clone.`;
    }
    return null;
  }

  /*
   * A build is local and reversible right up to the one step that is not. The
   * `deploy` phase, and Gradle's `publish`, copy the artifact to a repository
   * other people resolve from — and a snapshot pushed by accident is on every
   * colleague's next build. It sits one row below `install` in the tree, so it
   * is one double-click away from the one everybody runs.
   */
  if (name === 'build.run') {
    // Everything that ends up on the line, not only what the tree called a
    // goal: `deploy` typed into the run box is the same deploy.
    const words = [
      ...(Array.isArray(args?.goals) ? args.goals.map(String) : []),
      ...(Array.isArray(args?.extra) ? args.extra.map(String) : []),
    ];
    if (words.some(publishes)) {
      return (
        `Run ${words.join(' ')}?\n\n` +
        'This publishes the artifact to a remote repository, where everybody else resolves it from.'
      );
    }
  }
  return null;
}

/**
 * Whether a goal or task sends something off the machine.
 *
 * Maven's `deploy` phase and the goals that do the same thing under other
 * names — `site:deploy`, `release:perform`, `nexus-staging:deploy`,
 * `gpg:sign-and-deploy-file`, `docker:push`, `jib:build` (which pushes to a
 * registry) — and Gradle's `publish*`, except to Maven Local. An execution id
 * (`deploy@release`) is not part of the name.
 */
export function publishes(goal: string): boolean {
  const bare = String(goal ?? '').replace(/@[^:]*$/, '');
  const cut = bare.lastIndexOf(':');
  const name = cut === -1 ? bare : bare.slice(cut + 1);
  const prefix = cut === -1 ? '' : bare.slice(0, cut).split(':').pop() ?? '';
  if (/^(deploy|deploy-file|perform|sign-and-deploy-file|stage-deploy|push)$/.test(name)) return true;
  if (name === 'build' && prefix === 'jib') return true;
  if (name === 'release' && /nexus|staging/.test(prefix)) return true;
  // Gradle: `publish`, `publishAllPublicationsToX`, … but not to mavenLocal.
  return /^publish/i.test(name) && !/mavenlocal$/i.test(name);
}

/** " in namespace prod on cluster X" — the half of the question that is usually the answer. */
function whereItIs(args: Record<string, unknown>): string {
  const namespace = args?.namespace ? ` in namespace ${String(args.namespace)}` : '';
  const context = args?.context ? ` on ${clusterName(String(args.context))}` : '';
  return `${namespace}${context}`;
}

/**
 * A context the way people say it.
 *
 * An EKS context is an ARN — `arn:aws:eks:sa-east-1:532465846520:cluster/kubrik-k8s`
 * — and a question with that in the middle is read past, which is the opposite
 * of what the cluster name is there for. The name and its region are what tell
 * two clusters apart; the account number never is, to the person clicking.
 */
export function clusterName(context: string): string {
  const eks = /^arn:aws:eks:([^:]+):\d+:cluster\/(.+)$/.exec(context);
  return eks ? `${eks[2]} (${eks[1]})` : shortContext(context);
}

/**
 * What the confirming button says: the verb the question starts with.
 *
 * Every question here opens with the thing that will happen — Delete, Scale,
 * Drain, Force-push, Merge — so the button can say it too. "Do it" made every
 * dialog look the same, which is how people learn to click through them.
 */
export function consentAction(question: string): string {
  const verb = /^[A-Za-z][\w-]*/.exec(String(question ?? '').trim())?.[0];
  return verb ? verb.charAt(0).toUpperCase() + verb.slice(1) : 'Continue';
}

/**
 * A value that will be one word to a shell, whatever is in it.
 *
 * Names come out of a cluster, which is to say out of whatever anybody put
 * there — and unlike everything else here, these two end up on a real command
 * line in a real terminal rather than in an `execFile` array. Single quotes
 * make a shell take the whole thing literally; the one thing they cannot
 * contain is a single quote, so a value carrying one is refused rather than
 * escaped into something clever that a different shell might read differently.
 */
export function shellQuote(value: string, what: string): string {
  const text = String(value ?? '');
  if (!text) throw new Error(`${what} is missing`);
  if (text.includes("'")) throw new Error(`${what} contains a quote, which this cannot pass to a shell safely`);
  return `'${text}'`;
}

export type Where = { context?: string; namespace?: string };

/**
 * What people call a cluster, out of what kubeconfig calls it.
 *
 * An EKS context is an ARN and a GKE one is four fields joined by underscores.
 * Neither fits on a tab, and neither is what anybody says out loud: the last
 * segment is the cluster's name, and the whole thing stays in the tooltip.
 */
export function shortContext(name: string): string {
  const text = String(name ?? '');
  if (text.startsWith('arn:')) {
    const cut = text.lastIndexOf('/');
    return cut >= 0 ? text.slice(cut + 1) : text;
  }
  if (text.startsWith('gke_')) {
    const parts = text.split('_');
    return parts[parts.length - 1] || text;
  }
  return text;
}

/** `--context X --namespace Y`, quoted, for a command line a person will see and edit. */
function whereFlags({ context, namespace }: Where): string {
  const parts: string[] = [];
  if (context) parts.push(`--context ${shellQuote(context, 'The context')}`);
  if (namespace) parts.push(`--namespace ${shellQuote(namespace, 'The namespace')}`);
  return parts.join(' ');
}

/**
 * The command that gets a person a shell inside a container.
 *
 * `sh -c` with a fallback, because the two-thirds of images that have bash and
 * the third that have only ash are not distinguishable from out here, and
 * "OCI runtime exec failed: exec: bash: not found" is a bad first impression of
 * a button called Shell.
 *
 * It is built from named parts and never from anything the extension wrote:
 * the panel says which pod, the app says what runs.
 */
export function execCommand(args: { pod: string; container?: string; shell?: string } & Where): string {
  const flags = whereFlags(args);
  const container = args.container ? ` -c ${shellQuote(args.container, 'The container')}` : '';
  const shell = args.shell
    ? shellQuote(args.shell, 'The shell')
    : `sh -c 'command -v bash >/dev/null && exec bash || exec sh'`;
  return `kubectl ${flags} exec -it ${shellQuote(args.pod, 'The pod')}${container} -- ${shell}`.replace(/\s+/g, ' ');
}

/**
 * A value safe inside a *double*-quoted string, which is a stricter question.
 *
 * Single quotes stop a shell reading anything at all; double quotes still let
 * it read `$`, a backtick and a backslash. The alias below has to nest one kind
 * of quoting inside the other, so this is the inner half — and rather than
 * escape those four characters into something a different shell might read
 * differently, a value carrying one is refused. No cluster or namespace anybody
 * has is named with a dollar sign in it.
 */
function innerQuote(value: string, what: string): string {
  const text = String(value ?? '');
  if (!text) throw new Error(`${what} is missing`);
  if (/["'$`\\]/.test(text)) throw new Error(`${what} contains a character this cannot pass to a shell safely`);
  return `"${text}"`;
}

/**
 * A terminal that is already pointed at what the panel is looking at.
 *
 * An alias rather than `use-context`, and that is the whole idea: the tab is
 * aimed at this cluster and this namespace, and nothing outside the tab has
 * changed. `k get pods` in it means what the panel means by it, and the same
 * command in any other window still means what it always did.
 *
 * Two layers of quoting, both needed: the outer single quotes are what make the
 * alias one word to the shell defining it, and the inner double quotes are what
 * keep a context name in one piece if it ever contains a space.
 */
export function terminalSetup({ context, namespace }: Where): string {
  const parts = ['kubectl'];
  if (context) parts.push(`--context ${innerQuote(context, 'The context')}`);
  if (namespace) parts.push(`--namespace ${innerQuote(namespace, 'The namespace')}`);
  return `alias k='${parts.join(' ')}'`;
}

/**
 * A terminal already standing in an application's folder, with its JDK first
 * on the PATH — so `mvn`, `./mvnw` and `java` in it mean what the panel meant.
 *
 * Built from two named parts, both quoted as one word each. The folder came
 * from the app's own discovery and the JDK from the machine's own list; the
 * panel chose between them and wrote neither.
 */
export function springShellSetup({ dir, javaHome }: { dir: string; javaHome?: string }): string {
  const parts = [`cd ${shellQuote(dir, 'The folder')}`];
  if (javaHome) {
    const home = shellQuote(javaHome, 'The JDK');
    parts.push(`export JAVA_HOME=${home}`, `export PATH="$JAVA_HOME/bin:$PATH"`);
  }
  return parts.join(' && ');
}

/**
 * A terminal running the JDK's own debugger, attached to a run.
 *
 * `jdb` is not an IDE, and it is not meant to be: it is the debugger that is
 * already installed wherever Java is, in a real terminal, with breakpoints,
 * stepping and locals — and a Claude session can drive the same command. The
 * port came from the app, which chose it; the folder from the app's own
 * discovery. Both are checked here before they touch a command line.
 */
export function jdbCommand({ dir, port, javaHome }: { dir: string; port: number; javaHome?: string }): string {
  const number = Number(port);
  if (!Number.isInteger(number) || number < 1 || number > 65535) throw new Error('The debug port is not a port');
  const parts = [springShellSetup({ dir, javaHome })];
  parts.push(`jdb -attach ${number} -sourcepath ${shellQuote('src/main/java:src/main/kotlin', 'The source path')}`);
  return parts.join(' && ');
}

/**
 * A word on a command line, quoted only when it has to be.
 *
 * `mvn clean install -DskipTests` reads as what it is; `'mvn' 'clean'
 * 'install'` reads as a machine talking. So a token made of the characters a
 * goal, a flag or a property can contain goes as it is, and anything else — a
 * `*` in `-Dtest=Foo*`, a space in a property value — goes in single quotes,
 * which is what a person would type.
 */
function word(value: string, what: string): string {
  const text = String(value ?? '');
  if (!text) throw new Error(`${what} is missing`);
  // A leading `=` is zsh's own: `=ls` becomes `/bin/ls`. Quoted, it is text.
  if (/^[A-Za-z0-9_.:@/,+-][A-Za-z0-9_.:@=/,+-]*$/.test(text)) return text;
  return shellQuote(text, what);
}

/**
 * The flags a panel may put on a build's command line.
 *
 * Anything that is not a flag is a goal or a task, and those run inside the
 * project by construction. A flag is different: `-f other/pom.xml`,
 * `--settings x.xml`, `--init-script evil.gradle`, `-Dmaven.repo.local=…`
 * each make the build something other than this project's build, in a real
 * terminal, under the person's own shell — which is exactly the reach an
 * extension must not have. So flags are an allow-list, and the list is the
 * ones that change *how* the build runs and never *what* it builds.
 */
/*
 * Per tool, because the same letter means different things: `-s` is
 * `--stacktrace` to Gradle and `--settings` to Maven, `-t` is `--continuous`
 * to one and `--toolchains` to the other.
 */
const SAFE_FLAGS: Record<'maven' | 'gradle', Set<string>> = {
  maven: new Set([
    '-o', '--offline', '-q', '--quiet', '-X', '--debug', '-e', '--errors', '-B', '--batch-mode', '-U',
    '--update-snapshots', '-N', '--non-recursive', '-V', '--show-version', '-ntp', '--no-transfer-progress',
    '-am', '--also-make', '-amd', '--also-make-dependents', '-fae', '--fail-at-end', '-ff', '--fail-fast', '-fn',
    '--fail-never', '-C', '--strict-checksums', '-c', '--lax-checksums', '-cpu', '--check-plugin-updates', '-npu',
    '--no-plugin-updates', '-up', '--update-plugins', '-nsu', '--no-snapshot-updates', '-llr',
    '--legacy-local-repository',
  ]),
  gradle: new Set([
    '--offline', '-q', '--quiet', '--info', '-i', '--warn', '-w', '--debug', '-d', '--stacktrace', '-s',
    '--full-stacktrace', '-S', '--continue', '--rerun-tasks', '--no-daemon', '--daemon', '--parallel',
    '--no-parallel', '--build-cache', '--no-build-cache', '--configuration-cache', '--no-configuration-cache',
    '--refresh-dependencies', '--dry-run', '-m', '--scan', '--no-scan', '--continuous', '-t', '--profile',
    '--console=plain', '--console=rich', '--console=verbose', '--warning-mode=all', '--warning-mode=none',
    '--warning-mode=summary', '--warning-mode=fail',
  ]),
};
/** Flags whose next word belongs to them, and is safe: a module, a task, a thread count, a test name. */
const SAFE_FLAGS_WITH_VALUE: Record<'maven' | 'gradle', Set<string>> = {
  maven: new Set(['-pl', '--projects', '-rf', '--resume-from', '-T', '--threads', '-P', '--activate-profiles']),
  gradle: new Set(['-x', '--exclude-task', '--tests', '--max-workers']),
};
/** System properties that move the build somewhere else, or run something else. */
const UNSAFE_PROPERTIES = /^-D(maven\.(repo\.local|home|multiModuleProjectDirectory|conf|ext\.class\.path|user\.home)|user\.(home|dir)|java\.(home|ext\.dirs|library\.path|security\.[a-z.]+)|org\.gradle\.(java\.home|jvmargs|user\.home|project\.cache\.dir)|gradle\.user\.home|jdk\.[a-z.]*)=/i;

/**
 * Check the words of a run against the allow-list, in order.
 *
 * `-pl :app` is two words that are one flag; the second is let through
 * because the first said so. A `-D` property is fine unless it is one of the
 * few that relocate the build. Anything else that starts with a dash is
 * refused by name, so an extension asking for it can see why.
 */
function checkFlags(tool: 'maven' | 'gradle', words: string[], what: string): void {
  let owed: string | null = null;
  for (const text of words) {
    if (owed) {
      if (text.startsWith('-')) throw new Error(`${owed} needs a value, not another flag`);
      owed = null;
      continue;
    }
    if (!text.startsWith('-')) continue;
    if (SAFE_FLAGS[tool].has(text)) continue;
    if (SAFE_FLAGS_WITH_VALUE[tool].has(text)) {
      owed = text;
      continue;
    }
    // The attached spellings: `-Pprod`, `-T4`, `-T1C`.
    if (tool === 'maven' && /^-(P[!A-Za-z0-9_.,-]+|T\d+C?)$/.test(text)) continue;
    // A system property, unless it is one of the few that relocate the build.
    if (/^-D[A-Za-z0-9_.-]+(=|$)/.test(text) && !UNSAFE_PROPERTIES.test(text)) continue;
    // Gradle's own `-P` project properties.
    if (tool === 'gradle' && /^-P[A-Za-z0-9_.-]+(=|$)/.test(text)) continue;
    throw new Error(`${what} "${text}" is not a flag a panel may pass to a build`);
  }
  if (owed) throw new Error(`${owed} needs a value`);
}

/**
 * A path with `.` and `..` folded away, so that "inside the project" can be
 * decided by looking at it. `/p/shop/../../etc` starts with `/p/shop/` and is
 * not inside anything of the kind.
 */
export function normalisePath(value: string): string {
  const absolute = value.startsWith('/');
  const out: string[] = [];
  for (const part of value.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (out.length) out.pop();
      continue;
    }
    out.push(part);
  }
  return (absolute ? '/' : '') + out.join('/');
}

export type BuildRun = {
  tool: 'maven' | 'gradle';
  /** The project root: where `mvnw` or `gradlew` lives, and what a Gradle task path is relative to. */
  root: string;
  wrapper?: boolean;
  /** For Maven, the module directory to run in; the root when absent. */
  dir?: string;
  goals: string[];
  profiles?: string[];
  skipTests?: boolean;
  offline?: boolean;
  /** Anything extra typed into the run box, already split into words. */
  extra?: string[];
};

/**
 * The command that runs a goal, and where it runs.
 *
 * Built from named parts and never from a line the panel wrote. The panel says
 * which goals, which profiles, which module; the app says which executable
 * runs and from which directory — and that directory is the project the panel
 * was opened on, not one of the panel's choosing.
 *
 * Maven runs *in the module*, the way IntelliJ does: `cd module && mvn
 * package` builds that module and its own children, and leaves the terminal
 * where the person is working. Gradle runs at the root always, because a task
 * path (`:app:build`) already says which project and the wrapper lives there.
 */
export function buildCommand(run: BuildRun): { command: string; cwd: string; title: string } {
  if (run.tool !== 'maven' && run.tool !== 'gradle') throw new Error('That is not a build tool this panel runs');
  if (!run.root) throw new Error('The project has no root');
  const root = normalisePath(String(run.root));
  const rawGoals = (run.goals ?? []).map(String);
  const rawExtra = (run.extra ?? []).map(String);
  if (!rawGoals.length) throw new Error('Nothing to run');
  // A goal is a goal, not a flag in a goal's seat; the flags are checked as
  // one list because `-pl` in one and `:app` in the other is still `-pl :app`.
  checkFlags(run.tool, [...rawGoals, ...rawExtra], 'An argument');
  const goals = rawGoals.map((goal) => word(goal, 'A goal'));
  const extra = rawExtra.map((part) => word(part, 'An argument'));
  const profiles = (run.profiles ?? []).map(String);
  for (const profile of profiles) {
    if (!/^!?[A-Za-z0-9_.-]+$/.test(profile)) throw new Error(`"${profile}" is not a profile id`);
  }
  // Inside the project, or not at all: the panel was opened on this root, and
  // a module it names is one of the root's, not a directory of its own
  // choosing — folded first, so `..` cannot say otherwise.
  const dir = run.dir ? normalisePath(String(run.dir)) : root;
  if (dir !== root && !dir.startsWith(`${root}/`)) {
    throw new Error('That module is not inside the project');
  }

  if (run.tool === 'maven') {
    // The wrapper lives at the root; from a module it is reached by its path.
    const executable = run.wrapper ? shellQuote(`${root}/mvnw`, 'The wrapper') : 'mvn';
    const parts = [executable];
    if (run.offline) parts.push('-o');
    // Through `word`, because `!dev` deactivates a profile to Maven and
    // starts a history expansion to an interactive zsh: quoted, it is text.
    if (profiles.length) parts.push(word(`-P${profiles.join(',')}`, 'The profiles'));
    parts.push(...goals);
    if (run.skipTests) parts.push('-DskipTests');
    parts.push(...extra);
    return {
      command: parts.join(' '),
      cwd: dir,
      title: `mvn ${goals.join(' ')}`.slice(0, 28),
    };
  }

  const parts = [run.wrapper ? './gradlew' : 'gradle'];
  if (run.offline) parts.push('--offline');
  parts.push(...goals);
  if (run.skipTests) parts.push('-x', 'test');
  parts.push(...extra);
  return {
    command: parts.join(' '),
    cwd: root,
    title: `gradle ${goals.map((g) => g.slice(g.lastIndexOf(':') + 1)).join(' ')}`.slice(0, 28),
  };
}

/**
 * The bridge given to the panel, as source.
 *
 * Deliberately tiny, and deliberately the only way out: a panel that wants
 * anything says so through `host`, and what comes back is whatever the app
 * decided to answer.
 *
 * `postMessage` targets `'*'` because a sandboxed frame has no origin to name;
 * the host tells frames apart by comparing `event.source`, which is identity
 * rather than a string anyone could claim.
 */
const SHIM = `(function () {
  var pending = {};
  var listeners = {};
  var next = 0;
  function post(message) { parent.postMessage(message, '*'); }

  window.addEventListener('message', function (event) {
    var message = event.data;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'reply') {
      var waiting = pending[message.id];
      if (!waiting) return;
      delete pending[message.id];
      if (message.ok) waiting.resolve(message.data);
      else waiting.reject(new Error(message.error || 'the app would not do that'));
      return;
    }
    if (message.type === 'copy') {
      // The app's Copy landed while this frame had the focus: what is selected
      // here goes to the app, which owns the clipboard.
      var chosen = String(window.getSelection ? window.getSelection() : '');
      if (chosen) post({ type: 'event', name: 'copy', payload: { text: chosen } });
      return;
    }
    var fns = listeners[message.type] || [];
    for (var i = 0; i < fns.length; i += 1) {
      try { fns[i](message.payload); } catch (error) { /* one listener's problem */ }
    }
  });

  // A frame in an origin of its own has no clipboard; a copy typed here is asked of the app instead.
  document.addEventListener('copy', function (event) {
    var chosen = String(window.getSelection ? window.getSelection() : '');
    if (!chosen) return;
    event.preventDefault();
    post({ type: 'event', name: 'copy', payload: { text: chosen } });
  });

  window.host = {
    /** Ask the app to run one of the things it allows. Resolves with its answer. */
    call: function (name, args) {
      var id = ++next;
      return new Promise(function (resolve, reject) {
        pending[id] = { resolve: resolve, reject: reject };
        post({ type: 'call', id: id, name: name, args: args || {} });
      });
    },
    /** Listen for something the app pushes: 'context', 'changed', 'theme'. */
    on: function (type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    /** Tell the app something: 'openFile', 'notify', 'title'. */
    emit: function (name, payload) { post({ type: 'event', name: name, payload: payload }); },
    /** Say the panel is up, and get the context back. */
    ready: function () { post({ type: 'ready' }); }
  };
})();`;

/** The theme values a panel is given, so it looks like part of the app. */
export type PanelTheme = { dark: boolean; tokens: Record<string, string> };

/**
 * The tokens handed across.
 *
 * Named rather than "whatever the app happens to define": a panel written
 * against a list can be relied on to keep working, and the app can change the
 * rest of its stylesheet without silently changing what extensions look like.
 */
export const THEME_TOKENS = [
  'bg',
  'bg-panel',
  'bg-elevated',
  'bg-input',
  'border',
  'border-strong',
  'text',
  'text-dim',
  'text-faint',
  'accent',
  'accent-soft',
  'danger',
  'ok',
  'git-new',
  'warn',
  'info',
  'violet',
  'on-accent',
  'radius',
  'ui-scale',
];

/** Read the app's own theme, to hand to a panel. */
export function readTheme(): PanelTheme {
  const style = getComputedStyle(document.documentElement);
  const tokens: Record<string, string> = {};
  for (const token of THEME_TOKENS) tokens[token] = style.getPropertyValue(`--${token}`).trim();
  return { dark: document.documentElement.dataset.theme !== 'light', tokens };
}

function cssVariables(theme: PanelTheme): string {
  return THEME_TOKENS.map((token) => `--${token}: ${theme.tokens[token] || 'inherit'};`).join('\n    ');
}

/**
 * Build the document a panel runs as.
 *
 * The extension supplies the body; the app supplies the head. That is not
 * tidiness — it is what stops a panel from declaring its own `<base>`, its own
 * charset, or a `<meta>` that changes how the frame behaves, and it is what
 * guarantees the bridge is in place before any of the extension's own script
 * runs.
 */
export function panelDocument(body: string, theme: PanelTheme): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
  :root {
    ${cssVariables(theme)}
    color-scheme: ${theme.dark ? 'dark' : 'light'};
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  /* The interface text size, applied to the whole panel: its own pixel sizes
     grow and shrink with the window's instead of staying where they were. */
  html { zoom: var(--ui-scale, 1); }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font: 12px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
    overflow: hidden;
  }
  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-thumb { background: var(--border-strong); border: 3px solid transparent; background-clip: content-box; border-radius: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  button { font: inherit; color: inherit; background: none; border: 0; cursor: pointer; }
  /* Everything a panel shows can be selected and copied. A button cannot, so a
     click on one does not start a selection instead of doing what it says. */
  body { user-select: text; -webkit-user-select: text; }
  button, .btn, select { user-select: none; -webkit-user-select: none; }
</style>
<script>${SHIM}</script>
</head>
<body>
${body}
</body>
</html>`;
}
