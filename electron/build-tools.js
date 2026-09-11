'use strict';

/**
 * Reading a Maven or Gradle project, the way a build tool window reads one.
 *
 * What a person wants from a build panel is the shape IntelliJ taught everyone:
 * the project and its modules as a tree, the lifecycle phases under each, the
 * plugins with their goals, the dependencies, the profiles — and a double-click
 * that runs any of them. This file is the reading half. The running half is a
 * real terminal, opened by the app, and none of it happens here.
 *
 * Two different tools, read two different ways, and the difference is honest
 * rather than tidy:
 *
 * **Maven** is read statically. A `pom.xml` says what a project is — its
 * coordinates, its modules, its plugins, its dependencies — and a parse of it is
 * instant. What a pom does not say is which goals a plugin has; those live in
 * the plugin's own descriptor, inside its jar, inside `~/.m2`. So the goals are
 * read from there when the jar has been downloaded, and from a table of the
 * plugins everybody uses when it has not.
 *
 * **Gradle** cannot be read statically in any way worth trusting. A build
 * script is a program, and the tasks it defines are only known by running it —
 * which is exactly what IntelliJ does when it "syncs". So the project structure
 * (which subprojects exist) comes from `settings.gradle`, cheaply, and the
 * tasks come from `gradle tasks --all`, slowly, once, and cached against the
 * build files' mtimes.
 *
 * Everything here that does not touch the disk is pure and tested as such.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { resolvedPath, resolvedVars } = require('./cli-env');

/* --------------------------------------------------------------------------
 * A pom is XML, and this is exactly as much XML as a pom needs.
 *
 * Elements and text, nothing else: attributes are read past, comments and
 * CDATA are skipped, namespaces are dropped. A pom is a tree of named elements
 * with text in the leaves, and a parser that knows only that is a parser that
 * cannot be surprised by one.
 * ------------------------------------------------------------------------ */

/**
 * Parse XML into `{ name, children, text }` nodes.
 *
 * Tolerant on purpose: an unclosed element is closed at the end, a stray close
 * tag is ignored. A pom somebody is in the middle of editing should still show
 * its modules, not an error.
 */
function parseXml(source) {
  const root = { name: '#root', children: [], text: '' };
  const stack = [root];
  const text = String(source ?? '');
  let at = 0;

  while (at < text.length) {
    const open = text.indexOf('<', at);
    if (open === -1) {
      stack[stack.length - 1].text += text.slice(at);
      break;
    }
    if (open > at) stack[stack.length - 1].text += text.slice(at, open);

    if (text.startsWith('<!--', open)) {
      const end = text.indexOf('-->', open + 4);
      at = end === -1 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', open)) {
      const end = text.indexOf(']]>', open + 9);
      stack[stack.length - 1].text += text.slice(open + 9, end === -1 ? text.length : end);
      at = end === -1 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith('<?', open) || text.startsWith('<!', open)) {
      const end = text.indexOf('>', open);
      at = end === -1 ? text.length : end + 1;
      continue;
    }

    const close = tagEnd(text, open + 1);
    if (close === -1) break;
    const inside = text.slice(open + 1, close).trim();
    at = close + 1;

    if (inside.startsWith('/')) {
      const name = localName(inside.slice(1).trim());
      // Pop to the matching element if there is one; a stray close tag is noise.
      for (let i = stack.length - 1; i > 0; i -= 1) {
        if (stack[i].name === name) {
          stack.length = i;
          break;
        }
      }
      continue;
    }

    const selfClosing = inside.endsWith('/');
    const name = localName(inside.replace(/\/$/, '').split(/\s/)[0]);
    const node = { name, children: [], text: '' };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
  }
  return root;
}

/**
 * Where a tag ends: the first `>` that is not inside a quoted attribute value.
 *
 * `<a href="x>y">` is legal XML and a plain `indexOf('>')` would cut it at the
 * `>` in the value, turning `y">` into text and the rest of the file into
 * something that is not the file.
 */
function tagEnd(text, from) {
  let quote = null;
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  return -1;
}

function localName(tag) {
  const cut = tag.indexOf(':');
  return cut === -1 ? tag : tag.slice(cut + 1);
}

