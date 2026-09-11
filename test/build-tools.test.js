'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const B = require('../electron/build-tools');

/* --------------------------------------------------------------------------
 * The XML that a pom is.
 * ------------------------------------------------------------------------ */

test('parseXml keeps elements and text, drops comments, CDATA wrappers and namespaces', () => {
  const root = B.parseXml(`<?xml version="1.0"?>
<project xmlns="http://maven.apache.org/POM/4.0.0" xmlns:xsi="x">
  <!-- a comment with <tags> in it -->
  <name><![CDATA[Two & <three>]]></name>
  <empty/>
  <ns:thing>v</ns:thing>
  <amp>a &amp; b &lt; c</amp>
</project>`);
  const project = root.children[0];
  assert.equal(project.name, 'project');
  assert.deepEqual(
    project.children.map((c) => c.name),
    ['name', 'empty', 'thing', 'amp'],
  );
  assert.equal(project.children[0].text, 'Two & <three>');
  assert.equal(project.children[3].text.trim(), 'a &amp; b &lt; c', 'entities are decoded when read, not when parsed');
});

test('a pom being edited still reads: an unclosed element is closed, a stray close tag is ignored', () => {
  const model = B.parsePom(`<project>
  <artifactId>half</artifactId>
  </stray>
  <modules><module>a</module><module>b</module>
</project>`);
  assert.equal(model.artifactId, 'half');
  assert.deepEqual(model.modules, ['a', 'b']);
});

/* --------------------------------------------------------------------------
 * A pom's model.
 * ------------------------------------------------------------------------ */

const POM = `<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.3.2</version>
    <relativePath/>
  </parent>
  <artifactId>shop</artifactId>
  <packaging>war</packaging>
  <name>Shop</name>
  <properties>
    <java.version>21</java.version>
    <lombok.version>1.18.30</lombok.version>
  </properties>
  <modules>
    <module>api</module>
    <module>../shared</module>
  </modules>
  <dependencies>
    <dependency>
      <groupId>org.projectlombok</groupId>
      <artifactId>lombok</artifactId>
      <version>\${lombok.version}</version>
      <scope>provided</scope>
      <optional>true</optional>
    </dependency>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-web</artifactId>
    </dependency>
  </dependencies>
  <build>
    <pluginManagement><plugins><plugin>
      <groupId>org.apache.maven.plugins</groupId><artifactId>maven-compiler-plugin</artifactId><version>3.13.0</version>
    </plugin></plugins></pluginManagement>
    <plugins>
      <plugin>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-maven-plugin</artifactId>
      </plugin>
      <plugin>
        <artifactId>maven-compiler-plugin</artifactId>
      </plugin>
    </plugins>
  </build>
  <profiles>
    <profile><id>dev</id><activation><activeByDefault>true</activeByDefault></activation></profile>
    <profile><id>full</id><modules><module>extras</module></modules></profile>
  </profiles>
</project>`;

test('parsePom reads coordinates, inheriting group and version from the parent', () => {
  const model = B.parsePom(POM);
  assert.equal(model.groupId, 'org.springframework.boot', 'no groupId of its own: the parent’s');
  assert.equal(model.artifactId, 'shop');
  assert.equal(model.version, '3.3.2', 'no version of its own: the parent’s');
  assert.equal(model.packaging, 'war');
  assert.equal(model.name, 'Shop');
  assert.deepEqual(model.parent, {
    groupId: 'org.springframework.boot',
    artifactId: 'spring-boot-starter-parent',
    version: '3.3.2',
    relativePath: '',
  });
});

test('an absent <relativePath> means ../pom.xml, an empty one means none', () => {
  const absent = B.parsePom('<project><parent><artifactId>p</artifactId></parent></project>');
  assert.equal(absent.parent.relativePath, '../pom.xml');
  const empty = B.parsePom('<project><parent><artifactId>p</artifactId><relativePath/></parent></project>');
  assert.equal(empty.parent.relativePath, '');
});

