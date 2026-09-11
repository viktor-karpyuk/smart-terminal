'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const spring = require('../electron/spring');

/*
 * A pom, read without a parser. The things that go wrong are the things a
 * parser would have got right for free: a commented-out module, a parent's
 * artifactId taken for the module's own, a plugin mentioned in a comment.
 */
test('a pom says what it is, and its parent is not mistaken for it', () => {
  const pom = `
    <project>
      <parent>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-parent</artifactId>
        <version>3.3.2</version>
      </parent>
      <artifactId>krello-be</artifactId>
      <properties><java.version>17</java.version></properties>
      <dependencies>
        <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency>
      </dependencies>
      <!-- <module>not-really</module> -->
      <build><plugins><plugin>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-maven-plugin</artifactId>
      </plugin></plugins></build>
    </project>`;
  const read = spring.readPom(pom);
  assert.equal(read.artifactId, 'krello-be');
  assert.equal(read.groupId, 'org.springframework.boot');
  assert.equal(read.version, '3.3.2');
  assert.equal(read.packaging, 'jar');
  assert.equal(read.javaVersion, '17');
  assert.equal(read.bootPlugin, true);
  assert.equal(read.bootParent, true);
  assert.equal(read.actuator, false);
  assert.deepEqual(read.modules, []);
});

test('an aggregator pom lists its modules, including the ones reached by ../', () => {
  const read = spring.readPom(`
    <project>
      <artifactId>ks-erp-parent</artifactId>
      <packaging>pom</packaging>
      <properties><maven.compiler.release>1.8</maven.compiler.release></properties>
      <modules>
        <module>../ks-erp-common</module>
        <module>../ks-erp-app</module>
      </modules>
    </project>`);
  assert.equal(read.packaging, 'pom');
  assert.equal(read.javaVersion, '8');
  assert.deepEqual(read.modules, ['../ks-erp-common', '../ks-erp-app']);
  assert.equal(read.bootPlugin, false);
});

test('a gradle build says whether it is boot, and which java', () => {
  const kts = `
    plugins {
      id("org.springframework.boot") version "3.3.0"
      kotlin("jvm")
    }
    java { toolchain { languageVersion.set(JavaLanguageVersion.of(21)) } }
    dependencies { implementation("org.springframework.boot:spring-boot-starter-actuator") }
    springBoot { mainClass.set("com.acme.AppKt") }`;
  const read = spring.readGradle(kts);
  assert.equal(read.bootPlugin, true);
  assert.equal(read.javaVersion, '21');
  assert.equal(read.actuator, true);
  assert.equal(read.mainClass, 'com.acme.AppKt');

  const groovy = `
    apply plugin: 'org.springframework.boot'
    sourceCompatibility = '17'`;
  assert.equal(spring.readGradle(groovy).bootPlugin, true);
  assert.equal(spring.readGradle(groovy).javaVersion, '17');

  assert.deepEqual(spring.readGradleSettings(`rootProject.name = 'x'\ninclude 'api', 'core'\ninclude(":web:admin")`), [':api', ':core', ':web:admin']);
});

test('the main class is the package plus the file, and a Kotlin main file gets Kt', () => {
  assert.equal(spring.classNameOf('package com.ks.erp;\n\n@SpringBootApplication\npublic class KsErpApp {}', 'KsErpApp.java'), 'com.ks.erp.KsErpApp');
  assert.equal(spring.classNameOf('package com.acme\n\n@SpringBootApplication\nclass App\n\nfun main(args: Array<String>) {}', 'App.kt'), 'com.acme.App');
  assert.equal(spring.classNameOf('package com.acme\n\nfun main(args: Array<String>) { runApplication<App>() }', 'Main.kt'), 'com.acme.MainKt');
  assert.equal(spring.classNameOf('public class Bare {}', 'Bare.java'), 'Bare');
});

/*
 * application.yml, read for six keys. The traps: a value with a placeholder
 * and a default, a comment after a value, a quoted value, a nested map two
 * levels down, and a second YAML document that is a profile and not the base.
 */
test('an application.yml gives up its port, profiles and paths', () => {
  const yml = `
# the app
spring:
  application:
    name: ks-erp   # the name
  profiles:
    active: "local"
server:
  port: \${SERVER_PORT:8222}
  servlet:
    context-path: /api
management:
  server:
    port: 9090
  endpoints:
    web:
      base-path: /manage
      exposure:
        include:
          - health
          - info
---
spring:
  config:
    activate:
      on-profile: prod
server:
  port: 80
`;
  const flat = spring.flattenYaml(yml);
  assert.equal(flat['server.port'], '8222');
  assert.equal(flat['spring.application.name'], 'ks-erp');
  assert.equal(flat['spring.profiles.active'], 'local');
  assert.equal(flat['management.endpoints.web.base-path'], '/manage');
  const read = spring.readConfig(flat);
  assert.deepEqual(read, {
    port: 8222,
    managementPort: 9090,
    contextPath: '/api',
    managementBasePath: '/manage',
    activeProfiles: 'local',
    applicationName: 'ks-erp',
  });
});

test('a file that starts with --- is read from its first real document, and profile documents are skipped', () => {
  const flat = spring.flattenYaml('---\nserver:\n  port: 8081\n---\nspring:\n  config:\n    activate:\n      on-profile: prod\nserver:\n  port: 80\n');
  assert.equal(flat['server.port'], '8081');
  const profileFirst = spring.flattenYaml('spring:\n  config:\n    activate:\n      on-profile: dev\nserver:\n  port: 1\n--- # base\nserver:\n  port: 2\n');
  assert.equal(profileFirst['server.port'], '2');
  assert.deepEqual(spring.flattenYaml('# only a comment\n---\n'), {});
  assert.equal(spring.flattenYaml('script: |-\n  server:\n    port: 99\nreal:\n  port: 1\n')['real.port'], '1');
  assert.equal(spring.unplaceholder('${PORT:${SERVER_PORT:8080}}'), '8080');
  assert.equal(spring.unplaceholder('${A:}'), '');
  assert.equal(spring.unplaceholder('x-${A:y}-z'), 'x-y-z');
});

