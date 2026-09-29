'use strict';

/**
 * What the bot understands, and what it may do about it.
 *
 * Pure: an activity and what is known in, a decision out. The four things the
 * bot may do without asking were chosen by the person running it — look at the
 * pull request again, mark a comment resolved, put a reminder off, and fix a
 * finding and push it — and nothing else is on this list.
 *
 * It understands buttons first and a few words second. A button carries exactly
 * what it is about, so there is nothing to misread; a word is only taken when
 * it is one of the few below, and anything else gets the help rather than a
 * guess. Talking freely can come later; acting on a misread sentence is the one
 * failure a bot that pushes commits cannot have.
 */

const ACTIONS = ['rereview', 'resolve', 'snooze', 'fix', 'findings', 'help'];

/** Per conversation per day, and per pull request per day for the ones that cost a run. */
const CAPS = { perConversation: 12, fixesPerPr: 3, reviewsPerPr: 2 };

const DAY = 24 * 60 * 60 * 1000;

/** Teams wraps a mention of the bot in <at>…</at>; that is addressing, not content. */
function plainText(activity) {
  return String(activity?.text ?? '')
    .replace(/<at>[^<]*<\/at>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const fold = (text) => text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/**
 * The command in one activity, or null when there is none.
 * `about` is the pull request this conversation was last about, for words.
 */
function readCommand(activity, about = null) {
  const value = activity?.value;
  if (value && typeof value === 'object' && ACTIONS.includes(value.action)) {
    return {
      action: value.action,
      repoId: value.repoId ? String(value.repoId) : about?.repoId ?? null,
      prId: Number.isFinite(Number(value.prId)) && value.prId !== null && value.prId !== '' ? Number(value.prId) : about?.prId ?? null,
      findingId: value.findingId ? String(value.findingId) : null,
      days: clampDays(value.days),
      from: 'button',
    };
  }

  const text = fold(plainText(activity));
  if (!text) return null;
  const base = { repoId: about?.repoId ?? null, prId: about?.prId ?? null, findingId: null, days: 1, from: 'words' };
  if (/^(ayuda|help|\?|hola|hi|que podes hacer|que puedes hacer)\b/.test(text)) return { ...base, action: 'help' };
  if (/^(volve a revisar|volver a revisar|revisa(lo)?( de nuevo)?|revisar|re-?review|review again)\b/.test(text)) return { ...base, action: 'rereview' };
  const snooze = /^(pospone(lo)?|posponer|snooze|mas tarde|despues)\b\D*(\d+)?/.exec(text);
  if (snooze) return { ...base, action: 'snooze', days: clampDays(snooze[3] ?? 1) };
  // Without a button there is no telling which comment or finding; the answer lists them with buttons.
  if (/^(arregla(lo)?|arreglar|fix|resuelto|resolver|listo|hallazgos|comentarios|findings)\b/.test(text)) {
    return { ...base, action: 'findings' };
  }
  return { ...base, action: 'unknown' };
}

function clampDays(value) {
  const days = Math.round(Number(value));
  return Number.isFinite(days) && days >= 1 ? Math.min(days, 7) : 1;
}

/**
 * Whether the person writing is the author of this pull request.
 *
 * Teams says who is writing by their account; the forge says who wrote the pull
 * request by its own name. The Teams extension already keeps the list that joins
 * the two — a forge handle and the Teams address that was matched to it — so the
 * answer is whether that list joins these two people.
 */
function isAuthor({ senderAddress, people, provider, author }) {
  const address = String(senderAddress ?? '').toLowerCase();
  if (!address || !author) return false;
  const handle = `${String(provider ?? 'forge').toLowerCase()}:${author}`.toLowerCase();
  return people.some((person) => String(person.handle ?? '').toLowerCase() === handle && String(person.address ?? '').toLowerCase() === address);
}

/** How much has been asked today, and whether one more is allowed. */
function withinCaps(counts, { conversation, pr, action }, now = Date.now()) {
  const today = Math.floor(now / DAY);
  const count = (key) => (counts[key]?.day === today ? counts[key].n : 0);
  if (count(`c:${conversation}`) >= CAPS.perConversation) return 'Por hoy ya hicimos bastante en esta conversación. Mañana sigo.';
  if (action === 'fix' && count(`fix:${pr}`) >= CAPS.fixesPerPr) return `Ya subí ${CAPS.fixesPerPr} arreglos a este PR hoy. El resto conviene mirarlo con una persona.`;
  if (action === 'rereview' && count(`review:${pr}`) >= CAPS.reviewsPerPr) return 'Ya revisé este PR dos veces hoy. Si subís algo nuevo, la revisión automática lo va a ver.';
  return null;
}

function countIn(counts, { conversation, pr, action }, now = Date.now()) {
  const today = Math.floor(now / DAY);
  const bump = (key) => {
    counts[key] = counts[key]?.day === today ? { day: today, n: counts[key].n + 1 } : { day: today, n: 1 };
  };
  bump(`c:${conversation}`);
  if (action === 'fix') bump(`fix:${pr}`);
  if (action === 'rereview') bump(`review:${pr}`);
  return counts;
}

const HELP = [
  'Soy el Code Reviewer. Sobre un PR tuyo puedo:',
  '• **volver a revisar** el PR',
  '• **posponer** el recordatorio (por ejemplo "posponer 2")',
  '• mostrarte los **hallazgos**, y en cada uno marcarlo resuelto o arreglarlo y subir el commit',
  'Los botones de mis mensajes hacen lo mismo.',
].join('\n\n');

/** Who may ask for what: everything here needs the author of the pull request. */
const NEEDS_PR = new Set(['rereview', 'resolve', 'snooze', 'fix', 'findings']);

module.exports = { readCommand, isAuthor, withinCaps, countIn, plainText, HELP, NEEDS_PR, CAPS, ACTIONS };