test('parsePom reads modules, dependencies, plugins, management and profiles', () => {
  const model = B.parsePom(POM);
  assert.deepEqual(model.modules, ['api', '../shared']);
  assert.deepEqual(model.properties, { 'java.version': '21', 'lombok.version': '1.18.30' });

  assert.equal(model.dependencies.length, 2);
  assert.deepEqual(model.dependencies[0], {
    groupId: 'org.projectlombok',
    artifactId: 'lombok',
    version: '${lombok.version}',
    scope: 'provided',
    type: 'jar',
    optional: true,
  });
  assert.equal(model.dependencies[1].scope, 'compile', 'the default scope is spelled out');

  assert.deepEqual(
    model.plugins.map((p) => `${p.groupId}:${p.artifactId}`),
    ['org.springframework.boot:spring-boot-maven-plugin', 'org.apache.maven.plugins:maven-compiler-plugin'],
    'a plugin with no groupId is an Apache one',
  );
  assert.equal(model.managedPlugins[0].version, '3.13.0');

  assert.deepEqual(model.profiles, [
    { id: 'dev', activeByDefault: true, modules: [] },
    { id: 'full', activeByDefault: false, modules: ['extras'] },
  ]);
});

test('resolveProps fills ${…} from what is known and leaves what is not', () => {
  const props = { 'a.version': '1.2', nested: '${a.version}-x' };
  assert.equal(B.resolveProps('${a.version}', props), '1.2');
  assert.equal(B.resolveProps('${nested}', props), '1.2-x', 'one level of indirection');
  assert.equal(B.resolveProps('${unknown}', props), '${unknown}', 'not invented');
  assert.equal(B.resolveProps('plain', props), 'plain');
});

test('prefixOf follows Maven’s own naming rule', () => {
  assert.equal(B.prefixOf('maven-compiler-plugin'), 'compiler');
  assert.equal(B.prefixOf('spring-boot-maven-plugin'), 'spring-boot');
  assert.equal(B.prefixOf('jacoco-maven-plugin'), 'jacoco');
  assert.equal(B.prefixOf('something-plugin'), 'something');
});

test('parsePluginDescriptor reads goals and their first sentence, HTML stripped', () => {
  const described = B.parsePluginDescriptor(`<plugin>
  <goalPrefix>compiler</goalPrefix>
  <mojos>
    <mojo><goal>compile</goal><description>Compiles application sources. Also does more things.</description></mojo>
    <mojo><goal>testCompile</goal><description>&lt;p&gt;Compiles &lt;b&gt;test&lt;/b&gt; sources&lt;/p&gt;</description></mojo>
    <mojo><goal>help</goal></mojo>
  </mojos>
</plugin>`);
  assert.equal(described.prefix, 'compiler');
  assert.deepEqual(described.goals, [
    { name: 'compile', description: 'Compiles application sources.' },
    { name: 'testCompile', description: 'Compiles test sources' },
    { name: 'help', description: '' },
  ]);
});

test('compareVersions is numeric where it matters', () => {
  const sorted = ['3.9.0', '3.10.1', '3.8.1', '3.10.0'].sort(B.compareVersions);
  assert.deepEqual(sorted, ['3.8.1', '3.9.0', '3.10.0', '3.10.1']);
});

/* --------------------------------------------------------------------------
 * A whole Maven project, on a disk made for the test.
 * ------------------------------------------------------------------------ */

function scratch(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-tools-'));
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  return dir;
}

/** Goals without touching ~/.m2, so the test does not depend on what this machine has built. */
const noRepository = async (groupId, artifactId) => ({
  prefix: '',
  goals: (B.KNOWN_GOALS[artifactId] ?? []).map((name) => ({ name, description: '' })),
  resolved: false,
});

