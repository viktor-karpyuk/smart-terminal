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
const { resolvedPath } = require('./cli-env');

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

    const close = text.indexOf('>', open);
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

function localName(tag) {
  const cut = tag.indexOf(':');
  return cut === -1 ? tag : tag.slice(cut + 1);
}

/** Decode the five entities XML has, and the numeric ones. */
function decode(text) {
  return String(text ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
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
const DEFAULT_PLUGINS = {
  common: ['maven-clean-plugin', 'maven-resources-plugin', 'maven-compiler-plugin', 'maven-surefire-plugin',
    'maven-install-plugin', 'maven-deploy-plugin', 'maven-site-plugin'],
  jar: ['maven-jar-plugin'],
  war: ['maven-war-plugin'],
  ear: ['maven-ear-plugin'],
  ejb: ['maven-ejb-plugin'],
  'maven-plugin': ['maven-plugin-plugin', 'maven-jar-plugin'],
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
    text = text.replace(/\$\{([^}]+)\}/g, (whole, key) => (key in props ? props[key] : whole));
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

  const properties = {};
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
  const props = {};
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

/** Read a pom, or say that it could not be. */
function readPom(file) {
  try {
    return { model: parsePom(fs.readFileSync(file, 'utf8')), error: null };
  } catch (error) {
    return { model: null, error: String(error?.message ?? error) };
  }
}

/**
 * The parents of a pom that are on this disk, nearest first.
 *
 * Followed by `relativePath`, which is what Maven itself does before it goes to
 * a repository. Bounded, because two poms that name each other as parents
 * would otherwise be read for ever.
 */
function parentChain(model, dir, seen = new Set()) {
  const chain = [model];
  let current = model;
  let at = dir;
  while (current?.parent && chain.length < 12) {
    const rel = current.parent.relativePath;
    let file = rel ? path.resolve(at, rel) : null;
    try {
      if (file && fs.statSync(file).isDirectory()) file = path.join(file, 'pom.xml');
    } catch {
      file = null;
    }
    /*
     * Not beside the project: a parent that lives in a repository — the Spring
     * Boot starter parent, for nearly everyone — is looked for in the local one,
     * where the first build put it. That parent's parent is where a thousand
     * dependency versions are managed, and reading it is the difference
     * between a Dependencies node with versions and one without.
     */
    if (!file || !exists(file)) file = pomInRepository(current.parent);
    if (!file) break;
    if (seen.has(file)) break;
    seen.add(file);
    const { model: parent } = readPom(file);
    if (!parent) break;
    // Only a parent that is the parent: a relativePath that lands on some
    // other pom is ignored, the way Maven ignores it.
    if (parent.artifactId !== current.parent.artifactId) break;
    chain.push(parent);
    current = parent;
    at = path.dirname(file);
  }
  return chain;
}

/** Where the local repository keeps a pom, if it has it. */
function pomInRepository({ groupId, artifactId, version } = {}) {
  if (!groupId || !artifactId || !version || version.includes('${')) return null;
  const file = path.join(localRepository(), ...String(groupId).split('.'), artifactId, version, `${artifactId}-${version}.pom`);
  return exists(file) ? file : null;
}

/**
 * A module and everything under it.
 *
 * Recursive over `<modules>`, each entry a folder (or a pom file) relative to
 * this one. Profile modules are read too, marked with the profile that brings
 * them in, because a module that only exists under `-Pfull` is still a module
 * somebody will want to build.
 */
async function readModule(dir, root, seen, goalsFor) {
  const file = path.join(dir, 'pom.xml');
  const relative = path.relative(root, dir) || '.';
  if (seen.has(file)) return null;
  seen.add(file);

  const { model, error } = readPom(file);
  if (!model) {
    return { dir, relative, artifactId: path.basename(dir), error: error ?? 'no <project> in it', modules: [] };
  }

  const chain = parentChain(model, dir);
  const props = propertiesOf(chain);
  const resolve = (value) => resolveProps(value, props);

  const declared = new Map();
  for (const plugin of model.plugins) declared.set(`${plugin.groupId}:${plugin.artifactId}`, plugin);
  // The plugins the packaging binds by itself, listed after the declared ones.
  const bound = [...DEFAULT_PLUGINS.common, ...(DEFAULT_PLUGINS[model.packaging] ?? [])];
  for (const artifactId of bound) {
    const key = `org.apache.maven.plugins:${artifactId}`;
    if (!declared.has(key)) declared.set(key, { groupId: 'org.apache.maven.plugins', artifactId, version: '', implied: true });
  }

  const plugins = [];
  for (const plugin of declared.values()) {
    const version = resolve(plugin.version || managedVersion(plugin, 'plugin', chain));
    const described = await goalsFor(plugin.groupId, plugin.artifactId, version);
    plugins.push({
      groupId: plugin.groupId,
      artifactId: plugin.artifactId,
      version,
      implied: Boolean(plugin.implied),
      prefix: described.prefix || prefixOf(plugin.artifactId),
      goals: described.goals,
      // Whether the goals came from the plugin itself or from the table.
      resolved: described.resolved,
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
    const sub = await readModule(target, root, seen, goalsFor);
    if (sub) modules.push({ ...sub, profile: entry.profile });
  }

  return {
    dir,
    relative,
    file,
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

function localRepository() {
  return process.env.MAVEN_REPO_LOCAL || path.join(os.homedir(), '.m2', 'repository');
}

/** The newest version folder of an artifact in the local repository. */
function newestOnDisk(artifactDir) {
  let entries = [];
  try {
    entries = fs.readdirSync(artifactDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const versions = entries.filter((e) => e.isDirectory() && /^\d/.test(e.name)).map((e) => e.name);
  versions.sort(compareVersions);
  return versions.pop() ?? null;
}

/** Numeric-aware, so 3.10.1 sorts after 3.9.0 and "-SNAPSHOT" after the release... near enough. */
function compareVersions(a, b) {
  const parts = (v) => String(v).split(/[.\-]/).map((p) => (/^\d+$/.test(p) ? Number(p) : p));
  const left = parts(a);
  const right = parts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const l = left[i];
    const r = right[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (l === r) continue;
    if (typeof l === 'number' && typeof r === 'number') return l - r;
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
  return new Promise((resolve) => {
    execFile('unzip', ['-p', jar, member], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      resolve(error ? null : stdout);
    });
  });
}

async function goalsFromRepository(groupId, artifactId, version) {
  const artifactDir = path.join(localRepository(), ...String(groupId).split('.'), artifactId);
  const chosen = version && !version.includes('${') ? version : newestOnDisk(artifactDir);
  if (!chosen) return null;
  const jar = path.join(artifactDir, chosen, `${artifactId}-${chosen}.jar`);
  if (!exists(jar)) return null;
  if (goalCache.has(jar)) return goalCache.get(jar);
  const promise = unzipMember(jar, 'META-INF/maven/plugin.xml').then((xml) => (xml ? parsePluginDescriptor(xml) : null));
  goalCache.set(jar, promise);
  const described = await promise;
  if (!described) goalCache.delete(jar);
  return described;
}

/** The goals of a plugin, from the jar when it is there and the table when it is not. */
async function describePlugin(groupId, artifactId, version) {
  const found = await goalsFromRepository(groupId, artifactId, version).catch(() => null);
  if (found?.goals?.length) return { ...found, resolved: true };
  const known = KNOWN_GOALS[artifactId] ?? [];
  return { prefix: '', goals: known.map((name) => ({ name, description: '' })), resolved: false };
}

/** The whole Maven project under a root. */
async function readMavenProject(root, { goalsFor = describePlugin } = {}) {
  const project = await readModule(root, root, new Set(), goalsFor);
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
 * and `rootProject.name = "x"`. A settings file is a program too, and one that
 * builds its include list in a loop is beyond this — but that one is rare, and
 * `gradle tasks --all` names every project anyway, so the tree fills in when
 * the tasks arrive.
 */
function parseGradleSettings(source) {
  const text = String(source ?? '').replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const name = /rootProject\.name\s*=\s*["']([^"']+)["']/.exec(text)?.[1] ?? '';
  const projects = new Set();
  const includes = /\binclude(?:Build)?\s*\(?\s*([^\n)]+)\)?/g;
  let match;
  while ((match = includes.exec(text))) {
    if (match[0].startsWith('includeBuild')) continue;
    for (const quoted of match[1].matchAll(/["']([^"']+)["']/g)) {
      const id = quoted[1].trim();
      if (id) projects.add(id.startsWith(':') ? id : `:${id}`);
    }
  }
  return { name, projects: [...projects] };
}

/**
 * The dependencies a build script declares. Pure, and static, and it says so.
 *
 * `implementation("g:a:v")`, `testImplementation 'g:a:v'`, `api(project(":x"))`,
 * and the `group:`/`name:`/`version:` map form. A version catalog reference
 * (`libs.foo`) is kept as written: what it resolves to lives in a TOML file
 * and, honestly, only Gradle knows. The resolved tree is a click away.
 */
function parseGradleDependencies(source) {
  const text = String(source ?? '').replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const block = /dependencies\s*\{/.exec(text);
  if (!block) return [];
  // The matching brace, counting nesting: closures inside the block are common.
  let depth = 0;
  let end = text.length;
  for (let i = block.index + block[0].length - 1; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = text.slice(block.index + block[0].length, end);
  const out = [];
  const line = /^\s*([A-Za-z][A-Za-z0-9]*)\s*\(?\s*(.+?)\s*\)?\s*(?:\{[\s\S]*?\})?\s*$/;
  for (const raw of body.split('\n')) {
    const match = line.exec(raw);
    if (!match) continue;
    const configuration = match[1];
    if (['constraints', 'components', 'modules', 'if', 'for', 'while'].includes(configuration)) continue;
    const rest = match[2];
    const project = /project\s*\(\s*(?:path\s*[:=]\s*)?["']([^"']+)["']/.exec(rest);
    if (project) {
      out.push({ configuration, notation: `project ${project[1]}`, project: project[1] });
      continue;
    }
    const quoted = /^["']([^"']+)["']/.exec(rest);
    if (quoted) {
      out.push({ configuration, notation: quoted[1] });
      continue;
    }
    const map = /group\s*[:=]\s*["']([^"']+)["'].*?name\s*[:=]\s*["']([^"']+)["'](?:.*?version\s*[:=]\s*["']([^"']+)["'])?/.exec(rest);
    if (map) {
      out.push({ configuration, notation: [map[1], map[2], map[3]].filter(Boolean).join(':') });
      continue;
    }
    const catalog = /^(libs(?:\.[A-Za-z0-9_]+)+)/.exec(rest);
    if (catalog) out.push({ configuration, notation: catalog[1], catalog: true });
    const platform = /(?:platform|enforcedPlatform)\s*\(\s*["']([^"']+)["']/.exec(rest);
    if (platform) out.push({ configuration, notation: platform[1], platform: true });
  }
  return out;
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
    // "Rules", "Pattern:", "To see all tasks..." — the notes at the end.
    if (/^(Rules|Pattern:|To see|BUILD |Deprecated|\d+ actionable)/.test(line.trim())) {
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
 * Gradle draws it with `+---` and `\---` and `|    ` indents, four columns per
 * level. Each line is a notation, optionally with ` -> version` when a conflict
 * was resolved, ` (*)` when it was already shown above, and ` (c)` for a
 * constraint. The tree is kept as a tree because that is what it is: flattening
 * it hides exactly the question — "who pulled this in" — that anybody opening
 * it is asking.
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
    const seen = / \(\*\)$/.test(text);
    const constraint = / \(c\)$/.test(text);
    const notResolved = / \(n\)$/.test(text);
    text = text.replace(/ \((\*|c|n)\)$/, '');
    let resolvedTo = null;
    const arrow = / -> (\S+)$/.exec(text);
    if (arrow) {
      resolvedTo = arrow[1];
      text = text.slice(0, arrow.index);
    }
    const node = { notation: text, resolvedTo, seen, constraint, notResolved, children: [] };
    while (stack.length > 1 && stack[stack.length - 1].depth >= depth) stack.pop();
    stack[stack.length - 1].children.push(node);
    stack.push({ depth, children: node.children });
  }
  return { configuration, resolved: true, nodes: roots };
}

/**
 * The static half of a Gradle project: what settings and the build scripts say.
 *
 * Fast, and honest about being partial: `tasks` is null until they have been
 * asked for, because asking means running Gradle.
 */
function readGradleProject(root) {
  const settingsFile = firstExisting(root, GRADLE_SETTINGS);
  const settings = settingsFile ? parseGradleSettings(safeRead(settingsFile)) : { name: '', projects: [] };
  const buildFile = firstExisting(root, GRADLE_BUILDS);

  const projectOf = (id, dir) => ({
    path: id,
    name: id === ':' ? settings.name || path.basename(root) : id.slice(id.lastIndexOf(':') + 1),
    dir,
    relative: path.relative(root, dir) || '.',
    file: firstExisting(dir, GRADLE_BUILDS),
    dependencies: parseGradleDependencies(safeRead(firstExisting(dir, GRADLE_BUILDS))),
  });

  const subprojects = settings.projects.map((id) => projectOf(id, path.join(root, ...id.slice(1).split(':'))));
  return {
    ok: true,
    tool: 'gradle',
    root,
    wrapper: exists(path.join(root, 'gradlew')),
    kotlin: Boolean(buildFile?.endsWith('.kts') || settingsFile?.endsWith('.kts')),
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

let cachedEnv = null;
async function environment() {
  if (!cachedEnv) cachedEnv = resolvedPath().then((PATH) => ({ ...process.env, PATH }));
  return cachedEnv;
}

/** `./gradlew` when the project brought one, `gradle` when it did not. */
function gradleExecutable(root) {
  const wrapper = path.join(root, 'gradlew');
  return exists(wrapper) ? wrapper : 'gradle';
}

function runGradle(root, args) {
  return environment().then(
    (env) =>
      new Promise((resolve) => {
        execFile(
          gradleExecutable(root),
          [...args, '--console=plain', '-q'],
          { cwd: root, env, timeout: GRADLE_TIMEOUT, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
          (error, stdout, stderr) => {
            if (!error) return resolve({ ok: true, stdout: String(stdout ?? '') });
            resolve({ ok: false, stdout: String(stdout ?? ''), error: cleanGradleError(stderr, error) });
          },
        );
      }),
  );
}

function cleanGradleError(stderr, error) {
  if (error?.code === 'ENOENT') return 'gradle is not installed, or not on the PATH this app can see, and the project has no gradlew.';
  if (error?.killed) return `gradle did not answer within ${GRADLE_TIMEOUT / 1000} seconds.`;
  const text = String(stderr ?? '').trim();
  // The useful line is the one after "What went wrong:", when there is one.
  const wrong = /What went wrong:\s*\n([^\n]+)/.exec(text);
  if (wrong) return wrong[1].trim();
  return text.split('\n').find((line) => line.trim()) || String(error?.message ?? 'gradle failed');
}

/**
 * A signature of the build files, so the task cache knows when to expire.
 *
 * mtimes of every settings and build script in the root and its subprojects.
 * Not the whole tree: a build file is what changes what tasks exist, and a
 * source file changing does not.
 */
function buildSignature(root, projects = []) {
  const files = [
    ...GRADLE_SETTINGS.map((n) => path.join(root, n)),
    ...GRADLE_BUILDS.map((n) => path.join(root, n)),
    ...projects.flatMap((p) => GRADLE_BUILDS.map((n) => path.join(p.dir, n))),
    path.join(root, 'gradle', 'libs.versions.toml'),
    path.join(root, 'buildSrc', 'build.gradle.kts'),
    path.join(root, 'buildSrc', 'build.gradle'),
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

const taskCache = new Map();

/** The tasks of a Gradle build, from Gradle, remembered until a build file changes. */
async function gradleTasks(root, { force = false } = {}) {
  const project = readGradleProject(root);
  const signature = buildSignature(root, project.project.subprojects);
  const held = taskCache.get(root);
  if (!force && held && held.signature === signature) return held.promise;

  const promise = runGradle(root, ['tasks', '--all']).then((result) => {
    if (!result.ok) {
      taskCache.delete(root);
      return { ok: false, error: result.error };
    }
    return { ok: true, groups: parseGradleTasks(result.stdout) };
  });
  taskCache.set(root, { signature, promise });
  return promise;
}

const CONFIGURATIONS = ['compileClasspath', 'runtimeClasspath', 'testCompileClasspath', 'testRuntimeClasspath'];

/** The resolved dependencies of one project, one configuration. Not cached: it is asked for on purpose. */
async function gradleDependencies(root, { project = ':', configuration = 'runtimeClasspath' } = {}) {
  const which = CONFIGURATIONS.includes(configuration) ? configuration : 'runtimeClasspath';
  const target = safeProjectPath(project);
  const task = target === ':' ? 'dependencies' : `${target}:dependencies`;
  const result = await runGradle(root, [task, '--configuration', which]);
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, ...parseGradleDependencyTree(result.stdout, which) };
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

/** The whole project, read fresh. */
async function project({ root: dir } = {}) {
  const where = findRoot(dir);
  if (!where) return { ok: false, error: 'There is no pom.xml or Gradle build here, or above here.' };
  if (where.tool === 'maven') return readMavenProject(where.root);
  return readGradleProject(where.root);
}

module.exports = {
  // The door
  root,
  project,
  gradleTasks,
  gradleDependencies,
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
  findRoot,
  readMavenProject,
  readGradleProject,
  LIFECYCLE,
  KNOWN_GOALS,
};