/** Decode the five entities XML has, and the numeric ones. */
const NAMED = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };
function decode(text) {
  // One pass, so `&#38;lt;` is `&lt;` and not `<` — decoding twice is the
  // classic way to read a file as something other than what it says.
  return String(text ?? '').replace(/&(#x[0-9a-f]+|#\d+|lt|gt|quot|apos|amp);/gi, (whole, ref) => {
    const lower = ref.toLowerCase();
    if (lower in NAMED) return NAMED[lower];
    const code = lower[1] === 'x' ? parseInt(lower.slice(2), 16) : Number(lower.slice(1));
    // Past the last code point there is nothing to decode to; the text keeps
    // the entity rather than the module keeping an error.
    return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

const child = (node, name) => node?.children?.find((c) => c.name === name) ?? null;
const children = (node, name) => (node?.children ?? []).filter((c) => c.name === name);
const textOf = (node, name) => {
  const found = name ? child(node, name) : node;
  return found ? decode(found.text).trim() : '';
};

/* --------------------------------------------------------------------------
 * Maven.
 * ------------------------------------------------------------------------ */

/** The default lifecycle, in the order Maven runs it. */
const LIFECYCLE = [
  { name: 'clean', description: 'Remove everything the last build produced' },
  { name: 'validate', description: 'Check the project is correct and complete' },
  { name: 'compile', description: 'Compile the sources' },
  { name: 'test', description: 'Run the unit tests' },
  { name: 'package', description: 'Bundle the compiled code — a jar, a war' },
  { name: 'verify', description: 'Run the integration tests and any checks' },
  { name: 'install', description: 'Put the package in the local repository' },
  { name: 'site', description: 'Generate the project site' },
  { name: 'deploy', description: 'Copy the package to the remote repository' },
];

/**
 * The plugins Maven binds by itself, per packaging.
 *
 * A pom that declares no plugins still runs eight of them; IntelliJ lists
 * these because the effective pom lists them, and a Plugins node without
 * `compiler` and `surefire` in it would look broken to anyone who has used it.
 */
const CODE_PLUGINS = ['maven-resources-plugin', 'maven-compiler-plugin', 'maven-surefire-plugin'];
const DEFAULT_PLUGINS = {
  // Every packaging, including `pom`: clean, install, deploy, site. A pom
  // packaging compiles nothing, so it gets none of the three below.
  common: ['maven-clean-plugin', 'maven-install-plugin', 'maven-deploy-plugin', 'maven-site-plugin'],
  jar: [...CODE_PLUGINS, 'maven-jar-plugin'],
  war: [...CODE_PLUGINS, 'maven-war-plugin'],
  ear: ['maven-resources-plugin', 'maven-ear-plugin'],
  ejb: [...CODE_PLUGINS, 'maven-ejb-plugin'],
  'maven-plugin': [...CODE_PLUGINS, 'maven-plugin-plugin', 'maven-jar-plugin'],
  pom: [],
};

/**
 * What the plugins everybody uses can do, for when the jar is not on disk.
 *
 * The descriptor inside the jar is the truth and is preferred; this is what
 * the tree shows before the first build has downloaded anything, so that a
 * freshly cloned project is not a tree of plugins with nothing under them.
 */
const KNOWN_GOALS = {
  'maven-clean-plugin': ['clean'],
  'maven-resources-plugin': ['resources', 'testResources', 'copy-resources'],
  'maven-compiler-plugin': ['compile', 'testCompile'],
  'maven-surefire-plugin': ['test'],
  'maven-failsafe-plugin': ['integration-test', 'verify'],
  'maven-jar-plugin': ['jar', 'test-jar'],
  'maven-war-plugin': ['war', 'exploded'],
  'maven-ear-plugin': ['ear', 'generate-application-xml'],
  'maven-ejb-plugin': ['ejb'],
  'maven-install-plugin': ['install', 'install-file'],
  'maven-deploy-plugin': ['deploy', 'deploy-file'],
  'maven-site-plugin': ['site', 'deploy', 'run', 'stage'],
  'maven-source-plugin': ['jar', 'test-jar', 'aggregate'],
  'maven-javadoc-plugin': ['javadoc', 'jar', 'aggregate'],
  'maven-shade-plugin': ['shade'],
  'maven-assembly-plugin': ['single'],
  'maven-dependency-plugin': ['tree', 'list', 'analyze', 'resolve', 'copy-dependencies', 'purge-local-repository', 'go-offline'],
  'maven-help-plugin': ['effective-pom', 'effective-settings', 'describe', 'active-profiles', 'evaluate'],
  'maven-enforcer-plugin': ['enforce', 'display-info'],
  'maven-release-plugin': ['prepare', 'perform', 'clean', 'rollback'],
  'maven-antrun-plugin': ['run'],
  'maven-plugin-plugin': ['descriptor', 'helpmojo', 'report'],
  'maven-checkstyle-plugin': ['check', 'checkstyle'],
  'maven-pmd-plugin': ['check', 'pmd', 'cpd', 'cpd-check'],
  'spring-boot-maven-plugin': ['run', 'start', 'stop', 'repackage', 'build-image', 'build-info', 'test-run'],
  'versions-maven-plugin': ['display-dependency-updates', 'display-plugin-updates', 'display-property-updates', 'set', 'use-latest-versions'],
  'jacoco-maven-plugin': ['prepare-agent', 'report', 'check', 'report-aggregate'],
  'exec-maven-plugin': ['java', 'exec'],
  'flyway-maven-plugin': ['migrate', 'info', 'clean', 'validate', 'repair', 'baseline'],
  'liquibase-maven-plugin': ['update', 'status', 'rollback', 'diff'],
  'docker-maven-plugin': ['build', 'push', 'start', 'stop', 'remove'],
  'jib-maven-plugin': ['build', 'dockerBuild', 'buildTar'],
  'kotlin-maven-plugin': ['compile', 'test-compile'],
  'lombok-maven-plugin': ['delombok'],
  'frontend-maven-plugin': ['install-node-and-npm', 'npm', 'npx', 'yarn'],
  'sonar-maven-plugin': ['sonar'],
  'spotless-maven-plugin': ['check', 'apply'],
  'fmt-maven-plugin': ['format', 'check'],
  'build-helper-maven-plugin': ['add-source', 'add-test-source', 'parse-version'],
  'protobuf-maven-plugin': ['compile', 'compile-custom', 'test-compile'],
  'openapi-generator-maven-plugin': ['generate'],
  'quarkus-maven-plugin': ['dev', 'build', 'generate-code', 'test'],
  'micronaut-maven-plugin': ['run', 'dockerfile'],
};

/**
 * What `mvn` calls a plugin on the command line.
 *
 * The descriptor carries the real prefix; without one, Maven's own convention
 * gets it right for nearly every plugin there is: `maven-X-plugin` and
 * `X-maven-plugin` are both invoked as `X:goal`.
 */
function prefixOf(artifactId) {
  const id = String(artifactId ?? '');
  let match = /^maven-(.+)-plugin$/.exec(id);
  if (match) return match[1];
  match = /^(.+)-maven-plugin$/.exec(id);
  if (match) return match[1];
  return id.replace(/-plugin$/, '');
}

/**
 * `${property}` references, resolved against what the pom and its parents say.
 *
 * Only what can be known without Maven: the project's own coordinates, its
 * `<properties>`, and the parents' up the `relativePath` chain. Anything
 * else — a property from a settings.xml profile, from the command line —
 * stays as written, which is also what IntelliJ shows in that case.
 */
function resolveProps(value, props) {
  let text = String(value ?? '');
  for (let round = 0; round < 6 && text.includes('${'); round += 1) {
    const before = text;
    text = text.replace(/\$\{([^}]+)\}/g, (whole, key) => (Object.hasOwn(props, key) ? props[key] : whole));
    if (text === before) break;
  }
  return text;
}

/** One pom, as its own model. Pure: takes the text, returns what it says. */
function parsePom(source) {
  const project = child(parseXml(source), 'project');
  if (!project) return null;

  const parent = child(project, 'parent');
  const parentModel = parent
    ? {
        groupId: textOf(parent, 'groupId'),
        artifactId: textOf(parent, 'artifactId'),
        version: textOf(parent, 'version'),
        // Maven's default when the element is missing; an empty element means "none".
        relativePath: parent.children.some((c) => c.name === 'relativePath')
          ? textOf(parent, 'relativePath')
          : '../pom.xml',
      }
    : null;

  // A null-prototype map: `${constructor}` must be a property nobody set,
  // not the Object constructor's source.
  const properties = Object.create(null);
  for (const prop of child(project, 'properties')?.children ?? []) properties[prop.name] = decode(prop.text).trim();

  const coords = {
    groupId: textOf(project, 'groupId') || parentModel?.groupId || '',
    artifactId: textOf(project, 'artifactId'),
    version: textOf(project, 'version') || parentModel?.version || '',
    packaging: textOf(project, 'packaging') || 'jar',
    name: textOf(project, 'name'),
  };

  const dependency = (node) => ({
    groupId: textOf(node, 'groupId'),
    artifactId: textOf(node, 'artifactId'),
    version: textOf(node, 'version'),
    scope: textOf(node, 'scope') || 'compile',
    type: textOf(node, 'type') || 'jar',
    optional: textOf(node, 'optional') === 'true',
  });

  const plugin = (node) => ({
    groupId: textOf(node, 'groupId') || 'org.apache.maven.plugins',
    artifactId: textOf(node, 'artifactId'),
    version: textOf(node, 'version'),
    // `<inherited>false</inherited>` keeps a plugin out of the children.
    inherited: textOf(node, 'inherited') !== 'false',
  });

  const build = child(project, 'build');
  return {
    ...coords,
    parent: parentModel,
    properties,
    modules: children(child(project, 'modules'), 'module').map((m) => decode(m.text).trim()).filter(Boolean),
    dependencies: children(child(project, 'dependencies'), 'dependency').map(dependency),
    managedDependencies: children(child(child(project, 'dependencyManagement'), 'dependencies'), 'dependency').map(dependency),
    plugins: children(child(build, 'plugins'), 'plugin').map(plugin),
    managedPlugins: children(child(child(build, 'pluginManagement'), 'plugins'), 'plugin').map(plugin),
    profiles: children(child(project, 'profiles'), 'profile').map((p) => ({
      id: textOf(p, 'id'),
      activeByDefault: textOf(child(p, 'activation'), 'activeByDefault') === 'true',
      modules: children(child(p, 'modules'), 'module').map((m) => decode(m.text).trim()).filter(Boolean),
    })),
  };
}

/**
 * The version a dependency or plugin actually has, once the parents have had
 * their say.
 *
 * A pom leaves versions out on purpose and lets `dependencyManagement` up the
 * chain fill them in — the Spring Boot parent manages a thousand of them. This
 * looks up the chain that is on disk; a parent that only exists in a remote
 * repository is not read, and the version stays blank, which is the truth of
 * what this machine knows.
 */
function managedVersion(item, kind, chain) {
  for (const model of chain) {
    const list = kind === 'plugin' ? model.managedPlugins : model.managedDependencies;
    const found = list.find((m) => m.groupId === item.groupId && m.artifactId === item.artifactId);
    if (found?.version) return found.version;
  }
  return '';
}

/** The properties of a pom and every parent above it, nearest wins. */
function propertiesOf(chain) {
  const props = Object.create(null);
  for (let i = chain.length - 1; i >= 0; i -= 1) Object.assign(props, chain[i].properties);
  const self = chain[0];
  Object.assign(props, {
    'project.groupId': self.groupId,
    'project.artifactId': self.artifactId,
    'project.version': self.version,
    'project.parent.version': self.parent?.version ?? '',
    'project.parent.groupId': self.parent?.groupId ?? '',
    'pom.version': self.version,
    'pom.groupId': self.groupId,
  });
  return props;
}

/* --------------------------------------------------------------------------
 * Reading from the disk.
 * ------------------------------------------------------------------------ */

const MAVEN_FILES = ['pom.xml'];
const GRADLE_SETTINGS = ['settings.gradle.kts', 'settings.gradle'];
const GRADLE_BUILDS = ['build.gradle.kts', 'build.gradle'];

const exists = (file) => {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};

const firstExisting = (dir, names) => names.map((name) => path.join(dir, name)).find(exists) ?? null;

/**
 * Where the project is, starting from any folder inside it.
 *
 * Walks up. A Gradle project's root is wherever `settings.gradle` is, and the
 * highest one wins, so a folder opened three levels down still gets the whole
 * build. A Maven project's root is the highest `pom.xml` in an unbroken run of
 * them — a pom above a pom is an aggregator far more often than a coincidence,
 * and a break in the run is a different project entirely.
 *
 * When both are present the nearer one wins, and Gradle wins a tie: a project
 * that has both is nearly always one being migrated, and the one that is still
 * being edited is the one with the settings file.
 */
function findRoot(dir) {
  let at = path.resolve(String(dir ?? '') || os.homedir());
  let maven = null;
  let gradle = null;
  let mavenRun = true;

  for (let depth = 0; depth < 40; depth += 1) {
    if (firstExisting(at, GRADLE_SETTINGS)) gradle = at;
    else if (!gradle && firstExisting(at, GRADLE_BUILDS)) gradle = at;

    if (mavenRun && firstExisting(at, MAVEN_FILES)) maven = at;
    else if (maven) mavenRun = false;

    const up = path.dirname(at);
    if (up === at) break;
    at = up;
  }

  if (gradle && maven) {
    // The nearer one, as measured by how far under it the folder is.
    return gradle.length >= maven.length ? { tool: 'gradle', root: gradle } : { tool: 'maven', root: maven };
  }
  if (gradle) return { tool: 'gradle', root: gradle };
  if (maven) return { tool: 'maven', root: maven };
  return null;
}

/**
 * What one read of a project remembers, so it does not do anything twice.
 *
 * A twenty-five-module project names the same parent twenty-five times, and
 * that parent's parent is the Spring Boot BOM: a hundred and forty kilobytes
 * of XML that is the same file every time. Poms are parsed once per read,
 * plugin directories listed once per read, and the read is what is thrown
 * away — a cache that outlived it would be a cache that has to be invalidated
 * when a pom changes, and a read is cheap enough not to need one.
 */
function readContext(goalsFor) {
  return { poms: new Map(), newest: new Map(), seen: new Set(), goalsFor };
}

/** Read a pom, or say that it could not be. Once per file per read. */
function readPom(file, ctx = null) {
  if (ctx?.poms.has(file)) return ctx.poms.get(file);
  let result;
  try {
    result = { model: parsePom(fs.readFileSync(file, 'utf8')), error: null };
  } catch (error) {
    result = { model: null, error: String(error?.message ?? error) };
  }
  if (ctx) ctx.poms.set(file, result);
  return result;
}

/**
 * A coordinate that can be a path segment.
 *
 * groupId, artifactId and version come out of a pom, and a pom is a file
 * somebody else wrote. Each of them becomes a folder name under `~/.m2`, so
 * one that is `..` or carries a slash would name a folder that is not under
 * `~/.m2` at all. Maven's own rules are looser than this, but nothing that
 * fails it has ever been published.
 */
function isCoordinate(value) {
  return /^[A-Za-z0-9_.\-]+$/.test(String(value ?? '')) && value !== '.' && value !== '..';
}

/** Where the local repository keeps a pom, if it has it. */
function pomInRepository({ groupId, artifactId, version } = {}) {
  if (!groupId || !artifactId || !version || version.includes('${')) return null;
  if (!isCoordinate(artifactId) || !isCoordinate(version) || !groupId.split('.').every(isCoordinate)) return null;
  const file = path.join(localRepository(), ...groupId.split('.'), artifactId, version, `${artifactId}-${version}.pom`);
  return exists(file) ? file : null;
}

/**
 * The parents of a pom that are on this disk, nearest first.
 *
 * Maven's rule, followed exactly: look where `relativePath` points (a folder
 * or a file; `../pom.xml` when nothing is said; nowhere when it is empty), and
 * if the pom there is not the parent named — a different artifact, which is
 * what an aggregator beside its modules usually is — go to the local
 * repository instead. Not giving up there is the difference between a
 * Dependencies node with versions and one without, for every module whose
 * parent lives under a sibling folder.
 *
 * Bounded, because two poms that name each other as parents would otherwise
 * be read for ever.
 */
function parentChain(model, dir, ctx) {
  const chain = [model];
  let current = model;
  let at = dir;
  const seen = new Set();
  while (current?.parent && chain.length < 12) {
    const wanted = current.parent;
    let file = wanted.relativePath ? path.resolve(at, wanted.relativePath) : null;
    try {
      if (file && fs.statSync(file).isDirectory()) file = path.join(file, 'pom.xml');
    } catch {
      file = null;
    }
    let parent = file && !seen.has(file) ? readPom(file, ctx).model : null;
    const isIt = (candidate) =>
      candidate &&
      candidate.artifactId === wanted.artifactId &&
      (!wanted.groupId || !candidate.groupId || candidate.groupId === wanted.groupId);
    if (!isIt(parent)) {
      file = pomInRepository(wanted);
      parent = file && !seen.has(file) ? readPom(file, ctx).model : null;
      if (!isIt(parent)) break;
    }
    seen.add(file);
    chain.push(parent);
    current = parent;
    at = path.dirname(file);
  }
  return chain;
}

/** A path with symlinks followed, or the path itself when they cannot be. */
function realPath(file) {
  try {
    return fs.realpathSync.native(file);
  } catch {
    return file;
  }
}

/** No project nests modules this deep; a symlink pointing back up does. */
const MODULE_DEPTH = 32;

/**
 * A module and everything under it.
 *
 * Recursive over `<modules>`, each entry a folder (or a pom file) relative to
 * this one. Profile modules are read too, marked with the profile that brings
 * them in, because a module that only exists under `-Pfull` is still a module
 * somebody will want to build.
 */
async function readModule(dir, root, ctx, depth = 0) {
  const file = path.join(dir, 'pom.xml');
  const relative = path.relative(root, dir) || '.';
  // Seen by where it really is: a `<module>` that is a symlink back to an
  // ancestor spells a new path every level and the same pom every time.
  const identity = realPath(file);
  if (ctx.seen.has(identity) || depth > MODULE_DEPTH) return null;
  ctx.seen.add(identity);

  const { model, error } = readPom(file, ctx);
  if (!model) {
    return { dir, relative, file, artifactId: path.basename(dir), error: error ?? 'no <project> in it', modules: [] };
  }

  const chain = parentChain(model, dir, ctx);
  const props = propertiesOf(chain);
  const resolve = (value) => resolveProps(value, props);

  /*
   * The plugins, in the order the effective pom would list them: the module's
   * own, then what the parents declare for their children, then what the
   * packaging binds by itself. A child of the Spring Boot parent runs
   * `spring-boot:repackage` without ever naming the plugin, and a Plugins node
   * that hid it would be hiding the one goal that project is built for.
   */
  const declared = new Map();
  for (const plugin of model.plugins) declared.set(`${plugin.groupId}:${plugin.artifactId}`, plugin);
  for (const parent of chain.slice(1)) {
    for (const plugin of parent.plugins) {
      const key = `${plugin.groupId}:${plugin.artifactId}`;
      if (plugin.inherited && !declared.has(key)) declared.set(key, { ...plugin, fromParent: parent.artifactId });
    }
  }
  const bound = [...DEFAULT_PLUGINS.common, ...(Object.hasOwn(DEFAULT_PLUGINS, model.packaging) ? DEFAULT_PLUGINS[model.packaging] : [])];
  for (const artifactId of bound) {
    const key = `org.apache.maven.plugins:${artifactId}`;
    if (!declared.has(key)) declared.set(key, { groupId: 'org.apache.maven.plugins', artifactId, version: '', implied: true });
  }

  const plugins = [];
  for (const plugin of declared.values()) {
    const version = resolve(plugin.version || managedVersion(plugin, 'plugin', chain));
    // One plugin that cannot be described is one plugin without goals, not a
    // module without a tree.
    let described;
    try {
      described = await ctx.goalsFor(plugin.groupId, plugin.artifactId, version, ctx);
    } catch {
      described = { prefix: '', goals: [], resolved: false };
    }
    plugins.push({
      groupId: plugin.groupId,
      artifactId: plugin.artifactId,
      version,
      implied: Boolean(plugin.implied),
      inherited: plugin.fromParent ?? null,
      prefix: described.prefix || prefixOf(plugin.artifactId),
      goals: described.goals ?? [],
      // Whether the goals came from the plugin itself or from the table.
      resolved: Boolean(described.resolved),
    });
  }

  const dependencies = model.dependencies.map((dep) => ({
    ...dep,
    groupId: resolve(dep.groupId),
    version: resolve(dep.version || managedVersion(dep, 'dependency', chain)),
  }));

  const entries = [
    ...model.modules.map((m) => ({ module: m, profile: null })),
    ...model.profiles.flatMap((p) => p.modules.map((m) => ({ module: m, profile: p.id }))),
  ];
  const modules = [];
  for (const entry of entries) {
    let target = path.resolve(dir, entry.module);
    if (target.endsWith('pom.xml')) target = path.dirname(target);
    const sub = await readModule(target, root, ctx, depth + 1);
    if (sub) modules.push({ ...sub, profile: entry.profile });
  }

  return {
    dir,
    relative,
    file,
    // A module aggregated from outside the project folder — `../sibling` from
    // a root that has nothing above it — is listed, because it is part of the
    // build, and marked, because a run cannot be started in it from here.
    outside: dir !== root && !dir.startsWith(root + path.sep),
    groupId: resolve(model.groupId),
    artifactId: model.artifactId,
    version: resolve(model.version),
    packaging: model.packaging,
    name: resolve(model.name),
    plugins,
    dependencies,
    profiles: model.profiles.map((p) => ({ id: p.id, activeByDefault: p.activeByDefault })),
    modules,
    error: null,
  };
}

/**
 * A plugin's goals, out of the descriptor in its jar.
 *
 * `~/.m2/repository/<group as path>/<artifact>/<version>/<artifact>-<version>.jar`
 * carries `META-INF/maven/plugin.xml`, which lists every goal with a sentence
 * about it. A jar is a zip and `unzip -p` reads one member of it to stdout,
 * which is a great deal simpler than a zip reader of our own and is on every
 * machine this runs on.
 *
 * Without a version — a plugin the pom leaves to Maven — the newest one on
 * disk is used, which is very likely the one Maven will run. Nothing on disk
 * at all, and the table of known goals answers instead.
 */
const goalCache = new Map();
/** Whether `unzip` exists at all; a machine without it is asked once, not per plugin. */
let unzipMissing = false;

/**
 * Where Maven keeps what it downloads.
 *
 * `~/.m2/repository` unless `~/.m2/settings.xml` says `<localRepository>`
 * (or `MAVEN_OPTS` carries `-Dmaven.repo.local=`), which people with a small
 * system disk do say. Read once: it changes about as often as Maven is
 * reinstalled, and reading it per plugin would be reading it two hundred
 * times per project.
 */
let repositoryDir = null;
function localRepository() {
  if (repositoryDir) return repositoryDir;
  const home = os.homedir();
  let dir = null;
  const fromOpts = /-Dmaven\.repo\.local=("[^"]+"|\S+)/.exec(process.env.MAVEN_OPTS ?? '');
  if (fromOpts) dir = fromOpts[1].replace(/^"|"$/g, '');
  if (!dir) {
    const settings = path.join(home, '.m2', 'settings.xml');
    if (exists(settings)) {
      try {
        const said = textOf(child(parseXml(fs.readFileSync(settings, 'utf8')), 'settings'), 'localRepository');
        if (said) dir = said.replace(/\$\{user\.home\}/g, home).replace(/^~(?=\/|$)/, home);
      } catch {
        /* an unreadable settings file means the default */
      }
    }
  }
  repositoryDir = dir && path.isAbsolute(dir) ? dir : path.join(home, '.m2', 'repository');
  return repositoryDir;
}

/** For tests: read the settings again. */
function forgetLocalRepository() {
  repositoryDir = null;
}

/**
 * The newest version of an artifact that has a jar on disk.
 *
 * With a jar, because `versions:display-plugin-updates` leaves a folder with
 * only a pom in it for every version it looked at, and the newest folder is
 * then the one with nothing to read.
 */
function newestOnDisk(artifactDir, artifactId, ctx = null) {
  if (ctx?.newest.has(artifactDir)) return ctx.newest.get(artifactDir);
  let entries = [];
  try {
    entries = fs.readdirSync(artifactDir, { withFileTypes: true });
  } catch {
    if (ctx) ctx.newest.set(artifactDir, null);
    return null;
  }
  const versions = entries.filter((e) => e.isDirectory() && /^\d/.test(e.name)).map((e) => e.name);
  versions.sort(compareVersions).reverse();
  const found = versions.find((version) => exists(path.join(artifactDir, version, `${artifactId}-${version}.jar`))) ?? null;
  if (ctx) ctx.newest.set(artifactDir, found);
  return found;
}

/**
 * Numeric-aware, and aware that a qualifier is *older*: Maven's rule is that
 * `3.9.0-SNAPSHOT` and `3.9.0-M1` both come before `3.9.0`, and a table that
 * put the milestone first would read the milestone's descriptor for a plugin
 * whose release is sitting beside it.
 */
function compareVersions(a, b) {
  const parts = (v) => String(v).split(/[.\-]/).map((p) => (/^\d+$/.test(p) ? Number(p) : p));
  const left = parts(a);
  const right = parts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const l = left[i];
    const r = right[i];
    if (l === r) continue;
    // Nothing more on one side: a trailing qualifier makes the other side
    // older; a trailing number makes it newer.
    if (l === undefined) return typeof r === 'number' ? -1 : 1;
    if (r === undefined) return typeof l === 'number' ? 1 : -1;
    if (typeof l === 'number' && typeof r === 'number') return l - r;
    if (typeof l === 'number') return 1;
    if (typeof r === 'number') return -1;
    return String(l).localeCompare(String(r));
  }
  return 0;
}

/** What a plugin descriptor says: its prefix and its goals. Pure. */
function parsePluginDescriptor(source) {
  const plugin = child(parseXml(source), 'plugin');
  if (!plugin) return null;
  return {
    prefix: textOf(plugin, 'goalPrefix'),
    goals: children(child(plugin, 'mojos'), 'mojo')
      .map((mojo) => ({ name: textOf(mojo, 'goal'), description: oneSentence(textOf(mojo, 'description')) }))
      .filter((goal) => goal.name),
  };
}

/** The first sentence of a description, with the HTML the descriptors carry taken out. */
function oneSentence(text) {
  const plain = String(text ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const cut = plain.search(/\.\s|\.$/);
  return (cut === -1 ? plain : plain.slice(0, cut + 1)).slice(0, 160);
}

function unzipMember(jar, member) {
  if (unzipMissing) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('unzip', ['-p', jar, member], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error?.code === 'ENOENT') unzipMissing = true;
      resolve(error ? null : stdout);
    });
  });
}