test('findRoot walks up to the highest pom in an unbroken run, and to settings.gradle', () => {
  const dir = scratch({
    'mono/pom.xml': '<project><artifactId>mono</artifactId><modules><module>svc</module></modules></project>',
    'mono/svc/pom.xml': '<project><artifactId>svc</artifactId></project>',
    'mono/svc/src/main/java/App.java': '',
    'unrelated/pom.xml': '<project><artifactId>other</artifactId></project>',
    'unrelated/nested/deep/pom.xml': '<project><artifactId>deep</artifactId></project>',
    'g/settings.gradle.kts': 'include("app")',
    'g/app/build.gradle.kts': '',
    'g/app/src/Main.kt': '',
    'plain/notes.txt': '',
  });
  assert.deepEqual(B.findRoot(path.join(dir, 'mono/svc/src/main/java')), { tool: 'maven', root: path.join(dir, 'mono') });
  assert.deepEqual(
    B.findRoot(path.join(dir, 'unrelated/nested/deep')),
    { tool: 'maven', root: path.join(dir, 'unrelated/nested/deep') },
    'a pom two folders up with nothing in between is a different project',
  );
  assert.deepEqual(B.findRoot(path.join(dir, 'g/app/src')), { tool: 'gradle', root: path.join(dir, 'g') });
  assert.equal(B.findRoot(path.join(dir, 'plain')), null);
});

test('readMavenProject reads the module tree, resolves managed versions up the parent chain, and lists bound plugins', async () => {
  const dir = scratch({
    'pom.xml': `<project>
      <groupId>com.acme</groupId><artifactId>acme-parent</artifactId><version>2.0.0</version><packaging>pom</packaging>
      <properties><jackson.version>2.17.2</jackson.version></properties>
      <modules><module>core</module><module>web</module></modules>
      <dependencyManagement><dependencies>
        <dependency><groupId>com.fasterxml.jackson.core</groupId><artifactId>jackson-databind</artifactId><version>\${jackson.version}</version></dependency>
      </dependencies></dependencyManagement>
    </project>`,
    'core/pom.xml': `<project>
      <parent><groupId>com.acme</groupId><artifactId>acme-parent</artifactId><version>2.0.0</version></parent>
      <artifactId>core</artifactId>
      <dependencies>
        <dependency><groupId>com.fasterxml.jackson.core</groupId><artifactId>jackson-databind</artifactId></dependency>
        <dependency><groupId>junit</groupId><artifactId>junit</artifactId><version>4.13.2</version><scope>test</scope></dependency>
      </dependencies>
      <build><plugins><plugin><groupId>org.jacoco</groupId><artifactId>jacoco-maven-plugin</artifactId><version>0.8.12</version></plugin></plugins></build>
    </project>`,
    'web/pom.xml': `<project>
      <parent><groupId>com.acme</groupId><artifactId>acme-parent</artifactId><version>2.0.0</version></parent>
      <artifactId>web</artifactId><packaging>war</packaging>
      <dependencies><dependency><groupId>com.acme</groupId><artifactId>core</artifactId><version>\${project.version}</version></dependency></dependencies>
    </project>`,
    mvnw: '#!/bin/sh',
  });

  const read = await B.readMavenProject(dir, { goalsFor: noRepository });
  assert.equal(read.tool, 'maven');
  assert.equal(read.wrapper, true);
  assert.equal(read.lifecycle.map((p) => p.name).join(' '), 'clean validate compile test package verify install site deploy');

  const root = read.project;
  assert.equal(root.artifactId, 'acme-parent');
  assert.equal(root.relative, '.');
  assert.deepEqual(root.modules.map((m) => `${m.relative}=${m.artifactId}@${m.version}/${m.packaging}`), ['core=core@2.0.0/jar', 'web=web@2.0.0/war']);

  const core = root.modules[0];
  const jackson = core.dependencies.find((d) => d.artifactId === 'jackson-databind');
  assert.equal(jackson.version, '2.17.2', 'managed in the parent, through a property the parent defines');
  assert.equal(core.dependencies.find((d) => d.artifactId === 'junit').scope, 'test');

  const web = root.modules[1];
  assert.equal(web.dependencies[0].version, '2.0.0', '${project.version} is the module’s own');

  // A pom packaging binds fewer plugins than a jar; both list clean and compiler.
  const names = (m) => m.plugins.map((p) => p.artifactId);
  assert.ok(names(root).includes('maven-clean-plugin'));
  assert.ok(!names(root).includes('maven-jar-plugin'), 'a pom packaging makes no jar');
  assert.ok(names(core).includes('maven-jar-plugin'));
  assert.ok(names(web).includes('maven-war-plugin'));
  const jacoco = core.plugins.find((p) => p.artifactId === 'jacoco-maven-plugin');
  assert.equal(jacoco.implied, false);
  assert.equal(jacoco.prefix, 'jacoco');
  assert.equal(jacoco.version, '0.8.12');
  assert.ok(jacoco.goals.some((g) => g.name === 'report'), 'from the table when the jar is not on disk');
  assert.equal(core.plugins.find((p) => p.artifactId === 'maven-compiler-plugin').implied, true);
});