test('a profile in the pom does not shadow the modules, properties or main class in force', () => {
  const pom = spring.readPom(`
    <project>
      <artifactId>a</artifactId>
      <profiles><profile><id>extra</id>
        <modules><module>extra</module></modules>
        <properties><java.version>11</java.version></properties>
      </profile></profiles>
      <modules><module>core</module><module>app</module></modules>
      <properties><java.version>21</java.version></properties>
      <build><plugins>
        <plugin><artifactId>exec-maven-plugin</artifactId><configuration><mainClass>com.tool.Cli</mainClass></configuration></plugin>
        <plugin><artifactId>spring-boot-maven-plugin</artifactId><configuration><mainClass>com.app.App</mainClass></configuration></plugin>
      </plugins></build>
    </project>`);
  assert.deepEqual(pom.modules, ['core', 'app']);
  assert.equal(pom.javaVersion, '21');
  assert.equal(pom.mainClass, 'com.app.App');
  const other = spring.readPom('<project><artifactId>b</artifactId><build><plugins><plugin><artifactId>exec-maven-plugin</artifactId><configuration><mainClass>com.tool.Cli</mainClass></configuration></plugin></plugins></build></project>');
  assert.equal(other.mainClass, '', 'another plugin’s main class is not Boot’s');
});

test('gradle with a version catalog, a jvmToolchain and the old mainClassName is still read', () => {
  const read = spring.readGradle('plugins { alias(libs.plugins.spring.boot) }\nkotlin { jvmToolchain(21) }\ndependencies { implementation(libs.spring.boot.starter.web) }\nmainClassName = "com.a.B"');
  assert.equal(read.bootPlugin, true);
  assert.equal(read.boot, true);
  assert.equal(read.javaVersion, '21');
  assert.equal(read.mainClass, 'com.a.B');
});

test('a .properties file is read the same way, and a placeholder with no default is nothing', () => {
  const flat = spring.flattenProperties('server.port=3000\n# a comment\nspring.application.name=krello\nserver.servlet.context-path=${CTX}\n');
  assert.equal(spring.readConfig(flat).port, 3000);
  assert.equal(spring.readConfig(flat).applicationName, 'krello');
  assert.equal(spring.readConfig(flat).contextPath, '');
  assert.equal(spring.profileOf('application-local.yml'), 'local');
  assert.equal(spring.profileOf('application.yml'), null);
  assert.equal(spring.profileOf('bootstrap-k8s.properties'), 'k8s');
  assert.equal(spring.profileOf('application-local.yml.bak'), null);
});

test('a module is read from its folder: profiles from the file names, port from the base file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spring-'));
  const resources = path.join(dir, 'src', 'main', 'resources');
  fs.mkdirSync(resources, { recursive: true });
  fs.writeFileSync(path.join(resources, 'application.yml'), 'server:\n  port: 8222\n');
  fs.writeFileSync(path.join(resources, 'application-local.yml'), 'spring:\n  datasource:\n    url: x\n');
  fs.writeFileSync(path.join(resources, 'application-k8s.yml'), 'server:\n  port: 8080\n');
  const read = await spring.readModuleConfig(dir);
  assert.equal(read.port, 8222);
  assert.deepEqual(read.profiles, ['k8s', 'local']);
  assert.equal(read.byProfile.k8s.port, 8080);
  assert.equal(read.byProfile.local.port, undefined);
});

/*
 * The whole discovery, against a folder that looks like the hard case: a root
 * pom that aggregates a configs module, whose pom aggregates the siblings as
 * ../x — so the reactor of the app is the root, found through the lists and
 * not through the folders. And a library beside it that must not be offered.
 */
test('applications are found through the aggregation chain, and libraries are left out', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spring-tree-'));
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  write('be/pom.xml', '<project><artifactId>be</artifactId><packaging>pom</packaging><modules><module>configs</module></modules></project>');
  write('be/mise.toml', '[tools]\njava = "25"\n');
  write('be/configs/pom.xml', '<project><artifactId>parent</artifactId><packaging>pom</packaging><modules><module>../common</module><module>../app</module></modules></project>');
  write('be/common/pom.xml', '<project><artifactId>common</artifactId><dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter</artifactId></dependency></dependencies></project>');
  write('be/app/pom.xml', '<project><artifactId>app</artifactId><dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies><build><plugins><plugin><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build></project>');
  write('be/app/src/main/java/com/acme/App.java', 'package com.acme;\n@SpringBootApplication\npublic class App {}\n');
  write('be/app/src/main/resources/application.yml', 'server:\n  port: 8222\n');
  // A single-module project beside it, with a wrapper.
  write('solo/pom.xml', '<project><artifactId>solo</artifactId><properties><java.version>17</java.version></properties><build><plugins><plugin><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build></project>');
  write('solo/mvnw', '#!/bin/sh\n');
  // Noise: a node project, and a target folder full of poms.
  write('web/node_modules/x/pom.xml', '<project><artifactId>never</artifactId><build><plugins><plugin><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build></project>');
  write('be/app/target/classes/pom.xml', '<project><artifactId>never2</artifactId><build><plugins><plugin><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build></project>');

  const found = await spring.projects(root);
  const names = found.apps.map((app) => app.artifactId).sort();
  assert.deepEqual(names, ['app', 'solo']);

  const app = found.apps.find((candidate) => candidate.artifactId === 'app');
  assert.equal(app.reactor, path.join(root, 'be'));
  assert.equal(app.module, ':app');
  assert.equal(app.modulePath, 'app');
  assert.equal(app.mainClass, 'com.acme.App');
  assert.equal(app.javaVersion, '25', 'read from the mise.toml at the reactor');
  assert.equal(app.port, 8222);
  assert.equal(app.wrapper, false);

  const solo = found.apps.find((candidate) => candidate.artifactId === 'solo');
  assert.equal(solo.reactor, solo.dir);
  assert.equal(solo.module, '');
  assert.equal(solo.wrapper, true);
  assert.equal(solo.javaVersion, '17');
});