async function goalsFromRepository(groupId, artifactId, version, ctx) {
  if (!isCoordinate(artifactId) || !String(groupId ?? '').split('.').every(isCoordinate)) return null;
  const artifactDir = path.join(localRepository(), ...String(groupId).split('.'), artifactId);
  const chosen = version && isCoordinate(version) ? version : newestOnDisk(artifactDir, artifactId, ctx);
  if (!chosen) return null;
  const jar = path.join(artifactDir, chosen, `${artifactId}-${chosen}.jar`);
  if (!exists(jar)) return null;
  /*
   * Remembered either way. A jar with no descriptor in it — declared as a
   * plugin, but not one — is the same jar on every module of the project, and
   * asking `unzip` about it twenty-five times per read was measured, not
   * imagined. The promise can never reject: a descriptor that will not parse
   * is a plugin with no goals, not a poisoned cache entry.
   */
  if (!goalCache.has(jar)) {
    goalCache.set(
      jar,
      unzipMember(jar, 'META-INF/maven/plugin.xml')
        .then((xml) => (xml ? parsePluginDescriptor(xml) : null))
        .catch(() => null),
    );
  }
  return goalCache.get(jar);
}

/** The goals of a plugin, from the jar when it is there and the table when it is not. */
async function describePlugin(groupId, artifactId, version, ctx) {
  const found = await goalsFromRepository(groupId, artifactId, version, ctx).catch(() => null);
  if (found?.goals?.length) return { ...found, resolved: true };
  const known = Object.hasOwn(KNOWN_GOALS, artifactId) ? KNOWN_GOALS[artifactId] : [];
  return { prefix: '', goals: known.map((name) => ({ name, description: '' })), resolved: false };
}