test('a module whose pom cannot be read is shown as broken rather than dropped', async () => {
  const dir = scratch({
    'pom.xml': '<project><artifactId>top</artifactId><modules><module>gone</module></modules></project>',
  });
  const read = await B.readMavenProject(dir, { goalsFor: noRepository });
  assert.equal(read.project.modules.length, 1);
  assert.equal(read.project.modules[0].artifactId, 'gone');
  assert.match(read.project.modules[0].error, /ENOENT|no such file/i);
});

/* --------------------------------------------------------------------------
 * Gradle: the settings, the scripts, and what Gradle prints.
 * ------------------------------------------------------------------------ */

test('parseGradleSettings reads both dialects and normalises project paths', () => {
  const kts = B.parseGradleSettings(`
    rootProject.name = "shop"
    include("app", "lib")
    include(":tools:cli")
    includeBuild("../platform")
    // include("commented-out")
  `);
  assert.deepEqual(kts, { name: 'shop', projects: [':app', ':lib', ':tools:cli'] });

  const groovy = B.parseGradleSettings(`
    rootProject.name = 'shop'
    include 'app', 'lib'
    include ':docs'
  `);
  assert.deepEqual(groovy, { name: 'shop', projects: [':app', ':lib', ':docs'] });
});

test('parseGradleDependencies reads the notations a dependencies block can hold', () => {
  const deps = B.parseGradleDependencies(`
    plugins { id("java") }
    dependencies {
        implementation("org.slf4j:slf4j-api:2.0.13")
        implementation 'ch.qos.logback:logback-classic:1.5.6'
        api(project(":core"))
        testImplementation(platform("org.junit:junit-bom:5.10.2"))
        testImplementation group: 'junit', name: 'junit', version: '4.13.2'
        implementation(libs.jackson.databind)
        // implementation("commented:out:1")
        constraints {
            implementation("org.apache.commons:commons-lang3:3.14.0")
        }
    }
  `);
  assert.deepEqual(deps, [
    { configuration: 'implementation', notation: 'org.slf4j:slf4j-api:2.0.13' },
    { configuration: 'implementation', notation: 'ch.qos.logback:logback-classic:1.5.6' },
    { configuration: 'api', notation: 'project :core', project: ':core' },
    { configuration: 'testImplementation', notation: 'org.junit:junit-bom:5.10.2', platform: true },
    { configuration: 'testImplementation', notation: 'junit:junit:4.13.2' },
    { configuration: 'implementation', notation: 'libs.jackson.databind', catalog: true },
    { configuration: 'implementation', notation: 'org.apache.commons:commons-lang3:3.14.0' },
  ]);
  assert.deepEqual(B.parseGradleDependencies('plugins { }'), [], 'no block, no dependencies');
});

