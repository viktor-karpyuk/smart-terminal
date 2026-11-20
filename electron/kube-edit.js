/**
 * What an edit of a manifest needs that reading one does not.
 *
 * Pure, so it can be tested without a cluster: text in, text out.
 */

/** Fields the cluster writes and nobody edits: left in, they are sent back as if they were meant. */
const SERVER_METADATA = ['resourceVersion', 'uid', 'creationTimestamp', 'generation', 'selfLink', 'managedFields'];
const SERVER_ANNOTATIONS = [
  'kubectl.kubernetes.io/last-applied-configuration',
  'deployment.kubernetes.io/revision',
];

const indentOf = (line) => line.length - line.trimStart().length;

/**
 * A manifest as somebody would write it, from one as `kubectl get -o yaml` prints it.
 *
 * The printed one carries `status`, which is the cluster's to say, and a
 * `resourceVersion` that goes stale every time a controller touches the object
 * — on a Deployment that is every few seconds, and applying it back is refused
 * with "the object has been modified". The panel checks for a change underneath
 * the edit itself, by comparing what was read with what is there now, which
 * says *what* changed rather than only that something did.
 *
 * By line and not by parsing: kubectl prints top-level keys at column 0 and
 * metadata's children at two spaces, always, and a line filter cannot reformat
 * a block scalar or reorder a key the way a parse-and-print would.
 */
function editableYaml(text) {
  const lines = String(text ?? '').split('\n');
  const out = [];
  let section = '';
  let inAnnotations = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const indent = indentOf(line);
    const blank = !line.trim();

    if (!blank && indent === 0) {
      section = /^([A-Za-z]+):/.exec(line)?.[1] ?? '';
      inAnnotations = false;
      if (section === 'status') { i = skipBlock(lines, i, 0); continue; }
    }

    if (section === 'metadata' && !blank && indent === 2 && !line.startsWith('  - ')) {
      const key = /^ {2}([A-Za-z]+):/.exec(line)?.[1] ?? '';
      inAnnotations = key === 'annotations';
      if (SERVER_METADATA.includes(key)) { i = skipBlock(lines, i, 2); continue; }
    }

    if (section === 'metadata' && inAnnotations && !blank && indent === 4) {
      const key = /^ {4}["']?([^"':\s]+)["']?:/.exec(line)?.[1] ?? '';
      if (SERVER_ANNOTATIONS.includes(key)) { i = skipBlock(lines, i, 4); continue; }
    }

    out.push(line);
  }

  // Annotations that held only the cluster's own are now a key with nothing under it, which YAML reads as null.
  for (let i = out.length - 1; i >= 0; i -= 1) {
    if (out[i] !== '  annotations:') continue;
    const next = out[i + 1];
    if (next === undefined || indentOf(next) <= 2) out.splice(i, 1);
  }
  return out.join('\n');
}

/** The index of the last line belonging to the block that starts at `from`. */
function skipBlock(lines, from, indent) {
  let at = from;
  for (let i = from + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) {
      // A blank line inside a block scalar belongs to it; one before the next key does not.
      const after = lines.slice(i + 1).find((later) => later.trim());
      if (after !== undefined && indentOf(after) > indent) { at = i; continue; }
      break;
    }
    const deeper = indentOf(line) > indent;
    // A list is printed at its key's own indent: `managedFields:` then `- apiVersion`.
    const listItem = indentOf(line) === indent && line.trimStart().startsWith('- ');
    if (!deeper && !listItem) break;
    at = i;
  }
  return at;
}

/** Kinds a workload makes and names after itself. */
const NAMED_AFTER = ['Pod', 'ReplicaSet', 'Job', 'ControllerRevision', 'PersistentVolumeClaim'];

/**
 * Kinds that are put beside a workload under its own name. On a real cluster
 * the warnings about a Deployment turned out to be its autoscaler's — "missing
 * request for cpu", 2400 times — and an Events tab that left them out was
 * saying nothing was wrong.
 */
const NAMED_THE_SAME = ['HorizontalPodAutoscaler', 'PodDisruptionBudget', 'Service', 'Ingress'];

/**
 * The events about an object, and about what it made.
 *
 * A Deployment's own events say "scaled up replica set"; the ones that say why
 * it is not working — FailedScheduling, BackOff, FailedMount — are about its
 * pods. Those are found by name, `web` owning `web-7d9f-abc12`, which is a
 * convention rather than a statement by the API: every such row is marked, so
 * the panel can say it was worked out.
 */
function eventsAbout(rows, kind, name) {
  const prefix = `${name}-`;
  const out = [];
  for (const row of rows ?? []) {
    if (row.objectKind === kind && row.objectName === name) out.push(row);
    else if (
      (NAMED_AFTER.includes(row.objectKind) && String(row.objectName).startsWith(prefix)) ||
      (NAMED_THE_SAME.includes(row.objectKind) && row.objectKind !== kind && row.objectName === name)
    ) {
      out.push({ ...row, related: true });
    }
  }
  return out;
}

module.exports = { editableYaml, eventsAbout };