/** The whole Maven project under a root. */
async function readMavenProject(root, { goalsFor = describePlugin } = {}) {
  const project = await readModule(root, root, readContext(goalsFor));
  return {
    ok: true,
    tool: 'maven',
    root,
    wrapper: exists(path.join(root, 'mvnw')),
    lifecycle: LIFECYCLE,
    project,
  };
}

/* --------------------------------------------------------------------------
 * Gradle.
 * ------------------------------------------------------------------------ */

/**
 * What `settings.gradle` says the build is made of. Pure.
 *
 * Both dialects: `include 'a', 'b'`, `include("a", "b")`, `include(":a:b")`,
 * the same spread over several lines, `includeFlat` (siblings of the root,
 * not children), `project(":x").projectDir = file("libs/x")`, and
 * `rootProject.name = "x"`. A settings file is a program too, and one that
 * builds its include list in a loop is beyond this — but `gradle tasks --all`
 * names every project anyway, and the tree fills in from that when the tasks
 * arrive.
 */
function parseGradleSettings(source) {
  const text = String(source ?? '').replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const name = /rootProject\.name\s*=\s*["']([^"']+)["']/.exec(text)?.[1] ?? '';
  const projects = new Map(); // path -> relative dir
  const normalise = (id) => (id.startsWith(':') ? id : `:${id}`);
  const dirOf = (id) => normalise(id).slice(1).split(':').join('/');

  // `include(` up to its `)`, or `include 'a',\n 'b'` up to the first line
  // that does not end in a comma. Either way, every quoted string inside.
  const keyword = /\b(include|includeFlat)\b/g;
  let match;
  while ((match = keyword.exec(text))) {
    const flat = match[1] === 'includeFlat';
    let at = match.index + match[0].length;
    while (at < text.length && (text[at] === ' ' || text[at] === '\t')) at += 1;
    let list;
    if (text[at] === '(') {
      const close = text.indexOf(')', at);
      list = text.slice(at + 1, close === -1 ? text.length : close);
      keyword.lastIndex = close === -1 ? text.length : close;
    } else {
      const lines = [];
      let from = at;
      for (;;) {
        const nl = text.indexOf('\n', from);
        const line = text.slice(from, nl === -1 ? text.length : nl);
        lines.push(line);
        from = nl === -1 ? text.length : nl + 1;
        if (!line.trim().endsWith(',') || nl === -1) break;
      }
      list = lines.join('\n');
      keyword.lastIndex = from;
    }
    for (const quoted of list.matchAll(/["']([^"']+)["']/g)) {
      const id = quoted[1].trim();
      if (!id) continue;
      projects.set(normalise(id), flat ? `../${id.replace(/^:/, '')}` : dirOf(id));
    }
  }
  // A project moved somewhere else: `project(":x").projectDir = file("libs/x")`
  // and the block form `project(":x") { projectDir = file("libs/x") }`.
  const moved = /project\s*\(\s*["'](:?[^"']+)["']\s*\)\s*(?:\.\s*projectDir\s*=|\{[^}]*?projectDir\s*=)\s*(?:new\s+File|file)\s*\(\s*["']([^"']+)["']/g;
  while ((match = moved.exec(text))) {
    const id = normalise(match[1]);
    if (projects.has(id)) projects.set(id, match[2]);
  }
  return { name, projects: [...projects.keys()], dirs: Object.fromEntries(projects) };
}

/**
 * The dependencies a build script declares. Pure, and static, and it says so.
 *
 * `implementation("g:a:v")`, `testImplementation 'g:a:v'`, `api(project(":x"))`,
 * `platform(...)` with a string or a catalog entry, `kotlin("stdlib")`, and
 * the `group:`/`name:`/`version:` map form. A version catalog reference
 * (`libs.foo`) is kept as written: what it resolves to lives in a TOML file
 * and, honestly, only Gradle knows. The resolved tree is a click away.
 *
 * Only the top-level `dependencies {}` blocks: the one inside `buildscript`
 * lists what the *build script* needs, and a file whose first block is that
 * one would otherwise show the Android Gradle plugin as the project's only
 * dependency. Inside a block, a line nested in a dependency's own closure —
 * `because(...)`, `version { strictly(...) }`, `exclude(...)` — is not a
 * dependency either.
 */
function parseGradleDependencies(source) {
  const text = String(source ?? '').replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  const opener = /\bdependencies\s*\{/g;
  let match;
  while ((match = opener.exec(text))) {
    if (braceDepth(text, match.index) !== 0) continue;
    const from = match.index + match[0].length;
    const end = blockEnd(text, from);
    parseDependencyBlock(text.slice(from, end), out);
    opener.lastIndex = end;
  }
  return out;
}

/** How many `{` are open before `at`. */
function braceDepth(text, at) {
  let depth = 0;
  for (let i = 0; i < at; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') depth -= 1;
  }
  return depth;
}

/** The index of the `}` that closes a block whose `{` was just before `from`. */
function blockEnd(text, from) {
  let depth = 1;
  for (let i = from; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return text.length;
}

const NOT_DEPENDENCIES = new Set(['constraints', 'components', 'modules', 'if', 'for', 'while', 'add', 'because',
  'version', 'strictly', 'prefer', 'reject', 'require', 'exclude', 'attributes', 'attribute', 'capabilities',
  'requireCapability', 'targetConfiguration', 'isTransitive', 'transitive', 'changing', 'artifact']);

function parseDependencyBlock(body, out) {
  const line = /^\s*([A-Za-z][A-Za-z0-9]*)\s*\(?\s*(.+?)\s*\)?\s*(?:\{[\s\S]*?\})?\s*$/;
  let nested = 0;
  for (const raw of body.split('\n')) {
    const opens = (raw.match(/\{/g) ?? []).length - (raw.match(/\}/g) ?? []).length;
    // Inside a dependency's own closure, or a `constraints {}` block: skip
    // until it closes. Counted per line, which is what these blocks are.
    if (nested > 0) {
      nested += opens;
      continue;
    }
    const match = line.exec(raw);
    if (opens > 0) nested += opens;
    if (!match) continue;
    const configuration = match[1];
    if (NOT_DEPENDENCIES.has(configuration)) continue;
    const rest = match[2];
    const project = /project\s*\(\s*(?:path\s*[:=]\s*)?["']([^"']+)["']/.exec(rest);
    const platform = /(?:platform|enforcedPlatform)\s*\(\s*(?:["']([^"']+)["']|(libs(?:\.[A-Za-z0-9_]+)+))/.exec(rest);
    if (platform) {
      out.push({ configuration, notation: platform[1] ?? platform[2], platform: true, ...(platform[2] ? { catalog: true } : {}) });
      continue;
    }
    if (project) {
      out.push({ configuration, notation: `project ${project[1]}`, project: project[1] });
      continue;
    }
    const quoted = /^["']([^"']+)["']/.exec(rest);
    if (quoted) {
      out.push({ configuration, notation: quoted[1] });
      continue;
    }
    const kotlin = /^kotlin\s*\(\s*["']([^"']+)["']/.exec(rest);
    if (kotlin) {
      out.push({ configuration, notation: `org.jetbrains.kotlin:kotlin-${kotlin[1]}` });
      continue;
    }
    const map = /group\s*[:=]\s*["']([^"']+)["'].*?name\s*[:=]\s*["']([^"']+)["'](?:.*?version\s*[:=]\s*["']([^"']+)["'])?/.exec(rest);
    if (map) {
      out.push({ configuration, notation: [map[1], map[2], map[3]].filter(Boolean).join(':') });
      continue;
    }
    const catalog = /^(libs(?:\.[A-Za-z0-9_]+)+)/.exec(rest);
    if (catalog) out.push({ configuration, notation: catalog[1].replace(/\.get$/, ''), catalog: true });
  }
}

/**
 * `gradle tasks --all` as a tree of groups. Pure.
 *
 * The output is sections: a heading, a line of dashes, then `name - description`
 * per task until a blank line. With `--all`, subproject tasks appear as
 * `app:compileJava`. Everything before the first heading and the trailing
 * usage notes are not tasks and are skipped.
 */
function parseGradleTasks(output) {
  const groups = [];
  const lines = String(output ?? '').replace(/\r/g, '').split('\n');
  let current = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const next = lines[i + 1] ?? '';
    if (/^-{3,}\s*$/.test(next) && /\btasks$/i.test(line.trim())) {
      current = { name: line.trim().replace(/\s+tasks$/i, ''), tasks: [] };
      groups.push(current);
      i += 1;
      continue;
    }
    if (!current) continue;
    if (!line.trim()) continue;
    if (/^-{3,}\s*$/.test(line)) continue;
    // A deprecation notice can land anywhere; it is not the end of a group.
    if (/^Deprecated Gradle features/.test(line.trim())) continue;
    // "Rules", "Pattern:", "To see all tasks..." — the notes at the end.
    if (/^(Rules|Pattern:|To see|BUILD |\d+ actionable)/.test(line.trim())) {
      current = null;
      continue;
    }
    const match = /^([A-Za-z0-9_:\-.]+)(?:\s+-\s+(.*))?$/.exec(line.trim());
    if (!match) continue;
    const full = match[1].startsWith(':') ? match[1] : `:${match[1]}`;
    const cut = full.lastIndexOf(':');
    current.tasks.push({
      path: full,
      name: full.slice(cut + 1),
      project: cut === 0 ? ':' : full.slice(0, cut),
      description: match[2] ?? '',
    });
  }
  return groups.filter((group) => group.tasks.length);
}

/**
 * `gradle dependencies --configuration X` as a tree. Pure.
 *
 * Gradle draws it with `+---` and `\---` and `|    ` indents, five columns per
 * level. Each line is a notation, optionally with ` -> version` (or
 * ` -> project :x`) when a conflict was resolved, ` (*)` when it was already
 * shown above, ` (c)` for a constraint, ` (n)` for one not resolved, and
 * ` FAILED` for one that could not be. The tree is kept as a tree because that
 * is what it is: flattening it hides exactly the question — "who pulled this
 * in" — that anybody opening it is asking.
 */
function parseGradleDependencyTree(output, configuration) {
  const lines = String(output ?? '').replace(/\r/g, '').split('\n');
  const start = lines.findIndex((line) => line.startsWith(`${configuration} `) || line === configuration);
  if (start === -1) return { configuration, resolved: false, nodes: [] };
  const roots = [];
  const stack = [{ depth: -1, children: roots }];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) break;
    const match = /^((?:[| ]{5})*)[+\\]---\s(.*)$/.exec(line);
    if (!match) {
      if (/^No dependencies/.test(line.trim())) break;
      continue;
    }
    const depth = Math.round(match[1].length / 5);
    let text = match[2].trim();
    const failed = / FAILED$/.test(text);
    text = text.replace(/ FAILED$/, '');
    const seen = / \(\*\)$/.test(text);
    const constraint = / \(c\)$/.test(text);
    const notResolved = / \(n\)$/.test(text);
    text = text.replace(/ \((\*|c|n)\)$/, '');
    let resolvedTo = null;
    const arrow = / -> (.+)$/.exec(text);
    if (arrow) {
      resolvedTo = arrow[1];
      text = text.slice(0, arrow.index);
    }
    const node = { notation: text, resolvedTo, seen, constraint, notResolved, failed, children: [] };
    while (stack.length > 1 && stack[stack.length - 1].depth >= depth) stack.pop();
    stack[stack.length - 1].children.push(node);
    stack.push({ depth, children: node.children });
  }
  return { configuration, resolved: true, nodes: roots };
}

/** The projects a build has, from its settings: paths and where each lives. */
function gradleLayout(root) {
  const settingsFile = firstExisting(root, GRADLE_SETTINGS);
  const settings = settingsFile ? parseGradleSettings(safeRead(settingsFile)) : { name: '', projects: [], dirs: {} };
  return {
    settingsFile,
    name: settings.name,
    projects: settings.projects.map((id) => ({
      path: id,
      dir: path.resolve(root, settings.dirs[id] ?? id.slice(1).split(':').join('/')),
    })),
  };
}

/**
 * The static half of a Gradle project: what settings and the build scripts say.
 *
 * Fast, and honest about being partial: `tasks` is null until they have been
 * asked for, because asking means running Gradle.
 */
function readGradleProject(root) {
  const layout = gradleLayout(root);
  const buildFile = firstExisting(root, GRADLE_BUILDS);

  const projectOf = (id, dir) => ({
    path: id,
    name: id === ':' ? layout.name || path.basename(root) : id.slice(id.lastIndexOf(':') + 1),
    dir,
    relative: path.relative(root, dir) || '.',
    file: firstExisting(dir, GRADLE_BUILDS),
    dependencies: parseGradleDependencies(safeRead(firstExisting(dir, GRADLE_BUILDS))),
  });

  const subprojects = layout.projects.map((p) => projectOf(p.path, p.dir));
  return {
    ok: true,
    tool: 'gradle',
    root,
    wrapper: exists(path.join(root, 'gradlew')),
    kotlin: Boolean(buildFile?.endsWith('.kts') || layout.settingsFile?.endsWith('.kts')),
    project: { ...projectOf(':', root), subprojects },
    tasks: null,
  };
}

function safeRead(file) {
  if (!file) return '';
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/* --------------------------------------------------------------------------
 * Running Gradle to ask it things. Cached, because it is slow.
 * ------------------------------------------------------------------------ */

/** Gradle starts a daemon on first run; a cold one can take a while. */
const GRADLE_TIMEOUT = 180000;

/**
 * What a build needs from the shell besides PATH.
 *
 * `JAVA_HOME` above all: the wrapper prefers it, and a `.zshrc` that pins it
 * to 17 while `/usr/bin/java` resolves to the newest JDK on the machine is a
 * terminal that builds and a panel that says "Unsupported class file major
 * version". `GRADLE_USER_HOME` decides which daemon and which cache — a
 * different one from the terminal's means a second daemon and a cold
 * download. The options variables carry memory settings and proxies.
 */
const SHELL_VARS = ['JAVA_HOME', 'GRADLE_USER_HOME', 'GRADLE_OPTS', 'JAVA_OPTS', 'MAVEN_OPTS', 'JAVA_TOOL_OPTIONS'];

let cachedEnv = null;
async function environment() {
  // One lookup, however many callers arrive while it is happening — the same
  // reason `resolvedPath` dedupes: a burst of calls must not become a burst of
  // login shells.
  if (!cachedEnv) {
    cachedEnv = Promise.all([resolvedPath(), resolvedVars(SHELL_VARS)]).then(([PATH, vars]) => ({
      ...process.env,
      ...vars,
      PATH,
    }));
  }
  return cachedEnv;
}

/**
 * `./gradlew` when the project brought one that can run, `gradle` when it
 * brought none, and nothing when it brought one that cannot run.
 *
 * A wrapper that is there but not executable — a checkout from a zip, a
 * repository committed without the mode bit — would fail with `EACCES`, and
 * that error names a syscall, not what to do about it.
 */
function gradleExecutable(root) {
  const wrapper = path.join(root, 'gradlew');
  try {
    fs.accessSync(wrapper, fs.constants.X_OK);
    return wrapper;
  } catch {
    return exists(wrapper) ? null : 'gradle';
  }
}

/** The Gradle clients still running, so quitting the app can stop them. */
const running = new Set();

function runGradle(root, args) {
  const executable = gradleExecutable(root);
  if (!executable) {
    return Promise.resolve({ ok: false, stdout: '', error: 'gradlew is not executable — run `chmod +x gradlew` in the project.' });
  }
  return environment().then(
    (env) =>
      new Promise((resolve) => {
        const child = execFile(
          executable,
          [...args, '--console=plain', '-q'],
          { cwd: root, env, timeout: GRADLE_TIMEOUT, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
          (error, stdout, stderr) => {
            running.delete(child);
            if (!error) return resolve({ ok: true, stdout: String(stdout ?? '') });
            resolve({ ok: false, stdout: String(stdout ?? ''), error: cleanGradleError(stderr, error) });
          },
        );
        running.add(child);
      }),
  );
}

/** Stop every Gradle client this started. The daemons stay; they are Gradle's. */
function stopAll() {
  for (const child of running) {
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
  running.clear();
}

/** The lines a JVM prints on its way in, which are never the answer. */
const JVM_NOISE = /^(Picked up |OpenJDK 64-Bit Server VM warning|WARNING: )/;

function cleanGradleError(stderr, error) {
  const text = String(stderr ?? '').trim();
  const lines = text.split('\n').map((line) => line.trim()).filter((line) => line && !JVM_NOISE.test(line));
  if (error?.code === 'ENOENT') return 'gradle is not installed, or not on the PATH this app can see, and the project has no gradlew.';
  if (error?.code === 'EACCES') return 'gradlew is not executable — run `chmod +x gradlew` in the project.';
  if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'gradle printed more than this panel can read.';
  if (error?.killed) {
    // What it was doing when time ran out is usually the last thing it said —
    // "Downloading https://services.gradle.org/…" on a first run, for one.
    const last = lines[lines.length - 1];
    return `gradle did not answer within ${GRADLE_TIMEOUT / 1000} seconds${last ? ` — last it said: ${last}` : '.'}`;
  }
  // The useful part is the block after "What went wrong:" — its first line
  // and the `> …` lines that say what, specifically.
  const at = lines.findIndex((line) => /What went wrong:/.test(line));
  if (at !== -1) {
    const block = [lines[at + 1]];
    for (let i = at + 2; i < lines.length && lines[i].startsWith('>'); i += 1) block.push(lines[i]);
    return block.filter(Boolean).join(' ');
  }
  return lines[0] || String(error?.message ?? 'gradle failed');
}

/**
 * A signature of the build files, so the task cache knows when to expire.
 *
 * mtimes of every settings and build script in the root and its subprojects,
 * the version catalog, and the folders that hold convention plugins — a
 * folder's mtime moves when a file is added or removed in it, which is when a
 * task appears. Not the whole tree: a source file changing does not change
 * what tasks exist.
 */
function buildSignature(root, projectDirs = []) {
  const files = [
    ...GRADLE_SETTINGS.map((n) => path.join(root, n)),
    ...GRADLE_BUILDS.map((n) => path.join(root, n)),
    ...projectDirs.flatMap((dir) => GRADLE_BUILDS.map((n) => path.join(dir, n))),
    path.join(root, 'gradle.properties'),
    path.join(root, 'gradle', 'libs.versions.toml'),
    path.join(root, 'buildSrc', 'build.gradle.kts'),
    path.join(root, 'buildSrc', 'build.gradle'),
    path.join(root, 'buildSrc', 'src'),
    path.join(root, 'build-logic'),
  ];
  return files
    .map((file) => {
      try {
        return `${file}:${fs.statSync(file).mtimeMs}`;
      } catch {
        return '';
      }
    })
    .filter(Boolean)
    .join('|');
}

/** root -> { signature, promise, settled } */
const taskCache = new Map();

/**
 * The tasks of a Gradle build, from Gradle, remembered until a build file
 * changes.
 *
 * A read already in flight is the answer to everyone who asks while it runs,
 * `force` included: a second Reload during the first thirteen seconds would
 * otherwise be a second JVM doing the same work, and the first one's answer
 * thrown away.
 */
async function gradleTasks(root, { force = false } = {}) {
  if (!root || (!firstExisting(root, GRADLE_SETTINGS) && !firstExisting(root, GRADLE_BUILDS))) {
    return { ok: false, error: `There is no Gradle build at ${root || 'that folder'}.` };
  }
  const layout = gradleLayout(root);
  const signature = buildSignature(root, layout.projects.map((p) => p.dir));
  const held = taskCache.get(root);
  if (held && (!held.settled || (!force && held.signature === signature))) return held.promise;

  const entry = { signature, settled: false, promise: null };
  entry.promise = runGradle(root, ['tasks', '--all']).then((result) => {
    entry.settled = true;
    if (!result.ok) {
      // Only its own entry: a newer read may already be in the table.
      if (taskCache.get(root) === entry) taskCache.delete(root);
      return { ok: false, error: result.error };
    }
    const groups = parseGradleTasks(result.stdout);
    // Every project Gradle named, including the ones settings did not say
    // in a way the parser could read.
    const projects = [...new Set(groups.flatMap((group) => group.tasks.map((task) => task.project)))].sort();
    return { ok: true, groups, projects };
  });
  taskCache.set(root, entry);
  return entry.promise;
}

const CONFIGURATIONS = ['compileClasspath', 'runtimeClasspath', 'testCompileClasspath', 'testRuntimeClasspath'];

/** The reads in flight, so two panels asking the same question share one JVM. */
const dependencyReads = new Map();

/**
 * The resolved dependencies of one project, one configuration.
 *
 * Not cached — it is asked for on purpose, and a resolved tree changes with
 * the network — but deduplicated while in flight: a second daemon is what
 * Gradle starts when the first is busy, and it stays for hours.
 *
 * Always `:dependencies` with the leading colon, the root included. Bare
 * `dependencies` runs in every project of the build, and a root that applies
 * no plugin has no `runtimeClasspath` to report on and fails the lot.
 */
async function gradleDependencies(root, { project = ':', configuration = 'runtimeClasspath' } = {}) {
  const which = CONFIGURATIONS.includes(configuration) ? configuration : 'runtimeClasspath';
  const target = safeProjectPath(project);
  const task = target === ':' ? ':dependencies' : `${target}:dependencies`;
  const key = [root, task, which].join('|');
  if (dependencyReads.has(key)) return dependencyReads.get(key);
  const read = runGradle(root, [task, '--configuration', which])
    .then((result) => {
      if (!result.ok) return { ok: false, error: result.error };
      return { ok: true, ...parseGradleDependencyTree(result.stdout, which) };
    })
    .finally(() => dependencyReads.delete(key));
  dependencyReads.set(key, read);
  return read;
}

/** A Gradle project path: colons and identifiers, and nothing that reads as a flag. */
function safeProjectPath(value) {
  const text = String(value ?? ':').trim() || ':';
  if (!/^:?[A-Za-z0-9_\-.]*(?::[A-Za-z0-9_\-.]+)*$/.test(text)) throw new Error('that is not a project path');
  return text.startsWith(':') ? text : `:${text}`;
}

/* --------------------------------------------------------------------------
 * The door.
 * ------------------------------------------------------------------------ */

/** Which tool, and where its root is, for a folder. */
function root({ dir } = {}) {
  const found = findRoot(dir);
  return found ? { ok: true, ...found } : { ok: true, tool: null, root: null };
}

/**
 * The whole project, read fresh.
 *
 * Read at the root the panel was opened on when that folder is a project
 * root itself, even if a pom has since appeared above it: the panel is about
 * this project, its tab is named after it, and every run it offers is checked
 * against it. A folder that is gone is an error that names the folder, not a
 * silent read of whatever project happens to be above where it was.
 */
async function project({ root: dir } = {}) {
  const at = String(dir ?? '');
  let isDir = false;
  try {
    isDir = fs.statSync(at).isDirectory();
  } catch {
    isDir = false;
  }
  if (!at || !isDir) return { ok: false, error: `The folder ${at || '(none)'} is not there any more.` };
  if (firstExisting(at, GRADLE_SETTINGS) || (firstExisting(at, GRADLE_BUILDS) && !exists(path.join(at, 'pom.xml')))) {
    return readGradleProject(at);
  }
  if (exists(path.join(at, 'pom.xml'))) return readMavenProject(at);
  const where = findRoot(at);
  if (!where) return { ok: false, error: `There is no pom.xml or Gradle build in ${at}, or above it.` };
  if (where.tool === 'maven') return readMavenProject(where.root);
  return readGradleProject(where.root);
}

module.exports = {
  // The door
  root,
  project,
  gradleTasks,
  gradleDependencies,
  stopAll,
  // Pure, tested
  parseXml,
  parsePom,
  parsePluginDescriptor,
  parseGradleSettings,
  parseGradleDependencies,
  parseGradleTasks,
  parseGradleDependencyTree,
  resolveProps,
  prefixOf,
  compareVersions,
  cleanGradleError,
  findRoot,
  readMavenProject,
  readGradleProject,
  localRepository,
  forgetLocalRepository,
  LIFECYCLE,
  KNOWN_GOALS,
};