test('parseGradleTasks turns `gradle tasks --all` into groups, with the project each task belongs to', () => {
  const groups = B.parseGradleTasks(`
------------------------------------------------------------
Tasks runnable from root project 'shop'
------------------------------------------------------------

Application tasks
-----------------
app:run - Runs this project as a JVM application

Build tasks
-----------
assemble - Assembles the outputs of this project.
app:assemble - Assembles the outputs of this project.
build - Assembles and tests this project.
app:build - Assembles and tests this project.

Other tasks
-----------
app:compileJava - Compiles main Java source.
prepareKotlinBuildScriptModel

Rules
-----
Pattern: clean<TaskName>: Cleans the output files of a task.

To see more detail about a task, run gradle help --task <task>

BUILD SUCCESSFUL in 1s
`);
  assert.deepEqual(groups.map((g) => g.name), ['Application', 'Build', 'Other']);
  assert.deepEqual(groups[0].tasks, [
    { path: ':app:run', name: 'run', project: ':app', description: 'Runs this project as a JVM application' },
  ]);
  assert.deepEqual(
    groups[1].tasks.map((t) => `${t.project} ${t.name}`),
    [': assemble', ':app assemble', ': build', ':app build'],
  );
  assert.equal(groups[2].tasks[1].description, '', 'a task with no description is still a task');
  assert.ok(!groups.some((g) => g.tasks.some((t) => /Pattern|BUILD/.test(t.name))), 'the notes at the end are not tasks');
});

test('parseGradleDependencyTree keeps the tree, the conflicts and the repeats', () => {
  const tree = B.parseGradleDependencyTree(`
> Task :app:dependencies

------------------------------------------------------------
Project ':app'
------------------------------------------------------------

runtimeClasspath - Runtime classpath of source set 'main'.
+--- org.slf4j:slf4j-api:2.0.13
+--- ch.qos.logback:logback-classic:1.5.6
|    +--- ch.qos.logback:logback-core:1.5.6
|    \\--- org.slf4j:slf4j-api:2.0.9 -> 2.0.13
\\--- com.fasterxml.jackson.core:jackson-databind:2.17.2
     +--- com.fasterxml.jackson.core:jackson-annotations:2.17.2 (*)
     \\--- com.fasterxml.jackson.core:jackson-core:2.17.2 (c)

(*) - Indicates repeated occurrences of a transitive dependency subtree.
`, 'runtimeClasspath');
  assert.equal(tree.resolved, true);
  assert.deepEqual(tree.nodes.map((n) => n.notation), [
    'org.slf4j:slf4j-api:2.0.13',
    'ch.qos.logback:logback-classic:1.5.6',
    'com.fasterxml.jackson.core:jackson-databind:2.17.2',
  ]);
  const logback = tree.nodes[1];
  assert.equal(logback.children.length, 2);
  assert.equal(logback.children[1].notation, 'org.slf4j:slf4j-api:2.0.9');
  assert.equal(logback.children[1].resolvedTo, '2.0.13', 'a conflict shows what it became');
  const jackson = tree.nodes[2];
  assert.equal(jackson.children[0].seen, true);
  assert.equal(jackson.children[1].constraint, true);

  const missing = B.parseGradleDependencyTree('nothing here', 'runtimeClasspath');
  assert.deepEqual(missing, { configuration: 'runtimeClasspath', resolved: false, nodes: [] });
});

test('readGradleProject reads the projects and the declared dependencies of each', () => {
  const dir = scratch({
    'settings.gradle.kts': 'rootProject.name = "shop"\ninclude("app")\ninclude("lib")',
    'build.gradle.kts': 'plugins { id("base") }',
    'app/build.gradle.kts': 'dependencies {\n  implementation(project(":lib"))\n  implementation("org.slf4j:slf4j-api:2.0.13")\n}',
    'lib/build.gradle': 'dependencies {\n  api "com.google.guava:guava:33.0.0-jre"\n}',
    gradlew: '#!/bin/sh',
  });
  const read = B.readGradleProject(dir);
  assert.equal(read.tool, 'gradle');
  assert.equal(read.wrapper, true);
  assert.equal(read.kotlin, true);
  assert.equal(read.tasks, null, 'not known until Gradle is asked');
  assert.equal(read.project.name, 'shop');
  assert.equal(read.project.path, ':');
  assert.deepEqual(read.project.subprojects.map((p) => `${p.path} ${p.relative}`), [':app app', ':lib lib']);
  assert.deepEqual(read.project.subprojects[0].dependencies.map((d) => d.notation), ['project :lib', 'org.slf4j:slf4j-api:2.0.13']);
  assert.equal(read.project.subprojects[1].dependencies[0].configuration, 'api');
});
