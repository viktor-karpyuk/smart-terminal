'use strict';

/**
 * A cluster as a graph: what there is, and what is joined to what.
 *
 * The tables answer "what pods are there". They cannot answer "where does this
 * database actually run, on what disk, and what else is standing on the same
 * node" — that is a question about the lines between rows, and a row has none.
 * So this reads the same lists the tables read and keeps the joins instead of
 * the columns.
 *
 * One rule runs through all of it: **every line says where it came from.** An
 * owner reference, a selector, a claim's volume name — those are the API's own
 * words, and they are `source: 'api'`. That a Deployment *uses* a database
 * because an environment variable has its service's name in it is a guess, a
 * good one, and it is `source: 'inferred'` so the panel can draw it as one.
 * Likewise "this is MongoDB": Kubernetes has no such kind. It is read off the
 * image name, and says so.
 *
 * Nothing here reads a Secret or a ConfigMap. Environment values written
 * straight into a pod template are looked at for service names and then thrown
 * away; they are never sent to the panel.
 *
 * Pure. The helpers it needs from `kube.js` are handed in, because `kube.js` is
 * also what calls this.
 */

/** Namespaces that are the cluster's own furniture rather than somebody's application. */
const SYSTEM_NAMESPACE = /^(kube-.*|.*-system|kube|gatekeeper.*|cert-manager|ingress-nginx)$/;

/**
 * Data services recognisable by the image they run.
 *
 * Tested against the last segment of the image name, without registry, tag or
 * digest. Deliberately short: a list that tries to know everything ends up
 * calling a backup job a database.
 */
const TECH = [
  { tech: 'MongoDB', match: /^(mongo|mongodb|mongodb-community-server|mongodb-enterprise-server|percona-server-mongodb)$/ },
  { tech: 'Redis', match: /^(redis|redis-stack|redis-stack-server|redis-cluster|redis-sentinel|valkey|keydb|dragonfly)$/ },
  { tech: 'PostgreSQL', match: /^(postgres|postgresql|postgresql-repmgr|postgis|timescaledb|timescaledb-ha|spilo|pgvector)(-\d+)?$/ },
  { tech: 'MySQL', match: /^(mysql|mysql-server|percona-server|percona-xtradb-cluster)$/ },
  { tech: 'MariaDB', match: /^(mariadb|mariadb-galera)$/ },
  { tech: 'RabbitMQ', match: /^rabbitmq$/ },
  { tech: 'Kafka', match: /^(kafka|cp-kafka|redpanda)$/ },
  { tech: 'Elasticsearch', match: /^elasticsearch$/ },
  { tech: 'OpenSearch', match: /^opensearch$/ },
  { tech: 'ClickHouse', match: /^(clickhouse|clickhouse-server)$/ },
  { tech: 'Cassandra', match: /^cassandra$/ },
  { tech: 'MinIO', match: /^minio$/ },
  { tech: 'NATS', match: /^nats$/ },
  { tech: 'Memcached', match: /^memcached$/ },
];

/** Pod labels operators and charts use to say which member of a replicated set this is. */
const ROLE_LABELS = ['cnpg.io/instanceRole', 'spilo-role', 'redis-role', 'role', 'app.kubernetes.io/component'];
const ROLE_WORDS = {
  primary: 'primary', master: 'primary', leader: 'primary',
  replica: 'replica', replicas: 'replica', secondary: 'replica', slave: 'replica', standby: 'replica', follower: 'replica',
  sentinel: 'sentinel', arbiter: 'arbiter',
};

/** An environment variable whose whole value may be a bare host name. */
const HOSTISH_ENV = /HOST|URL|URI|ADDR|SERVER|ENDPOINT|BROKER|DSN|SERVICE|CONN/i;