/*
 * JDKs. The list macOS prints, a `release` file, and the choice between them:
 * exactly what was asked for, else the nearest newer, never an older one.
 */
test('the JDK list is read from java_home, and the right one chosen', () => {
  const listed = spring.parseJavaHomeList(`Matching Java Virtual Machines (3):
    25.0.1 (arm64) "Amazon.com Inc." - "Amazon Corretto 25" /Users/x/Library/Java/JavaVirtualMachines/corretto-25.0.1/Contents/Home
    21.0.10 (arm64) "Eclipse Adoptium" - "OpenJDK 21.0.10" /Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home
    11.0.31 (arm64) "Amazon.com Inc." - "Amazon Corretto 11" /Users/x/Library/Java/JavaVirtualMachines/corretto-11.0.31/Contents/Home
/Users/x/Library/Java/JavaVirtualMachines/corretto-25.0.1/Contents/Home`);
  assert.equal(listed.length, 3);
  assert.equal(listed[1].major, '21');
  assert.equal(listed[1].vendor, 'Eclipse Adoptium');
  assert.equal(listed[1].home, '/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home');

  assert.equal(spring.chooseJdk(listed, '21').major, '21');
  assert.equal(spring.chooseJdk(listed, '17').major, '21', 'nothing at 17: the nearest newer');
  assert.equal(spring.chooseJdk(listed, '8').major, '11');
  assert.equal(spring.chooseJdk(listed, '26'), null, 'nothing new enough: the java on PATH');
  assert.equal(spring.chooseJdk(listed, ''), null, 'nothing asked for: the java on PATH');
  assert.equal(spring.chooseJdk([], '17'), null);

  assert.deepEqual(spring.parseReleaseFile('IMPLEMENTOR="Amazon.com Inc."\nJAVA_VERSION="17.0.12"\n'), { version: '17.0.12', vendor: 'Amazon.com Inc.' });
  assert.equal(spring.majorOf('1.8'), '8');
  assert.equal(spring.majorOf('17.0.12'), '17');
  assert.equal(spring.majorOf('temurin-21.0.1'), '21');
  assert.equal(spring.majorOf('25'), '25');
  assert.equal(spring.majorOf(''), '');
  assert.equal(spring.majorOf('openjdk64-17.0.2'), '17', 'a jenv name');
  assert.equal(spring.majorOf('graalvm-ce-java17-22.3.0'), '17');
  assert.equal(spring.majorOf('zulu21.32'), '21');
  assert.equal(spring.majorOf('1.8.0_392'), '8');
  assert.equal(spring.majorOf('8u392'), '8');
  assert.equal(spring.majorOf('21-ea'), '21');
  // Among two patches of the nearest newer major, the newest patch — the same rule an exact match uses.
  const patches = [{ major: '21', version: '21.0.1' }, { major: '21', version: '21.0.10' }, { major: '17', version: '17.0.9' }];
  assert.equal(spring.chooseJdk(patches, '19').version, '21.0.10');
  assert.equal(spring.chooseJdk(patches, '21').version, '21.0.10');
});

/*
 * The argv. Every field of the configuration ends up as its own argument or
 * as environment, and never inside a shell. The multi-module project gets an
 * install first; the single one does not need it.
 */
const APP = {
  name: 'ks-erp',
  dir: '/w/be/app',
  reactor: '/w/be',
  module: ':app',
  tool: 'maven',
  wrapper: false,
  port: 8222,
};

test('a multi-module maven app is installed and then run, with the profile and options as arguments', () => {
  const planned = spring.plan(APP, { profiles: 'local, dev', jvmArgs: '-Xmx2g -Dfoo="a b"', args: '--x=1', port: 8223 }, { jdk: { home: '/jdk/17' } });
  assert.equal(planned.steps.length, 2);
  assert.deepEqual(planned.steps[0], {
    label: 'mvn install -pl :app -am',
    cmd: 'mvn',
    args: ['-B', '-Dstyle.color=always', '-q', '-DskipTests', '-pl', ':app', '-am', 'install'],
    cwd: '/w/be',
  });
  assert.equal(planned.steps[1].cmd, 'mvn');
  assert.deepEqual(planned.steps[1].args, [
    '-B',
    '-Dstyle.color=always',
    '-pl',
    ':app',
    'spring-boot:run',
    '-Dspring-boot.run.profiles=local,dev',
    '-Dspring-boot.run.jvmArguments=-Dspring.output.ansi.enabled=always -Xmx2g -Dfoo=a b',
    '-Dspring-boot.run.arguments=--x=1',
  ]);
  assert.equal(planned.env.SPRING_PROFILES_ACTIVE, 'local,dev');
  assert.equal(planned.env.SERVER_PORT, '8223');
  assert.equal(planned.env.JAVA_HOME, '/jdk/17');
  assert.equal(planned.port, 8223);
});

test('a single-module app with a wrapper just runs, and build:false skips the install', () => {
  const solo = { ...APP, dir: '/w/solo', reactor: '/w/solo', module: '', wrapper: true };
  const planned = spring.plan(solo, {});
  assert.equal(planned.steps.length, 1);
  assert.equal(planned.steps[0].cmd, '/w/solo/mvnw');
  assert.deepEqual(planned.steps[0].args, ['-B', '-Dstyle.color=always', 'spring-boot:run', '-Dspring-boot.run.jvmArguments=-Dspring.output.ansi.enabled=always']);
  assert.equal(planned.env.SPRING_PROFILES_ACTIVE, undefined);
  assert.equal(planned.env.JAVA_HOME, undefined);

  const noBuild = spring.plan(APP, { build: false });
  assert.equal(noBuild.steps.length, 1);
  assert.equal(noBuild.steps[0].label, 'mvn spring-boot:run');
});

