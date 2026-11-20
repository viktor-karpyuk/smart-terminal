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
      // A zone when the cloud names one; otherwise the region is as fine as placement gets.
      zone: zone || region,
      zoneKind: zone ? 'zone' : region ? 'region' : '',
      instance: labels['node.kubernetes.io/instance-type'] ?? '',
      version: item.status?.nodeInfo?.kubeletVersion ?? '',
      taints: (item.spec?.taints ?? []).length,
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
    const node = add(item, {
      id: idOf(item.kind, namespace, name),
      kind: item.kind,
      name,
      namespace,
      ...state,
      images,
      cpuReq: requests.cpu,
      memReq: requests.memory,
      cpuLim: limits.cpu,
      memLim: limits.memory,
      spread: spreadOf(template),
      pdb: pdb?.metadata?.name ?? '',
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

  /* ---- pods ------------------------------------------------------------ */
  const podsByNamespace = new Map();
  for (const pod of podItems) {
    const { name, namespace } = meta(pod);
    const statuses = pod.status?.containerStatuses ?? [];
    const status = podStatus(pod);
    const owner = topOwner(pod);
    const ownerId = owner ? idOf(owner.kind, owner.metadata?.namespace, owner.metadata?.name) : '';
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
    });
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
    if (workload.kind !== 'Deployment' && workload.kind !== 'StatefulSet') continue;
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

module.exports = { graphFrom, findingsFrom, techOf, imageParts, servicesNamedIn, SYSTEM_NAMESPACE };