const WORKLOAD_KINDS = ['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'Job', 'CronJob'];

function idOf(kind, namespace, name) {
  return `${kind}/${namespace || ''}/${name}`;
}

/** `registry/team/mongo:7.0@sha256:…` → `{ base: 'mongo', tag: '7.0' }`. */
function imageParts(image) {
  const text = String(image ?? '').split('@')[0];
  const last = text.split('/').pop() ?? '';
  const colon = last.lastIndexOf(':');
  return colon < 0 ? { base: last, tag: '' } : { base: last.slice(0, colon), tag: last.slice(colon + 1) };
}

/** What data service an image is, if it is one we recognise. */
function techOf(image) {
  const { base, tag } = imageParts(image);
  if (!base || /exporter|operator|backup|metrics|proxy|bouncer|admin|init/.test(base)) return null;
  const found = TECH.find((entry) => entry.match.test(base));
  if (!found) return null;
  const version = /^v?(\d+(?:\.\d+){0,2})/.exec(tag);
  return { tech: found.tech, version: version ? version[1] : '', image: String(image) };
}

function matches(selector, labels) {
  const keys = Object.keys(selector ?? {});
  if (!keys.length) return false;
  return keys.every((key) => (labels ?? {})[key] === selector[key]);
}

/** The pod template of anything that has one. */
function templateOf(item) {
  if (item.kind === 'CronJob') return item.spec?.jobTemplate?.spec?.template ?? null;
  return item.spec?.template ?? null;
}

function containersOf(template) {
  return [...(template?.spec?.initContainers ?? []), ...(template?.spec?.containers ?? [])];
}

/** What keeps two replicas apart, in a few words — or nothing, when nothing does. */
function spreadOf(template) {
  const anti = template?.spec?.affinity?.podAntiAffinity;
  const required = anti?.requiredDuringSchedulingIgnoredDuringExecution ?? [];
  if (required.length) return { mode: 'required', key: required[0].topologyKey ?? '' };
  const preferred = anti?.preferredDuringSchedulingIgnoredDuringExecution ?? [];
  if (preferred.length) return { mode: 'preferred', key: preferred[0].podAffinityTerm?.topologyKey ?? '' };
  const spread = template?.spec?.topologySpreadConstraints ?? [];
  if (spread.length) {
    return { mode: spread[0].whenUnsatisfiable === 'DoNotSchedule' ? 'required' : 'preferred', key: spread[0].topologyKey ?? '' };
  }
  return null;
}

/** Ready against wanted, and which of three colours that is. */
function workloadState(item) {
  const status = item.status ?? {};
  if (item.kind === 'CronJob') {
    const suspended = item.spec?.suspend === true;
    return { desired: 0, ready: 0, status: suspended ? 'Suspended' : item.spec?.schedule ?? '', health: suspended ? 'idle' : 'ok' };
  }
  if (item.kind === 'Job') {
    if ((status.failed ?? 0) > 0 && !(status.succeeded > 0)) return { desired: 0, ready: 0, status: 'Failed', health: 'bad' };
    if ((status.active ?? 0) > 0) return { desired: 0, ready: 0, status: 'Running', health: 'ok' };
    return { desired: 0, ready: 0, status: 'Complete', health: 'idle' };
  }
  const desired = item.kind === 'DaemonSet' ? status.desiredNumberScheduled ?? 0 : item.spec?.replicas ?? 1;
  const ready = item.kind === 'DaemonSet' ? status.numberReady ?? 0 : status.readyReplicas ?? 0;
  const health = desired === 0 ? 'idle' : ready === 0 ? 'bad' : ready < desired ? 'warn' : 'ok';
  return { desired, ready, status: `${ready}/${desired} ready`, health };
}

/**
 * The services a pod template names, by reading what is written into it.
 *
 * Two shapes are trusted. `name.namespace` (with or without `.svc…`) anywhere
 * in a value, when that service exists — a dotted pair that happens to be a
 * real service in a real namespace is not a coincidence. And a bare `name` in
 * the same namespace, only where a host goes: after `//` or `@`, or as the
 * whole value of a variable whose own name says it holds an address.
 */
function servicesNamedIn(template, namespace, serviceIds) {
  const found = new Map();
  const note = (id, via) => { if (id && !found.has(id)) found.set(id, via); };
  const dotted = /([a-z0-9][a-z0-9-]*)\.([a-z0-9][a-z0-9-]*)(?:\.svc(?:\.cluster\.local)?)?(?=[:/,\s?]|$)/g;
  const hosted = /(?:\/\/|@)([a-z0-9][a-z0-9-]*)(?=[:/,?]|$)/g;

  const read = (text, via, bareAllowed) => {
    const value = String(text ?? '');
    if (!value || value.length > 2000) return;
    for (const match of value.matchAll(dotted)) {
      const id = idOf('Service', match[2], match[1]);
      if (serviceIds.has(id)) note(id, via);
    }
    for (const match of value.matchAll(hosted)) {
      const id = idOf('Service', namespace, match[1]);
      if (serviceIds.has(id)) note(id, via);
    }
    if (bareAllowed && /^[a-z0-9][a-z0-9-]*(:\d+)?$/.test(value)) {
      const id = idOf('Service', namespace, value.split(':')[0]);
      if (serviceIds.has(id)) note(id, via);
    }
  };

  for (const container of containersOf(template)) {
    for (const env of container.env ?? []) {
      if (typeof env.value === 'string') read(env.value, `env ${env.name}`, HOSTISH_ENV.test(env.name ?? ''));
    }
    for (const word of [...(container.args ?? []), ...(container.command ?? [])]) read(word, 'container arguments', false);
  }
  return found;
}

/**
 * The graph.
 *
 * `lists` is the raw items of each kind, as the API server sent them; any of
 * them may be missing — a cluster where this person may not list volumes still
 * has pods worth drawing. `usage` is `kubectl top`, when there is a
 * metrics-server to answer it.
 */
function graphFrom(lists, helpers, now = Date.now()) {
  const { podStatus, health, quantity, millicores, podRequests, holdsRoom, nodeGroupOf } = helpers;
  const nodeGroupKindOf = helpers.nodeGroupKindOf ?? (() => '');
  const all = (kind) => lists[kind] ?? [];
  const usage = lists.usage ?? { nodes: {}, pods: {} };

  const nodes = [];
  const edges = [];
  const byId = new Map();
  // The uid and the birth date ride along so the panel can open its pane on a card at once, before asking again.
  const add = (item, node) => {
    node.uid = item.metadata?.uid ?? node.id;
    node.createdAt = item.metadata?.creationTimestamp ?? null;
    byId.set(node.id, node);
    nodes.push(node);
    return node;
  };
  const seenEdges = new Set();
  const join = (from, to, type, extra) => {
    if (!byId.has(from) || !byId.has(to)) return;
    const key = `${from}>${to}>${type}`;
    if (seenEdges.has(key)) return;
    seenEdges.add(key);
    edges.push({ from, to, type, source: 'api', ...extra });
  };
  const meta = (item) => ({
    name: item.metadata?.name ?? '',
    namespace: item.metadata?.namespace ?? '',
  });

  /* ---- the machines ---------------------------------------------------- */
  for (const item of all('nodes')) {
    const labels = item.metadata?.labels ?? {};
    const conditions = item.status?.conditions ?? [];
    const isReady = conditions.find((c) => c.type === 'Ready')?.status === 'True';
    const complaints = conditions.filter((c) => c.type !== 'Ready' && c.status === 'True').map((c) => c.type);
    const unschedulable = item.spec?.unschedulable === true;
    const zone = labels['topology.kubernetes.io/zone'] ?? labels['failure-domain.beta.kubernetes.io/zone'] ?? '';
    const region = labels['topology.kubernetes.io/region'] ?? labels['failure-domain.beta.kubernetes.io/region'] ?? '';
    const name = item.metadata?.name ?? '';
    const used = usage.nodes?.[`/${name}`];
    add(item, {
      id: idOf('Node', '', name),
      kind: 'Node',
      name,
      namespace: '',
      status: !isReady ? 'NotReady' : unschedulable ? 'Ready, cordoned' : complaints.length ? complaints.join(', ') : 'Ready',
      health: !isReady ? 'bad' : complaints.length || unschedulable ? 'warn' : 'ok',
      pool: nodeGroupOf(labels),
      // Who makes this pool's nodes — a managed node group, Karpenter — and which cloud they are in.
      poolKind: nodeGroupKindOf(labels),
      provider: String(item.spec?.providerID ?? '').split(':')[0],
      // A zone when the cloud names one; otherwise the region is as fine as placement gets.
      zone: zone || region,
      zoneKind: zone ? 'zone' : region ? 'region' : '',
      instance: labels['node.kubernetes.io/instance-type'] ?? '',
      version: item.status?.nodeInfo?.kubeletVersion ?? '',
      taints: (item.spec?.taints ?? []).length,
      // What a replacement has to repeat to be scheduled onto the same way. A cordon's own taint is not one of them.
      taintList: (item.spec?.taints ?? [])
        .filter((taint) => taint.key !== 'node.kubernetes.io/unschedulable')
        .map((taint) => `${taint.key}${taint.value ? `=${taint.value}` : ''}:${taint.effect}`),
      capacity: String(labels['eks.amazonaws.com/capacityType'] ?? labels['karpenter.sh/capacity-type'] ??
        (labels['cloud.google.com/gke-spot'] === 'true' ? 'spot' : '')).toLowerCase().replace('_', '-'),
      cpuAlloc: millicores(item.status?.allocatable?.cpu),
      memAlloc: quantity(item.status?.allocatable?.memory),
      cpuReq: 0,
      memReq: 0,
      pods: 0,
      cpuUsed: used ? millicores(used.cpu) : null,
      memUsed: used ? quantity(used.memory) : null,
    });
  }

  /* ---- workloads ------------------------------------------------------- */
  const byUid = new Map();
  const workloadItems = all('workloads').filter((item) => WORKLOAD_KINDS.includes(item.kind));
  for (const item of workloadItems) if (item.metadata?.uid) byUid.set(item.metadata.uid, item);
  const controllerOf = (item) =>
    (item.metadata?.ownerReferences ?? []).find((ref) => ref.controller) ?? item.metadata?.ownerReferences?.[0] ?? null;

  /** The thing a person would say owns this: a Deployment, not the ReplicaSet in between. */
  const topOwner = (item) => {
    let current = item;
    for (let hops = 0; hops < 3; hops += 1) {
      const ref = controllerOf(current);
      const parent = ref ? byUid.get(ref.uid) : null;
      if (!parent) break;
      current = parent;
      if (current.kind !== 'ReplicaSet') break;
    }
    return current === item ? null : current;
  };

  const podItems = all('pods');
  const ownedJobs = new Set();
  for (const pod of podItems) {
    const owner = topOwner(pod);
    if (owner?.kind === 'Job') ownedJobs.add(owner.metadata.uid);
  }

  const pdbs = all('pdbs');
  const hpas = all('hpas');
  /** What an autoscaler measures: v2 lists its metrics, v1 only ever meant CPU. */
  const measuredBy = (hpa) => {
    const listed = (hpa?.spec?.metrics ?? []).filter((metric) => metric.type === 'Resource').map((metric) => metric.resource?.name).filter(Boolean);
    if (listed.length) return listed;
    return hpa?.spec?.targetCPUUtilizationPercentage != null ? ['cpu'] : [];
  };
  const workloadNodes = [];
  for (const item of workloadItems) {
    const { name, namespace } = meta(item);
    if (item.kind === 'ReplicaSet') {
      // A Deployment's ReplicaSets are how it works, not something to look at.
      if (controllerOf(item) && byUid.has(controllerOf(item).uid)) continue;
      if (!(item.spec?.replicas > 0)) continue;
    }
    if (item.kind === 'Job') {
      const state = item.status ?? {};
      if (!ownedJobs.has(item.metadata?.uid) && !(state.active > 0) && !(state.failed > 0)) continue;
    }
    const template = templateOf(item);
    const labels = item.metadata?.labels ?? {};
    const templateLabels = template?.metadata?.labels ?? {};
    const images = (template?.spec?.containers ?? []).map((container) => container.image ?? '');
    // A backup job runs the database's image too, and is not a database.
    const serves = item.kind === 'Deployment' || item.kind === 'StatefulSet' || item.kind === 'DaemonSet';
    const found = serves ? images.map(techOf).find(Boolean) ?? null : null;
    const state = workloadState(item);
    const fake = { spec: template?.spec ?? {} };
    const requests = podRequests(fake, 'requests');
    const limits = podRequests(fake, 'limits');
    const pdb = pdbs.find((entry) =>
      entry.metadata?.namespace === namespace && matches(entry.spec?.selector?.matchLabels, templateLabels));
    // The autoscaler names what it scales, so this is stated and not worked out.
    const hpa = hpas.find((entry) => entry.metadata?.namespace === namespace &&
      entry.spec?.scaleTargetRef?.kind === item.kind && entry.spec?.scaleTargetRef?.name === name);
    const node = add(item, {
      id: idOf(item.kind, namespace, name),
      kind: item.kind,
      name,
      namespace,
      ...state,
      images,
      hpa: hpa?.metadata?.name ?? '',
      hpaOn: measuredBy(hpa),
      hpaRange: hpa ? `${hpa.spec?.minReplicas ?? 1}–${hpa.spec?.maxReplicas ?? '?'}` : '',
      // Containers that ask for no CPU: an autoscaler told to hold a share of the request has nothing to take a share of.
      unrequested: (template?.spec?.containers ?? []).filter((container) => !container.resources?.requests?.cpu).map((container) => container.name ?? ''),
      cpuReq: requests.cpu,
      memReq: requests.memory,
      cpuLim: limits.cpu,
      memLim: limits.memory,
      spread: spreadOf(template),
      pdb: pdb?.metadata?.name ?? '',
      // How many of its pods may be taken away right now. Zero is a drain that waits.
      pdbAllowed: pdb ? pdb.status?.disruptionsAllowed ?? null : null,
      helm: labels['app.kubernetes.io/managed-by'] === 'Helm' ? labels['helm.sh/chart'] ?? 'Helm' : '',
      claimTemplates: (item.spec?.volumeClaimTemplates ?? []).map((claim) => claim.metadata?.name ?? ''),
      // Read off the image. Kubernetes has no kind called "MongoDB".
      tech: found?.tech ?? '',
      techVersion: found?.version ?? '',
      exporter: containersOf(template).some((container) => /exporter/.test(imageParts(container.image).base)),
    });
    workloadNodes.push({ node, item, template, templateLabels });
  }
  for (const { node, item } of workloadNodes) {
    if (item.kind !== 'Job') continue;
    const parent = topOwner(item);
    if (parent) join(idOf(parent.kind, parent.metadata?.namespace, parent.metadata?.name), node.id, 'owns');
  }

  /*
   * What an operator owns.
   *
   * Half the databases in a real cluster are not StatefulSets: they are pods
   * owned by a `Cluster`, a `RedisFailover`, a `Rollout` — a custom resource
   * whose controller makes the pods itself. Those kinds are not in any list
   * read here, so their pods used to look like pods nobody owned, three
   * strangers instead of one database, and a plan to drain their node warned
   * that they would never come back. The owner reference names the thing, so
   * it is drawn from that: a workload by another name, marked as one this map
   * knows only through its pods.
   */
  const customs = new Map();
  const customOwner = (pod) => {
    const ref = controllerOf(pod);
    if (!ref?.kind || !ref.name || byUid.has(ref.uid) || ref.kind === 'Node') return '';
    const namespace = pod.metadata?.namespace ?? '';
    const id = idOf(ref.kind, namespace, ref.name);
    if (!customs.has(id)) {
      if (byId.has(id)) return id;
      const group = String(ref.apiVersion ?? '').includes('/') ? String(ref.apiVersion).split('/')[0] : '';
      const fake = { spec: pod.spec ?? {} };
      const requests = podRequests(fake, 'requests');
      const limits = podRequests(fake, 'limits');
      const images = (pod.spec?.containers ?? []).map((container) => container.image ?? '');
      const found = images.map(techOf).find(Boolean) ?? null;
      const labels = pod.metadata?.labels ?? {};
      const pdb = pdbs.find((entry) => entry.metadata?.namespace === namespace && matches(entry.spec?.selector?.matchLabels, labels));
      const node = {
        id, kind: ref.kind, name: ref.name, namespace,
        uid: ref.uid ?? id, createdAt: null,
        custom: true,
        // What kubectl calls it: the kind with its API group, which is the spelling that cannot collide.
        resource: group ? `${ref.kind.toLowerCase()}.${group}` : ref.kind.toLowerCase(),
        desired: 0, ready: 0, status: '', health: 'ok',
        images, cpuReq: requests.cpu, memReq: requests.memory, cpuLim: limits.cpu, memLim: limits.memory,
        spread: spreadOf({ spec: pod.spec }),
        pdb: pdb?.metadata?.name ?? '', pdbAllowed: pdb ? pdb.status?.disruptionsAllowed ?? null : null,
        helm: '', claimTemplates: [],
        tech: found?.tech ?? '', techVersion: found?.version ?? '',
        exporter: [...(pod.spec?.initContainers ?? []), ...(pod.spec?.containers ?? [])].some((container) => /exporter/.test(imageParts(container.image).base)),
      };
      byId.set(id, node);
      nodes.push(node);
      customs.set(id, node);
    }
    return id;
  };

  /* ---- pods ------------------------------------------------------------ */
  const podsByNamespace = new Map();
  for (const pod of podItems) {
    const { name, namespace } = meta(pod);
    const statuses = pod.status?.containerStatuses ?? [];
    const status = podStatus(pod);
    const owner = topOwner(pod);
    const ownerId = owner ? idOf(owner.kind, owner.metadata?.namespace, owner.metadata?.name) : customOwner(pod);
    // A static pod is the kubelet's own, written on the node's disk: it belongs to the machine, not to anything that could move it.
    const mirror = controllerOf(pod)?.kind === 'Node';
    const requests = podRequests(pod, 'requests');
    const limits = podRequests(pod, 'limits');
    const used = usage.pods?.[`${namespace}/${name}`];
    const labels = pod.metadata?.labels ?? {};
    let role = '';
    for (const key of ROLE_LABELS) {
      const word = ROLE_WORDS[String(labels[key] ?? '').toLowerCase()];
      if (word) { role = word; break; }
    }
    const finished = pod.status?.phase === 'Succeeded';
    const node = add(pod, {
      id: idOf('Pod', namespace, name),
      kind: 'Pod',
      name,
      namespace,
      status,
      health: finished ? 'idle' : health(status),
      ready: statuses.length > 0 && statuses.every((entry) => entry.ready),
      restarts: statuses.reduce((sum, entry) => sum + (entry.restartCount ?? 0), 0),
      lastEnd: statuses.map((entry) => entry.lastState?.terminated?.reason).filter(Boolean)[0] ?? '',
      node: pod.spec?.nodeName ?? '',
      owner: byId.has(ownerId) ? ownerId : '',
      cpuReq: requests.cpu,
      memReq: requests.memory,
      cpuLim: limits.cpu,
      memLim: limits.memory,
      cpuUsed: used ? millicores(used.cpu) : null,
      memUsed: used ? quantity(used.memory) : null,
      role,
      finished,
      mirror,
    });
    const custom = customs.get(node.owner);
    if (custom && !finished) {
      custom.desired += 1;
      if (node.ready) custom.ready += 1;
    }
    if (node.owner) join(node.owner, node.id, 'owns');
    const machine = byId.get(idOf('Node', '', node.node));
    if (machine) {
      join(node.id, machine.id, 'runs-on');
      if (holdsRoom(pod)) {
        machine.cpuReq += requests.cpu;
        machine.memReq += requests.memory;
        machine.pods += 1;
      }
    }
    if (!podsByNamespace.has(namespace)) podsByNamespace.set(namespace, []);
    podsByNamespace.get(namespace).push({ pod, node });
  }

  for (const custom of customs.values()) {
    custom.status = `${custom.ready}/${custom.desired} ready`;
    custom.health = custom.desired === 0 ? 'idle' : custom.ready === 0 ? 'bad' : custom.ready < custom.desired ? 'warn' : 'ok';
  }

  /* ---- storage --------------------------------------------------------- */
  const attachments = new Map();
  for (const item of all('attachments')) {
    const volume = item.spec?.source?.persistentVolumeName;
    if (volume) attachments.set(volume, { node: item.spec?.nodeName ?? '', attached: item.status?.attached === true });
  }
  for (const item of all('drivers')) {
    add(item, { id: idOf('CSIDriver', '', item.metadata?.name), kind: 'CSIDriver', name: item.metadata?.name ?? '', namespace: '', status: 'CSI driver', health: 'ok' });
  }
  for (const item of all('classes')) {
    const name = item.metadata?.name ?? '';
    add(item, {
      id: idOf('StorageClass', '', name),
      kind: 'StorageClass',
      name,
      namespace: '',
      status: item.provisioner ?? '',
      health: 'ok',
      provisioner: item.provisioner ?? '',
      reclaim: item.reclaimPolicy ?? '',
      binding: item.volumeBindingMode ?? '',
      expansion: item.allowVolumeExpansion === true,
      isDefault: item.metadata?.annotations?.['storageclass.kubernetes.io/is-default-class'] === 'true',
    });
    join(idOf('StorageClass', '', name), idOf('CSIDriver', '', item.provisioner), 'driver');
  }
  const claimItems = all('claims');
  const claimed = new Set(claimItems.map((item) => item.spec?.volumeName).filter(Boolean));
  for (const item of all('volumes')) {
    const name = item.metadata?.name ?? '';
    // Looking at one namespace, the volumes of every other one are noise.
    if (lists.scoped && !claimed.has(name)) continue;
    const phase = item.status?.phase ?? '';
    const attachment = attachments.get(name);
    const local = Boolean(item.spec?.local || item.spec?.hostPath);
    const pinned = (item.spec?.nodeAffinity?.required?.nodeSelectorTerms ?? [])
      .flatMap((term) => term.matchExpressions ?? [])
      .find((expression) => expression.key === 'kubernetes.io/hostname')?.values?.[0] ?? '';
    const node = add(item, {
      id: idOf('PersistentVolume', '', name),
      kind: 'PersistentVolume',
      name,
      namespace: '',
      status: phase,
      health: phase === 'Bound' || phase === 'Available' ? 'ok' : phase === 'Failed' ? 'bad' : 'warn',
      capacity: item.spec?.capacity?.storage ?? '',
      modes: (item.spec?.accessModes ?? []).join(', '),
      reclaim: item.spec?.persistentVolumeReclaimPolicy ?? '',
      className: item.spec?.storageClassName ?? '',
      driver: item.spec?.csi?.driver ?? '',
      // Where it is plugged in right now — which is not where it lives, unless it is local.
      attachedTo: attachment?.attached ? attachment.node : '',
      local,
      pinnedTo: local ? pinned : '',
    });
    join(node.id, idOf('StorageClass', '', node.className), 'class');
    if (node.attachedTo) join(node.id, idOf('Node', '', node.attachedTo), 'attached');
  }
  for (const item of claimItems) {
    const { name, namespace } = meta(item);
    const phase = item.status?.phase ?? 'Pending';
    const node = add(item, {
      id: idOf('PersistentVolumeClaim', namespace, name),
      kind: 'PersistentVolumeClaim',
      name,
      namespace,
      status: phase,
      health: phase === 'Bound' ? 'ok' : phase === 'Lost' ? 'bad' : 'warn',
      capacity: item.status?.capacity?.storage ?? item.spec?.resources?.requests?.storage ?? '',
      modes: (item.spec?.accessModes ?? []).join(', '),
      className: item.spec?.storageClassName ?? '',
      volume: item.spec?.volumeName ?? '',
    });
    const volumeId = idOf('PersistentVolume', '', node.volume);
    if (byId.has(volumeId)) join(node.id, volumeId, 'binds');
    // Not bound yet, or bound to a volume this person may not list: the class is still known.
    else join(node.id, idOf('StorageClass', '', node.className), 'class');
  }
  for (const { pod, node } of [...podsByNamespace.values()].flat()) {
    for (const volume of pod.spec?.volumes ?? []) {
      const claim = volume.persistentVolumeClaim?.claimName;
      if (claim) join(node.id, idOf('PersistentVolumeClaim', node.namespace, claim), 'mounts');
    }
  }

  /* ---- network --------------------------------------------------------- */
  const serviceIds = new Set();
  const routedBy = new Map();
  for (const item of all('services')) {
    const { name, namespace } = meta(item);
    const type = item.spec?.type ?? 'ClusterIP';
    const ports = (item.spec?.ports ?? []).map((port) => port.port).filter(Boolean);
    const service = add(item, {
      id: idOf('Service', namespace, name),
      kind: 'Service',
      name,
      namespace,
      status: `${item.spec?.clusterIP === 'None' ? 'Headless' : type}${ports.length ? ` · ${ports.slice(0, 3).join(', ')}` : ''}`,
      health: 'ok',
      ports,
    });
    serviceIds.add(service.id);
    const selector = item.spec?.selector;
    // No selector is somebody routing by hand, and not a mistake; a selector that finds nothing usually is.
    service.selects = null;
    if (!selector || !Object.keys(selector).length) continue;
    service.selects = 0;
    for (const { pod, node } of podsByNamespace.get(namespace) ?? []) {
      if (!matches(selector, pod.metadata?.labels)) continue;
      service.selects += 1;
      const target = node.owner || node.id;
      join(service.id, target, 'routes');
      if (!routedBy.has(target)) routedBy.set(target, new Set());
      routedBy.get(target).add(service.id);
    }
  }
  for (const item of all('ingresses')) {
    const { name, namespace } = meta(item);
    const hosts = (item.spec?.rules ?? []).map((rule) => rule.host).filter(Boolean);
    const ingress = add(item, {
      id: idOf('Ingress', namespace, name),
      kind: 'Ingress',
      name,
      namespace,
      status: hosts[0] ? (hosts.length > 1 ? `${hosts[0]} +${hosts.length - 1}` : hosts[0]) : item.spec?.ingressClassName ?? '',
      health: 'ok',
      hosts,
    });
    const backends = [
      item.spec?.defaultBackend?.service?.name,
      ...(item.spec?.rules ?? []).flatMap((rule) => (rule.http?.paths ?? []).map((path) => path.backend?.service?.name)),
    ].filter(Boolean);
    for (const backend of backends) join(ingress.id, idOf('Service', namespace, backend), 'exposes');
  }
  for (const item of all('policies')) {
    const { name, namespace } = meta(item);
    const selector = item.spec?.podSelector?.matchLabels ?? {};
    const everyone = !Object.keys(selector).length && !(item.spec?.podSelector?.matchExpressions ?? []).length;
    const policy = add(item, {
      id: idOf('NetworkPolicy', namespace, name),
      kind: 'NetworkPolicy',
      name,
      namespace,
      status: everyone ? 'every pod in the namespace' : (item.spec?.policyTypes ?? []).join(', '),
      health: 'ok',
    });
    for (const { node, templateLabels } of workloadNodes) {
      if (node.namespace !== namespace) continue;
      if (everyone || matches(selector, templateLabels)) join(policy.id, node.id, 'policy');
    }
  }

  /* ---- what is only inferred ------------------------------------------- */
  for (const { node, template } of workloadNodes) {
    const own = routedBy.get(node.id) ?? new Set();
    for (const [serviceId, via] of servicesNamedIn(template, node.namespace, serviceIds)) {
      // A StatefulSet naming its own headless service is describing itself.
      if (own.has(serviceId)) continue;
      join(node.id, serviceId, 'uses', { source: 'inferred', via });
    }
  }

  const namespaces = [...new Set(nodes.map((node) => node.namespace).filter(Boolean))]
    .sort()
    .map((name) => ({ name, system: SYSTEM_NAMESPACE.test(name) }));

  /*
   * What the cluster is complaining about, put on the thing it is complaining
   * about. An event names its object, so this is the API's own statement; an
   * autoscaler's complaint goes on the workload it scales, which it also names.
   * Only a count and the latest words — the events themselves are the pane's.
   */
  const scaledBy = new Map();
  for (const hpa of hpas) {
    const target = hpa.spec?.scaleTargetRef;
    if (target?.kind && target?.name) scaledBy.set(`${hpa.metadata?.namespace ?? ''}/${hpa.metadata?.name ?? ''}`, idOf(target.kind, hpa.metadata?.namespace, target.name));
  }
  for (const event of all('warnings')) {
    const about = event.involvedObject ?? event.regarding ?? {};
    if (!about.kind || !about.name) continue;
    const namespace = about.kind === 'Node' ? '' : about.namespace ?? event.metadata?.namespace ?? '';
    const id = about.kind === 'HorizontalPodAutoscaler'
      ? scaledBy.get(`${namespace}/${about.name}`)
      : idOf(about.kind, namespace, about.name);
    const node = id ? byId.get(id) : null;
    if (!node) continue;
    const at = event.lastTimestamp || event.eventTime || event.metadata?.creationTimestamp || '';
    node.warnings = (node.warnings ?? 0) + 1;
    if (!node.warnedAt || at > node.warnedAt) {
      node.warnedAt = at;
      node.warning = `${event.reason ?? 'Warning'}: ${String(event.message ?? '').trim().slice(0, 180)}`;
    }
  }

  // A workload's card is what is on screen when its pods are folded into it: their complaints are counted there too.
  for (const pod of nodes) {
    if (pod.kind !== 'Pod' || !pod.warnings || !pod.owner) continue;
    const owner = byId.get(pod.owner);
    if (!owner) continue;
    owner.podWarnings = (owner.podWarnings ?? 0) + pod.warnings;
    if (!owner.warning) owner.warning = `${pod.name}: ${pod.warning}`;
  }

  return {
    nodes,
    edges,
    namespaces,
    findings: findingsFrom(nodes, edges),
    metrics: Object.keys(usage.pods ?? {}).length > 0 || Object.keys(usage.nodes ?? {}).length > 0,
    scoped: Boolean(lists.scoped),
    at: now,
  };
}

/**
 * What is fragile about each replicated workload, and what is already broken.
 *
 * Reasoned from placement alone — which node, which zone, which storage class —
 * and worded as that. It does not know whether a database has quorum; it knows
 * that all three of its pods would go with one zone.
 */
function findingsFrom(nodes, edges) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  // Indexed once: asked per workload and per pod, a scan of every edge each time is what makes a large cluster slow.
  const out = new Map();
  for (const edge of edges) {
    const key = `${edge.type}>${edge.from}`;
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(edge.to);
  }
  const to = (from, type) => (out.get(`${type}>${from}`) ?? []).map((id) => byId.get(id)).filter(Boolean);
  const findings = {};

  for (const workload of nodes) {
    if (workload.kind !== 'Deployment' && workload.kind !== 'StatefulSet' && !workload.custom) continue;
    const list = [];
    const pods = to(workload.id, 'owns').filter((node) => node.kind === 'Pod');
    for (const pod of pods) {
      if (pod.health !== 'bad') continue;
      list.push({
        level: 'now',
        title: `${pod.name} is ${pod.status}`,
        text: `${pod.restarts} restart${pod.restarts === 1 ? '' : 's'}${pod.lastEnd ? `, last ended ${pod.lastEnd}` : ''}.`,
        source: 'API · pod status',
        ids: [pod.id],
      });
    }
    const machines = [...new Set(pods.map((pod) => pod.node).filter(Boolean))].map((name) => byId.get(`Node//${name}`)).filter(Boolean);
    const claims = pods.flatMap((pod) => to(pod.id, 'mounts'));
    const volumes = claims.flatMap((claim) => to(claim.id, 'binds'));
    const replicated = workload.desired >= 2 && pods.length >= 2;

    if (replicated) {
      if (machines.length === 1) {
        list.push({
          level: 'spof',
          title: `All ${pods.length} replicas are on one node`,
          text: `${machines[0].name} carries every one of them.`,
          source: 'API · pod placement',
          ids: [machines[0].id],
        });
      }
      const zones = [...new Set(machines.map((machine) => machine.zone))];
      if (machines.length > 1 && zones.length === 1 && zones[0]) {
        list.push({
          level: 'spof',
          title: `All ${pods.length} replicas are in one ${machines[0].zoneKind}`,
          text: `Every node they run on is labelled ${zones[0]}.`,
          source: 'API · node labels',
          ids: machines.map((machine) => machine.id),
        });
      }
      const classes = [...new Set(volumes.map((volume) => volume.className).filter(Boolean))];
      if (volumes.length > 1 && classes.length === 1) {
        list.push({
          level: 'spof',
          title: `All ${volumes.length} volumes are on one storage class`,
          text: `${classes[0]} provisions every replica's disk. Normal for a single-provider cluster; worth knowing.`,
          source: 'API · volumes, storage class',
          ids: [`StorageClass//${classes[0]}`],
        });
      }
      if (!workload.pdb) {
        list.push({
          level: 'risk',
          title: 'No PodDisruptionBudget covers it',
          text: 'Draining nodes can take several replicas down together.',
          source: 'API · no matching PDB',
          ids: [],
        });
      }
      if (!workload.spread) {
        list.push({
          level: 'risk',
          title: 'Nothing keeps replicas on different nodes',
          text: 'No anti-affinity and no topology spread: the scheduler may put them together.',
          source: 'API · pod template',
          ids: [],
        });
      } else if (workload.spread.mode === 'preferred') {
        list.push({
          level: 'risk',
          title: 'Spreading is preferred, not required',
          text: 'The scheduler may still place two replicas together when the cluster is tight.',
          source: 'API · pod template',
          ids: [],
        });
      }
    } else if (workload.desired === 1 && (workload.tech || claims.length)) {
      list.push({
        level: 'risk',
        title: 'A single replica',
        text: 'There is no second copy running: it is down while its one pod restarts or moves.',
        source: 'API · replicas',
        ids: [],
      });
    }
    if (workload.hpa && (workload.hpaOn ?? []).includes('cpu') && (workload.unrequested ?? []).length) {
      list.push({
        level: 'now',
        title: 'Its autoscaler cannot measure it',
        text: `The autoscaler ${workload.hpa} scales on CPU as a share of what is requested, and the ` +
          `container${workload.unrequested.length === 1 ? '' : 's'} ${workload.unrequested.join(', ')} ` +
          `request${workload.unrequested.length === 1 ? 's' : ''} none. It stays at the number it has; set a CPU request.`,
        source: 'API · autoscaler, container requests',
        ids: [],
      });
    }
    if (workload.pdb && workload.pdbAllowed === 0 && workload.desired > 0) {
      list.push({
        level: 'risk',
        title: 'Its PodDisruptionBudget allows no disruption right now',
        text: `${workload.pdb} will not let a single pod go: draining any node it runs on waits until that changes.`,
        source: 'API · PDB status',
        ids: [],
      });
    }
    for (const volume of volumes.filter((entry) => entry.local)) {
      list.push({
        level: 'risk',
        title: `${volume.name} is a local volume`,
        text: `Its data is on ${volume.pinnedTo || 'one node'} and does not follow the pod.`,
        source: 'API · volume',
        ids: [volume.id],
      });
    }
    if (list.length) findings[workload.id] = list;
  }
  return findings;
}