test('jar mode packages and runs java -jar, with the jar filled in later', () => {
  const planned = spring.plan(APP, { mode: 'jar', profiles: 'local', jvmArgs: '-Xmx1g', args: '--a --b' });
  assert.equal(planned.steps[0].label, 'mvn install -pl :app -am');
  assert.deepEqual(planned.steps[1], {
    label: 'java -jar',
    cmd: 'java',
    args: ['-Dspring.output.ansi.enabled=always', '-Xmx1g', '-jar', '__JAR__', '--a', '--b'],
    cwd: '/w/be/app',
    jar: true,
  });
  assert.equal(planned.env.SPRING_PROFILES_ACTIVE, 'local');
});

test('a gradle app runs bootRun on its project, with JVM options through an init script and never the environment', () => {
  const gradle = { ...APP, tool: 'gradle', module: ':services:api', wrapper: true, reactor: '/w/g', dir: '/w/g/services/api' };
  const planned = spring.plan(gradle, { profiles: 'dev', jvmArgs: '-Xmx1g', args: '--x' }, { gradleInit: '/data/init.gradle', debugPort: 5005 });
  assert.equal(planned.steps.length, 1);
  assert.equal(planned.steps[0].cmd, '/w/g/gradlew');
  assert.deepEqual(planned.steps[0].args, [
    '-q',
    '--init-script',
    '/data/init.gradle',
    `-Dsmartterminal.jvmArgs=${['-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=localhost:5005', '-Dspring.output.ansi.enabled=always', '-Xmx1g'].join(spring.GRADLE_SEP)}`,
    ':services:api:bootRun',
    '--args=--x',
  ]);
  assert.equal(planned.env.SPRING_PROFILES_ACTIVE, 'dev');
  // JAVA_TOOL_OPTIONS is read by the Gradle client and the daemon too: the debugger would attach to Gradle.
  assert.equal(planned.env.JAVA_TOOL_OPTIONS, undefined);
  assert.match(spring.GRADLE_INIT, /smartterminal\.jvmArgs/);
  // Without anywhere to write the script, the options are simply not passed — never through the environment.
  const bare = spring.plan(gradle, { jvmArgs: '-Xmx1g' });
  assert.deepEqual(bare.steps[0].args, ['-q', ':services:api:bootRun']);
  assert.equal(bare.env.JAVA_TOOL_OPTIONS, undefined);
});

test('debugging is a JDWP agent on loopback, on the port asked for or the next free one', async () => {
  assert.equal(spring.jdwpOption(5005, false), '-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=localhost:5005');
  assert.equal(spring.jdwpOption('5006', true), '-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=localhost:5006');
  assert.throws(() => spring.jdwpOption('5005; rm -rf', false), /not a port/);
  assert.throws(() => spring.jdwpOption(70000, false), /not a port/);

  const planned = spring.plan(APP, { debug: true, debugPort: 5010, jvmArgs: '-Xmx1g' });
  assert.equal(planned.debugPort, 5010);
  assert.match(planned.steps[1].args.find((a) => a.startsWith('-Dspring-boot.run.jvmArguments=')), /^-Dspring-boot\.run\.jvmArguments=-agentlib:jdwp=[^ ]*address=localhost:5010 -Dspring\.output/);
  // Asked for on this start, over a configuration that does not ask for it — with the port the app chose.
  const once = spring.plan(APP, { debug: false, debugPort: 5005 }, { debugPort: 5007 });
  assert.equal(once.debugPort, 5007);
  assert.match(once.steps[1].args.join(' '), /address=localhost:5007/);
  assert.equal(spring.plan(APP, {}).debugPort, null);
  assert.doesNotMatch(spring.plan(APP, {}).steps[1].args.join(' '), /jdwp/);

  // A port that is taken is skipped.
  const net = require('node:net');
  const taken = net.createServer();
  await new Promise((resolve) => taken.listen({ port: 0, host: '127.0.0.1' }, resolve));
  const busy = taken.address().port;
  const chosen = await spring.freePort(busy);
  assert.ok(chosen > busy && chosen < busy + 20, `chose ${chosen} for ${busy}`);
  assert.equal(await spring.freePort(busy, { avoid: new Set([chosen]) }) !== chosen, true, 'a port another run holds is skipped');
  taken.close();

  assert.deepEqual(spring.readLine('Listening for transport dt_socket at address: 5005'), { kind: 'debug', port: 5005 });
  assert.equal(spring.statusWords({ status: 'starting', debugSuspend: true, debugListening: true, debugPort: 5005 }), 'waiting for a debugger on port 5005');
  assert.equal(spring.statusWords({ status: 'starting', debugSuspend: false, debugListening: true, debugPort: 5005 }), 'starting');
});

test('the pieces of a configuration are read leniently', () => {
  assert.deepEqual(spring.splitArgs(`-Xmx2g "two words" 'single q' plain`), ['-Xmx2g', 'two words', 'single q', 'plain']);
  // A quote glued to a flag holds the token together, which is what the JVM needs to see in jar mode.
  assert.deepEqual(spring.splitArgs(`-Dfoo="a b" --x='c d' e\\ f "g \\"h\\" i"`), ['-Dfoo=a b', '--x=c d', 'e f', 'g "h" i']);
  assert.deepEqual(spring.splitArgs(''), []);
  assert.equal(spring.profileList(' local,  dev prod '), 'local,dev,prod');
  assert.deepEqual(spring.parseEnvLines('# infra\nexport DB_URL=jdbc:x\nDB_PASSWORD="p a ss"\nBAD LINE\nEMPTY=\nQUOTED=\'x\'  # trailing'), {
    DB_URL: 'jdbc:x',
    DB_PASSWORD: 'p a ss',
    EMPTY: '',
    QUOTED: 'x',
  });
  const normal = spring.normalizeConfig({ profiles: ' local ', mode: 'weird', build: 'yes', port: '8223', jvmArgs: null, debugPort: 'x' });
  assert.equal(normal.debug, false);
  assert.equal(normal.debugPort, 5005);
  assert.equal(spring.normalizeConfig({ debug: true, debugPort: 6000, debugSuspend: true }).debugSuspend, true);
  assert.equal(normal.profiles, 'local');
  assert.equal(normal.mode, 'run');
  assert.equal(normal.build, true);
  assert.equal(normal.port, 8223);
  assert.equal(normal.jvmArgs, '');
  assert.equal(spring.normalizeConfig(null).mode, 'run');
  assert.equal(spring.normalizeConfig({ build: false }).build, false);
});