/* --------------------------------------------------------------------------
 * Changing the infrastructure, as a brief for Claude.
 *
 * Making a node group, moving a pool onto other machines, taking one away:
 * these are not one command. They are a change to whatever defines the node
 * groups — Terraform, here — followed by a wait, a cordon, a drain that has to
 * respect what is running, and a check, with a person agreeing to each step.
 * So the map does not run them. It says exactly what is being asked and exactly
 * what stands on the machines in question, and hands that to a session that
 * does the work in the open.
 *
 * Composed here and not in the panel, for the reason `brief` gives: the panel
 * names an operation and a pool; the facts are read from the cluster again and
 * worded by the app. What the person typed is cut to one line, stripped of
 * anything that could pass for markup, and quoted as theirs.
 * ------------------------------------------------------------------------ */

const PLAN_OPS = ['new', 'migrate', 'resize', 'remove', 'review', 'ask'];

/** Something a person typed, as one harmless line. */
function said(value, max = 80) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/[`<>]/g, '').trim().slice(0, max);
}

function count(value) {
  if (value === '' || value == null) return null;
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number >= 0 && number <= 5000 ? number : null;
}

const cores = (m) => (m >= 1000 ? `${Math.round(m / 100) / 10} CPU` : `${m}m CPU`);
const gigs = (b) => (b >= 1024 ** 3 ? `${Math.round((b / 1024 ** 3) * 10) / 10}Gi` : `${Math.round(b / 1024 ** 2)}Mi`);
const share = (part, whole) => (whole ? `${Math.round((part / whole) * 100)}%` : 'n/a');

/** What is on a pool, and what about it makes moving it delicate. */
function poolFacts(graph, pool) {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const machines = graph.nodes.filter((node) => node.kind === 'Node' && node.pool === pool);
  const names = new Set(machines.map((node) => node.name));
  const pods = graph.nodes.filter((node) => node.kind === 'Pod' && !node.finished);
  const here = pods.filter((pod) => names.has(pod.node));
  const mounts = new Map();
  for (const edge of graph.edges) {
    if (edge.type !== 'mounts' && edge.type !== 'binds') continue;
    if (!mounts.has(edge.from)) mounts.set(edge.from, []);
    mounts.get(edge.from).push(edge.to);
  }
  const volumesOf = (pod) => (mounts.get(pod.id) ?? []).flatMap((claim) => mounts.get(claim) ?? []).map((id) => byId.get(id)).filter(Boolean);

  const groups = new Map();
  const loose = [];
  for (const pod of here) {
    const owner = byId.get(pod.owner);
    if (!owner) { if (!pod.mirror) loose.push(pod); continue; }
    if (owner.kind === 'DaemonSet') continue;
    if (!groups.has(owner.id)) groups.set(owner.id, { owner, here: [], volumes: [] });
    groups.get(owner.id).here.push(pod);
    groups.get(owner.id).volumes.push(...volumesOf(pod));
  }
  const workloads = [...groups.values()].map((group) => {
    const all = pods.filter((pod) => pod.owner === group.owner.id);
    return { ...group, total: all.length, elsewhere: all.length - group.here.length };
  }).sort((a, b) => a.owner.namespace.localeCompare(b.owner.namespace) || a.owner.name.localeCompare(b.owner.name));

  const held = here.filter((pod) => byId.get(pod.owner)?.kind !== 'DaemonSet');
  return {
    machines,
    workloads,
    loose,
    cpu: held.reduce((sum, pod) => sum + pod.cpuReq, 0),
    memory: held.reduce((sum, pod) => sum + pod.memReq, 0),
    zones: [...new Set(machines.map((node) => node.zone).filter(Boolean))].sort(),
    types: [...new Set(machines.map((node) => node.instance).filter(Boolean))].sort(),
    volumes: workloads.flatMap((entry) => entry.volumes),
  };
}

/**
 * The brief. `request` is what the panel asked for; everything else is read
 * off the graph.
 */
function planFrom(graph, request = {}, context = '') {
  const op = PLAN_OPS.includes(request.op) ? request.op : 'ask';
  const pools = [...new Set(graph.nodes.filter((node) => node.kind === 'Node').map((node) => node.pool))];
  const pool = pools.includes(request.pool) ? request.pool : '';
  if ((op === 'migrate' || op === 'resize' || op === 'remove') && !pool) {
    return { ok: false, error: `There is no node pool called "${said(request.pool)}" in this cluster.` };
  }
  const viaCli = request.via === 'cli';
  const name = said(request.name, 63);
  const machine = said(request.machine, 40);
  const sizes = { min: count(request.min), desired: count(request.desired), max: count(request.max) };
  const sized = ['min', 'desired', 'max'].filter((key) => sizes[key] != null).map((key) => `${key} ${sizes[key]}`).join(', ');
  const note = said(request.question, 600);
  const machines = graph.nodes.filter((node) => node.kind === 'Node');
  const provider = machines.find((node) => node.provider)?.provider ?? '';
  const karpenter = machines.some((node) => node.poolKind === 'karpenter') ||
    graph.nodes.some((node) => node.kind === 'Deployment' && node.name === 'karpenter');
  const cluster = context || 'this cluster';
  const facts = pool ? poolFacts(graph, pool) : null;
  const lines = [];
  const say = (...text) => lines.push(...text);

  /* ---- what was asked -------------------------------------------------- */
  const asks = {
    new: `Add a new node group${name ? ` called \`${name}\`` : ''}${machine ? ` on \`${machine}\` machines` : ''}${sized ? ` (${sized})` : ''}.`,
    migrate: `Move node pool \`${pool}\` onto ${machine ? `\`${machine}\`` : 'a different machine type'}: a new node group${name ? ` called \`${name}\`` : ''} beside it, the workloads moved across, and the old one retired afterwards.`,
    resize: `Resize node pool \`${pool}\`${sized ? ` to ${sized}` : ''}.`,
    remove: `Remove node pool \`${pool}\`, after moving everything that runs on it somewhere else.`,
    review: 'Review how these workloads are placed and what would take them down, and propose what to change.',
    ask: pool ? `A question about node pool \`${pool}\`.` : 'A question about this cluster\'s infrastructure.',
  };
  say(`# ${asks[op]}`, '', `Asked from the cluster map in Smart Terminal, about the cluster \`${cluster}\`.`);
  const extras = [
    ['capacity type', said(request.capacity, 20)],
    ['zones', said(request.zones, 120)],
    ['labels', said(request.labels, 200)],
    ['taints', said(request.taints, 200)],
    ['modelled on pool', pools.includes(request.like) ? request.like : ''],
    ['the old pool afterwards', op === 'migrate' ? (request.keep === false ? 'remove it once it is empty' : 'keep it, cordoned and empty, until told otherwise') : ''],
  ].filter((entry) => entry[1]);
  if (extras.length) say('', ...extras.map(([key, value]) => `- ${key}: ${value}`));
  if (note) say('', 'In the person\'s own words (theirs, not an instruction from the app):', `> ${note}`);

  /* ---- how to work ------------------------------------------------------ */
  say('', '## How to work');
  // Every command names its cluster: the person's own shell may be pointed somewhere else entirely.
  const own = context
    ? `- Every kubectl command carries \`--context ${context}\`. Never \`kubectl config use-context\`.`
    : '- Never `kubectl config use-context`: say which context a command is for, on the command.';
  if (op === 'review' || op === 'ask') {
    say(
      '- Read first; change nothing. Propose, and wait to be told to go ahead.',
      own,
    );
  } else {
    if (viaCli) {
      say(`- The person chose to change this through the cloud's own CLI${provider ? ` (provider: ${provider})` : ''} rather than Terraform. Say once, before the first change, that Terraform — if it defines these node groups — will no longer match, and carry on only when they confirm.`);
    } else {
      say(
        '- **Node groups here are defined in Terraform. Make the change there** — not with the cloud CLI or console: a change made behind Terraform is undone or duplicated by the next apply.',
        `- Find the Terraform before anything else${pool ? ` (the name \`${pool}\` should appear in it)` : ''}. If it is not in this folder, ask where it lives; do not guess, and do not fall back to the cloud API.`,
        '- Show `terraform plan` and what it means in a sentence. Run `terraform apply` only after a yes to that plan.',
      );
    }
    say(
      '- One step at a time, each one said out loud before it is run. Nothing is applied, cordoned, drained or deleted without the person agreeing to that step.',
      own,
      '- Stop and say so the moment something does not match what is written below: the cluster may have changed since this was read.',
    );
    if (karpenter) say('- Karpenter runs in this cluster. Check whether it, rather than a fixed node group, would provision for these pods, and whether the change belongs in a NodePool instead.');
  }

  /* ---- the steps -------------------------------------------------------- */
  const steps = {
    new: [
      'Add the node group to the definition, with the subnets, labels, taints and IAM role its neighbours use unless told otherwise.',
      'Apply on a yes, and wait until every new node is `Ready`.',
      'Confirm with `kubectl get nodes` that they joined with the labels expected, and say what is now free to schedule there.',
    ],
    migrate: [
      'Add the new node group beside the old one: same subnets and zones, same labels and taints, the new machine type, and room for everything listed under "What runs on it".',
      'Apply on a yes, and wait until every new node is `Ready`.',
      `Cordon every node of \`${pool}\`, so nothing new lands on it.`,
      'Drain its nodes one at a time (`kubectl drain --ignore-daemonsets --delete-emptydir-data`), watching each workload below come back `Ready` on the new nodes before the next node. A disruption budget that blocks is a reason to stop and ask, never to force.',
      'When the old pool runs only DaemonSets, show that, and check the workloads are healthy.',
      request.keep === false
        ? `Only then, and on a separate yes, remove \`${pool}\` from the definition and apply.`
        : `Leave \`${pool}\` in place, cordoned and empty. Removing it is a separate request.`,
    ],
    resize: [
      'Change the group\'s size in the definition and show the plan.',
      'Shrinking: say which nodes will go and what runs on them; cordon and drain those first, one at a time, rather than letting the group terminate them under running pods.',
      'Apply on a yes, then confirm the node count and that nothing is left Pending.',
    ],
    remove: [
      'Check that everything under "What runs on it" has somewhere to go: enough room in the other pools, matching labels and tolerations, and volumes in the same zone.',
      `Cordon every node of \`${pool}\`.`,
      'Drain its nodes one at a time, watching each workload come back `Ready` elsewhere. A disruption budget that blocks is a reason to stop and ask.',
      'Only when it runs nothing but DaemonSets, and on a separate yes, remove it from the definition and apply.',
    ],
  };
  if (steps[op]) say('', '## The steps', ...steps[op].map((step, at) => `${at + 1}. ${step}`));

  /* ---- what the map knows ----------------------------------------------- */
  say('', '## What the cluster says right now', '', `Read from the Kubernetes API a moment ago${provider ? `; the nodes are on ${provider}` : ''}.`);
  if (facts) {
    say('', `### Node pool \`${pool}\``, '');
    for (const node of facts.machines) {
      say(`- ${node.name} — ${[node.instance, node.capacity, node.zone, node.status].filter(Boolean).join(', ')}; requested ${share(node.cpuReq, node.cpuAlloc)} CPU, ${share(node.memReq, node.memAlloc)} memory`);
    }
    const taints = [...new Set(facts.machines.flatMap((node) => node.taintList ?? []))];
    if (taints.length) say('', `Taints on it: ${taints.map((taint) => `\`${taint}\``).join(', ')}. Whatever replaces these nodes needs the same, or pods that were kept off will arrive and pods that tolerate them will have nowhere to go.`);
    say('', `Its pods ask for ${cores(facts.cpu)} and ${gigs(facts.memory)} in total, DaemonSets aside: that is the room a replacement needs.`);
    if (facts.zones.length) say(`Zones: ${facts.zones.join(', ')}. Cloud block volumes cannot leave their zone, so nodes that take over a pod with a volume must be in the same one.`);

    say('', '### What runs on it', '');
    if (!facts.workloads.length && !facts.loose.length) say('Nothing but DaemonSets.');
    for (const entry of facts.workloads) {
      const owner = entry.owner;
      const flags = [];
      if (entry.total === 1) flags.push('**single replica: it is down while its pod moves**');
      else if (entry.elsewhere === 0) flags.push('**every replica is on this pool**');
      if (entry.total > 1 && !owner.pdb) flags.push('no PodDisruptionBudget');
      if (owner.pdb && owner.pdbAllowed === 0) flags.push(`**PDB \`${owner.pdb}\` allows no disruption right now: a drain will wait on it**`);
      else if (owner.pdb) flags.push(`PDB \`${owner.pdb}\``);
      if (owner.custom) flags.push(`made by an operator, from a ${owner.kind}: change it through that resource, not through its pods`);
      const disks = entry.volumes;
      if (disks.length) flags.push(`${disks.length} volume${disks.length === 1 ? '' : 's'} (${[...new Set(disks.map((disk) => disk.className || 'no class'))].join(', ')})`);
      if (disks.some((disk) => disk.local)) flags.push('**local volume: its data stays on the node**');
      say(`- ${owner.namespace}/${owner.name} (${owner.kind}${owner.tech ? `, ${owner.tech}` : ''}) — ${entry.here.length} of ${entry.total} pods here${flags.length ? `; ${flags.join('; ')}` : ''}`);
    }
    for (const pod of facts.loose) say(`- ${pod.namespace}/${pod.name} — **a pod nothing owns: once evicted it does not come back**`);
  }

  if (op === 'review' || (op === 'ask' && !pool)) {
    const wanted = Array.isArray(request.workloads) ? new Set(request.workloads.map(String)) : null;
    const chosen = graph.nodes.filter((node) => wanted?.has(node.id) && (node.kind === 'Deployment' || node.kind === 'StatefulSet' || node.kind === 'DaemonSet' || node.custom));
    if (chosen.length) {
      say('', '### The workloads in question', '');
      for (const workload of chosen.slice(0, 40)) {
        say(`- ${workload.namespace}/${workload.name} (${workload.kind}${workload.tech ? `, ${workload.tech}` : ''}) — ${workload.status}`);
        for (const finding of graph.findings?.[workload.id] ?? []) say(`  - ${finding.level === 'now' ? 'now' : finding.level === 'spof' ? 'single point of failure' : 'risk'}: ${finding.title}. ${finding.text}`);
      }
      if (chosen.length > 40) say(`- and ${chosen.length - 40} more`);
    }
  }

  const waiting = graph.nodes.filter((node) => node.kind === 'Pod' && !node.node && !node.finished);
  if (waiting.length) {
    say('', `${waiting.length} pod${waiting.length === 1 ? ' is' : 's are'} not scheduled right now: ${waiting.slice(0, 5).map((pod) => `${pod.namespace}/${pod.name}`).join(', ')}${waiting.length > 5 ? ' and more' : ''}. Find out why before taking room away.`);
  }

  say('', '### The node pools', '');
  for (const other of pools.sort()) {
    const info = poolFacts(graph, other);
    const alloc = info.machines.reduce((sum, node) => sum + node.cpuAlloc, 0);
    const asked = info.machines.reduce((sum, node) => sum + node.cpuReq, 0);
    const kind = info.machines[0]?.poolKind;
    say(`- ${other || '(no pool label)'} — ${info.machines.length} node${info.machines.length === 1 ? '' : 's'}, ${info.types.join('/') || 'unknown type'}, ${info.zones.join('/') || 'no zone label'}${kind ? `, ${kind}` : ''}; ${share(asked, alloc)} of its CPU requested`);
  }

  const titles = { new: 'new node group', migrate: `migrate ${pool}`, resize: `resize ${pool}`, remove: `remove ${pool}`, review: 'review placement', ask: pool ? `ask ${pool}` : 'ask infra' };
  return { ok: true, title: titles[op], text: lines.join('\n') };
}

module.exports = { planFrom, poolFacts, graphFrom, findingsFrom, techOf, imageParts, servicesNamedIn, SYSTEM_NAMESPACE };