/*
 * The console, read for what it means. These are Spring's own sentences, in
 * the forms Boot 2 and Boot 3 print them, with the colour codes still on.
 */
test('the lines that change the state of a run are recognised, coloured or not', () => {
  assert.deepEqual(spring.readLine("2026-09-11 INFO --- [main] o.s.b.w.embedded.tomcat.TomcatWebServer : Tomcat started on port 8222 (http) with context path '/'"), {
    kind: 'port', port: 8222, scheme: 'http', contextPath: '',
  });
  assert.deepEqual(spring.readLine("Tomcat started on port(s): 8080 (http) with context path '/api'"), { kind: 'port', port: 8080, scheme: 'http', contextPath: '/api' });
  assert.deepEqual(spring.readLine('Netty started on port 8081'), { kind: 'port', port: 8081, scheme: 'http', contextPath: '' });
  assert.deepEqual(spring.readLine('Tomcat started on port 8443 (https) with context path \'\''), { kind: 'port', port: 8443, scheme: 'https', contextPath: '' });
  assert.deepEqual(spring.readLine('\x1b[32m INFO\x1b[0m Started KsErpApp in 12.345 seconds (process running for 13.1)'), { kind: 'started', application: 'KsErpApp', seconds: 12.345 });
  assert.deepEqual(spring.readLine('The following 2 profiles are active: "local", "dev"'), { kind: 'profiles', profiles: ['local', 'dev'] });
  assert.deepEqual(spring.readLine('The following 1 profile is active: "local"'), { kind: 'profiles', profiles: ['local'] });
  assert.deepEqual(spring.readLine('No active profile set, falling back to 1 default profile: "default"'), { kind: 'profiles', profiles: [] });
  assert.deepEqual(spring.readLine('***************************\nAPPLICATION FAILED TO START'), { kind: 'failed' });
  assert.deepEqual(spring.readLine('Web server failed to start. Port 8222 was already in use.'), { kind: 'portInUse', port: 8222 });
  assert.deepEqual(spring.readLine('[ERROR] BUILD FAILURE'), { kind: 'buildFailed' });
  assert.deepEqual(spring.readLine('[INFO] BUILD SUCCESS'), null);
  assert.equal(spring.readLine('Tomcat initialized with port 8080 (http)'), null, 'initialized is not started');
  assert.equal(spring.readLine('2026-09-11 DEBUG o.h.SQL : select 1'), null);
});

test('the reason a start failed is the analyzer paragraph, else the deepest cause', () => {
  const analyzed = [
    'stack',
    'trace',
    '***************************',
    'APPLICATION FAILED TO START',
    '***************************',
    '',
    'Description:',
    '',
    'Web server failed to start. Port 8222 was already in use.',
    '',
    'Action:',
    '',
    'Identify and stop the process that is listening on port 8222 or configure this application to listen on another port.',
    '',
    '[INFO] ------------------------------------------------------------------------',
    '[ERROR] BUILD FAILURE',
  ];
  assert.equal(
    spring.reasonFrom(analyzed),
    'Web server failed to start. Port 8222 was already in use.\n\nAction:\n\nIdentify and stop the process that is listening on port 8222 or configure this application to listen on another port.',
  );
  const caused = ['Exception in thread "main" java.lang.IllegalStateException: boom', '\tat x', 'Caused by: org.postgresql.util.PSQLException: Connection to localhost:5477 refused.', '\tat z', 'Caused by: java.net.ConnectException: Connection refused', '\tat y'];
  assert.equal(spring.reasonFrom(caused), 'org.postgresql.util.PSQLException: Connection to localhost:5477 refused.\njava.net.ConnectException: Connection refused');
  assert.equal(spring.reasonFrom(['[ERROR] Failed to execute goal', '[ERROR] Compilation failure']), '[ERROR] Failed to execute goal\n[ERROR] Compilation failure');
  assert.equal(spring.reasonFrom(['a', '', 'b']), '', 'nothing that reads as a reason');
  assert.equal(spring.tailOf(['a', '', 'b', '\x1b[31mc\x1b[0m']), 'a\nb\nc');
});

test('chunks become whole lines, and the tail waits for its newline', () => {
  assert.deepEqual(spring.wholeLines('a\nb\nc'), { lines: ['a', 'b'], rest: 'c' });
  assert.deepEqual(spring.wholeLines('a\n'), { lines: ['a'], rest: '' });
  assert.deepEqual(spring.wholeLines(''), { lines: [], rest: '' });
  assert.equal(spring.stripAnsi('\x1b[32mINFO\x1b[0m x'), 'INFO x');
});

/*
 * The Runs registry, against a process that is not a JVM: the shell, saying
 * the sentences Spring says. What is tested is the state machine and the
 * ownership — the console is kept, the port is read, a stop is a stop, and a
 * finished run can be forgotten but a live one cannot.
 */
function script(lines, { exit = 0, sleep = 0 } = {}) {
  const body = lines.map((line) => `echo '${line.replace(/'/g, `'\\''`)}'`).join('; ');
  return `${body}; ${sleep ? `sleep ${sleep}; ` : ''}exit ${exit}`;
}

function fakeApp(sh) {
  // A "build tool" that is /bin/sh: the plan puts the command in `cmd`, so the app's tool has to be one the plan knows.
  return {
    name: 'fake',
    dir: sh.dir,
    reactor: sh.dir,
    module: '',
    tool: 'maven',
    wrapper: true, // → <reactor>/mvnw, which the test writes
    port: null,
    actuator: false,
  };
}

function fakeProject(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spring-run-'));
  fs.writeFileSync(path.join(dir, 'mvnw'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return { dir };
}

const states = (log) => log.map((s) => s.status);

test('a run reads its port and its start from the console, and ends as exited', async () => {
  const project = fakeProject(script([
    'The following 1 profile is active: "local"',
    'Tomcat started on port 8222 (http) with context path \'/\'',
    'Started FakeApp in 0.5 seconds (process running for 0.6)',
  ]));
  const log = [];
  const out = [];
  const runs = new spring.Runs({ onOutput: (p) => out.push(p), onState: (s) => log.push(s), environment: async () => ({ ...process.env }) });
  await runs.start({ id: 'r1', root: project.dir, app: fakeApp(project), config: {}, jdk: null });
  await waitFor(() => runs.get('r1').done);
  const last = log[log.length - 1];
  assert.equal(last.status, 'exited');
  assert.equal(last.port, 8222);
  assert.deepEqual(last.profiles, ['local']);
  assert.equal(last.seconds, 0.5);
  assert.ok(states(log).includes('up'), `it was up at some point: ${states(log)}`);
  const console = runs.output('r1');
  assert.ok(console.lines.some((line) => /Started FakeApp/.test(line.text) && line.stream === 'out'));
  assert.equal(console.lines[0].stream, 'app', 'the step announcement is its own stream');
  assert.equal(console.rest, '');
  assert.ok(out.some((p) => p.stream === 'app' && /mvn spring-boot:run/.test(p.text)), 'the step is announced in the console');
  assert.equal(runs.list(project.dir).length, 1);
  assert.equal(runs.list('/nowhere').length, 0);
  assert.equal(runs.forget('r1').ok, true);
  assert.equal(runs.size, 0);
});

test('a failed start keeps the analyzer paragraph as its reason', async () => {
  const project = fakeProject(script([
    'APPLICATION FAILED TO START',
    '',
    'Description:',
    '',
    'Web server failed to start. Port 8222 was already in use.',
    '',
    'Action:',
    '',
    'Stop the other one.',
  ], { exit: 1 }));
  const log = [];
  const runs = new spring.Runs({ onState: (s) => log.push(s), environment: async () => ({ ...process.env }) });
  await runs.start({ id: 'r2', root: project.dir, app: fakeApp(project), config: {}, jdk: null });
  await waitFor(() => runs.get('r2').done);
  const last = log[log.length - 1];
  assert.equal(last.status, 'failed');
  assert.equal(last.code, 1);
  assert.match(last.reason, /Port 8222 was already in use/);
  assert.match(last.reason, /Stop the other one/);
});

test('a stop is a stop: the run ends as stopped, and cannot be forgotten before', async () => {
  const project = fakeProject(script(['Tomcat started on port 9999 (http)', 'Started X in 1 seconds'], { sleep: 30 }));
  const log = [];
  const runs = new spring.Runs({ onState: (s) => log.push(s), environment: async () => ({ ...process.env }) });
  await runs.start({ id: 'r3', root: project.dir, app: fakeApp(project), config: {}, jdk: null });
  await waitFor(() => runs.get('r3').status === 'up');
  assert.equal(runs.forget('r3').ok, false, 'a live run is not forgotten');
  await assert.rejects(runs.start({ id: 'r3b', root: project.dir, app: fakeApp(project), config: {} }), /already running/);
  assert.equal(runs.stop('r3').ok, true);
  await waitFor(() => runs.get('r3').done);
  assert.equal(runs.get('r3').status, 'stopped');
  assert.equal(runs.stop('r3').already, true);
  assert.equal(runs.stop('nope').ok, false);
});

test('a build that fails does not go on to run', async () => {
  const project = fakeProject('case "$*" in *install*) echo "[ERROR] BUILD FAILURE"; exit 1;; *) echo "should not run"; exit 0;; esac');
  const log = [];
  const runs = new spring.Runs({ onState: (s) => log.push(s), environment: async () => ({ ...process.env }) });
  const app = { ...fakeApp(project), module: ':app' };
  await runs.start({ id: 'r4', root: project.dir, app, config: {}, jdk: null });
  await waitFor(() => runs.get('r4').done);
  assert.equal(runs.get('r4').status, 'buildFailed');
  assert.ok(!runs.output('r4').lines.some((line) => /should not run/.test(line.text)));
  assert.equal(log[0].status, 'building');
});

test('a tool that is not there is said to be not there', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spring-none-'));
  // An empty PATH: whatever the machine has, the tool is not on it.
  const runs = new spring.Runs({ environment: async () => ({ ...process.env, PATH: dir }) });
  const app = { ...fakeApp({ dir }), wrapper: false, tool: 'gradle' };
  await runs.start({ id: 'r5', root: dir, app, config: {}, jdk: null });
  await waitFor(() => runs.get('r5').done);
  assert.equal(runs.get('r5').status, 'failed');
  assert.match(runs.get('r5').reason, /gradle is not installed/);
  assert.equal(spring.cleanError({ code: 'ENOENT', path: 'gradle' }), 'gradle is not installed, or not on the PATH this app can see');
});

/*
 * The guards around a start. A second click while the first is choosing its
 * port must not start a second copy; a stop that lands between two steps must
 * stop; a configuration cannot reach for PATH or the loader variables.
 */
test('two starts of the same application at once are one start', async () => {
  const project = fakeProject(script(['Started X in 1 seconds'], { sleep: 30 }));
  const runs = new spring.Runs({ environment: async () => ({ ...process.env }) });
  const app = fakeApp(project);
  const first = runs.start({ id: 'd1', root: project.dir, app, config: { debug: true, debugPort: 6100 } });
  const second = runs.start({ id: 'd2', root: project.dir, app, config: { debug: true, debugPort: 6100 } });
  const results = await Promise.allSettled([first, second]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.match(results.find((r) => r.status === 'rejected').reason.message, /already/);
  assert.equal(runs.liveCount, 1);
  await runs.stopAll({ grace: 500 });
  assert.equal(runs.liveCount, 0);
});

test('a stop between the build and the run stops the run before it starts', async () => {
  // The build step takes a while; the run step must never spawn.
  const project = fakeProject('case "$*" in *install*) sleep 0.3; exit 0;; *) echo "RAN"; sleep 30;; esac');
  const log = [];
  const runs = new spring.Runs({ onState: (s) => log.push(s), environment: async () => ({ ...process.env }) });
  const app = { ...fakeApp(project), module: ':app' };
  await runs.start({ id: 's1', root: project.dir, app, config: {} });
  // Let the build finish and the run step begin preparing, then stop.
  await waitFor(() => runs.get('s1').step === 0 && runs.get('s1').child !== null);
  const child = runs.get('s1').child;
  await new Promise((resolve) => child.once('close', resolve));
  const stopped = runs.stop('s1');
  assert.equal(stopped.ok, true);
  await waitFor(() => runs.get('s1').done);
  assert.equal(runs.get('s1').status, 'stopped');
  assert.ok(!runs.output('s1').lines.some((line) => line.text === 'RAN'), 'the run step never ran');
});

test('a configuration cannot set PATH or a loader variable, and an env file must be inside the project', () => {
  assert.deepEqual(spring.safeEnv({ PATH: '/x', DYLD_INSERT_LIBRARIES: 'y', LD_PRELOAD: 'z', NODE_OPTIONS: 'q', DB_URL: 'ok', JAVA_TOOL_OPTIONS: '-Xmx1g' }), {
    DB_URL: 'ok',
    JAVA_TOOL_OPTIONS: '-Xmx1g',
  });
  assert.equal(spring.underRoot({ root: '/w', app: { dir: '/w/app' } }, '/w'), true);
  assert.equal(spring.underRoot({ root: '/elsewhere', app: { dir: '/w-evil/app' } }, '/w'), false);
  assert.equal(spring.underRoot({ root: '/elsewhere', app: { dir: '/w/app' } }, '/w'), true);
});

test('the console is kept to its cap and a line that never ends is cut', async () => {
  const project = fakeProject('i=0; while [ $i -lt 5600 ]; do echo "line $i"; i=$((i+1)); done; printf "no newline"; exit 0');
  const runs = new spring.Runs({ environment: async () => ({ ...process.env }) });
  await runs.start({ id: 'k1', root: project.dir, app: fakeApp(project), config: {} });
  await waitFor(() => runs.get('k1').done, 20000);
  const held = runs.output('k1');
  assert.ok(held.lines.length <= 5500 && held.lines.length >= 5000, `kept ${held.lines.length}`);
  assert.equal(held.lines[held.lines.length - 1].text, 'line 5599');
  assert.equal(held.rest, 'no newline');
});

test('jar mode without a jar fails with a reason, and the newest plain jar is the one picked', async () => {
  const project = fakeProject('exit 0');
  const runs = new spring.Runs({ environment: async () => ({ ...process.env }) });
  await runs.start({ id: 'j1', root: project.dir, app: fakeApp(project), config: { mode: 'jar', build: false } });
  await waitFor(() => runs.get('j1').done);
  assert.equal(runs.get('j1').status, 'failed');
  assert.match(runs.get('j1').reason, /No jar to run/);

  const target = path.join(project.dir, 'target');
  fs.mkdirSync(target);
  const older = path.join(target, 'app-1.0.jar');
  fs.writeFileSync(older, 'x');
  fs.utimesSync(older, new Date(Date.now() - 60000), new Date(Date.now() - 60000));
  fs.writeFileSync(path.join(target, 'app-1.0.jar.original'), 'x');
  fs.writeFileSync(path.join(target, 'app-1.0-sources.jar'), 'x');
  fs.writeFileSync(path.join(target, 'app-1.0-plain.jar'), 'x');
  const newer = path.join(target, 'app-1.1.jar');
  fs.writeFileSync(newer, 'x');
  assert.equal(await spring.findJar(fakeApp(project)), newer);
  assert.equal(await spring.findJar({ ...fakeApp(project), dir: path.join(project.dir, 'nowhere') }), null);
});

// Whatever a test left running or on disk goes with the file.
const made = [];
const registries = [];
const originalMkdtemp = fs.mkdtempSync;
fs.mkdtempSync = (...args) => {
  const dir = originalMkdtemp(...args);
  made.push(dir);
  return dir;
};
const OriginalRuns = spring.Runs;
spring.Runs = class extends OriginalRuns {
  constructor(...args) {
    super(...args);
    registries.push(this);
  }
};
test.after(async () => {
  await Promise.all(registries.map((runs) => runs.stopAll({ grace: 300 })));
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

function waitFor(check, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (check()) return resolve();
      if (Date.now() - started > timeout) return reject(new Error('timed out waiting'));
      setTimeout(tick, 25);
    };
    tick();
  });
}

/*
 * The actuator URL. Loopback only, from a fixed list, with the management
 * port winning over the server port and the context path applying only when
 * they are the same.
 */
test('an actuator url is loopback, on the management port when there is one', () => {
  const run = { port: 8222, scheme: 'http', contextPath: '/api', managementPort: null, managementBasePath: '/actuator' };
  assert.equal(spring.actuatorUrl(run, 'health'), 'http://127.0.0.1:8222/api/actuator/health');
  assert.equal(spring.actuatorUrl({ ...run, managementPort: 9090, managementBasePath: '/manage' }, 'loggers', 'com.ks'), 'http://127.0.0.1:9090/manage/loggers/com.ks');
  assert.throws(() => spring.actuatorUrl(run, 'shutdown'), /not an actuator endpoint/);
  assert.throws(() => spring.actuatorUrl(run, 'loggers', '../env'), /cannot be part of a URL/);
  assert.throws(() => spring.actuatorUrl({ ...run, port: null }, 'health'), /has not said which port/);
  assert.throws(() => spring.actuatorUrl({ ...run, managementBasePath: '/actuator/shutdown?' }, 'health'), /base path is not a path/);
  assert.throws(() => spring.actuatorUrl({ ...run, contextPath: '/../x' }, 'health'), /context path is not a path/);
  assert.equal(spring.actuatorUrl({ ...run, scheme: 'https', contextPath: '' }, 'health'), 'https://127.0.0.1:8222/actuator/health');
});

test('the actuator is read over loopback, health is an answer even when it is DOWN, and https does not throw', async () => {
  const http = require('node:http');
  const server = http.createServer((request, response) => {
    if (request.url === '/actuator/health') {
      response.writeHead(503, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ status: 'DOWN', components: { db: { status: 'DOWN' } } }));
    } else if (request.url === '/actuator/loggers/com.x' && request.method === 'POST') {
      let body = '';
      request.on('data', (c) => { body += c; });
      request.on('end', () => {
        response.writeHead(body === '{"configuredLevel":"DEBUG"}' ? 204 : 400);
        response.end();
      });
    } else if (request.url === '/actuator/beans') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ contexts: {} }));
    } else if (request.url === '/actuator/env') {
      response.writeHead(401);
      response.end('');
    } else {
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end('{}');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const run = { port, scheme: 'http', contextPath: '', managementPort: null, managementBasePath: '/actuator' };
  try {
    const health = await spring.fetchJson(spring.actuatorUrl(run, 'health'));
    assert.equal(health.ok, true);
    assert.equal(health.status, 503);
    assert.equal(health.data.components.db.status, 'DOWN');
    const beans = await spring.fetchJson(spring.actuatorUrl(run, 'beans'));
    assert.equal(beans.ok, true);
    const missing = await spring.fetchJson(spring.actuatorUrl(run, 'mappings'));
    assert.equal(missing.ok, false);
    assert.match(missing.error, /not exposed/);
    const locked = await spring.fetchJson(spring.actuatorUrl(run, 'env'));
    assert.match(locked.error, /behind security/);
    const set = await spring.fetchJson(spring.actuatorUrl(run, 'loggers', 'com.x'), { method: 'POST', body: { configuredLevel: 'DEBUG' } });
    assert.equal(set.ok, true);
    assert.equal(set.status, 204);
    const secure = await spring.fetchJson(spring.actuatorUrl({ ...run, scheme: 'https' }, 'health'), { timeout: 1500 });
    assert.equal(secure.ok, false, 'a plain server answering an https request is an error, not an exception');
    assert.ok(typeof secure.error === 'string');
    const nobody = await spring.fetchJson('http://127.0.0.1:1/actuator/health');
    assert.match(nobody.error, /Nothing is listening/);
  } finally {
    server.close();
  }
});

test('the briefing says how it was started and where it stands, and quotes the failure', () => {
  const run = {
    id: 'b',
    root: '/w',
    app: { dir: '/w/app', name: 'ks-erp', tool: 'maven', module: ':app', reactor: '/w', mainClass: 'com.ks.App', actuator: true },
    config: { mode: 'run' },
    jdk: { home: '/jdk', version: '25.0.1', name: 'corretto' },
    steps: [{ label: 'mvn install -pl :app -am' }, { label: 'mvn spring-boot:run' }],
    step: 1,
    status: 'failed',
    phase: '',
    port: 8222,
    scheme: 'http',
    contextPath: '',
    profiles: ['local'],
    startedAt: 0,
    upAt: null,
    endedAt: 1,
    seconds: null,
    code: 1,
    reason: 'Port 8222 was already in use.',
    done: true,
    child: null,
  };
  const output = ['INFO starting', 'APPLICATION FAILED TO START', 'Description:', 'Port 8222 was already in use.'].join('\n');
  const text = spring.brief(run, output).text;
  assert.match(text, /# Spring Boot application: ks-erp/);
  assert.match(text, /module :app of \/w/);
  assert.match(text, /mvn install -pl :app -am → mvn spring-boot:run/);
  assert.match(text, /Profiles: local/);
  assert.match(text, /JDK: 25.0.1 at \/jdk/);
  assert.match(text, /Status: failed to start \(exit code 1\)/);
  assert.match(text, /## What went wrong\n\nPort 8222 was already in use/);
  const noisy = ['DEBUG something about an Exception mapper', ...Array.from({ length: 600 }, (_, i) => `INFO line ${i}`), 'ERROR boom', 'APPLICATION FAILED TO START', 'Description:', 'Port 8222 was already in use.'].join('\n');
  const late = spring.brief(run, noisy).text;
  assert.match(late, /APPLICATION FAILED TO START/, 'the banner is in the excerpt however early the first "Exception" was');
  assert.match(late, /ERROR boom/);
  assert.match(text, /APPLICATION FAILED TO START/);
  assert.match(text, /failed to start\. Read the console/);
  assert.doesNotMatch(text, /Debugger/);
  const debugged = spring.brief({ ...run, debugPort: 5005, debugListening: true, debugSuspend: false }, output).text;
  assert.match(debugged, /Debugger: the JVM is listening for a debugger on localhost:5005\./);
  assert.match(debugged, /jdb -attach 5005 -sourcepath \/w\/app\/src\/main\/java/);
  assert.match(spring.brief({ ...run, status: 'up', reason: '', seconds: 3.2 }, 'INFO fine', { question: 'why slow?' }).text, /why slow\?$/);
  assert.equal(spring.statusWords({ status: 'up', port: 80, seconds: 2 }), 'up on port 80, started in 2s');
});

test('configurations are kept per application folder, under a root', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'spring-cfg-')), 'spring-boot.json');
  const configs = new spring.Configs(file);
  assert.deepEqual(configs.forRoot('/w'), {});
  configs.save('/w/app', { profiles: 'local', mode: 'jar' });
  configs.save('/elsewhere/x', { profiles: 'prod' });
  assert.equal(configs.get('/w/app').profiles, 'local');
  assert.equal(configs.get('/w/app').mode, 'jar');
  assert.deepEqual(Object.keys(configs.forRoot('/w')), ['/w/app']);
  assert.deepEqual(Object.keys(configs.forRoot('')).sort(), ['/elsewhere/x', '/w/app']);
  assert.equal(configs.get('/never').mode, 'run');
  fs.writeFileSync(file, '{ not json');
  assert.deepEqual(configs.forRoot('/w'), {});
  configs.save('/w/app', { profiles: 'again' });
  assert.equal(configs.get('/w/app').profiles, 'again');
});
