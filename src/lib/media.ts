/**
 * Files the app shows as what they are rather than as text: pictures, video,
 * sound and PDFs. Decided by extension, the same way the browser that draws
 * them would, and only for formats Chromium can actually draw. SVG is not here:
 * it is text, and the HTML and SVG extension previews it.
 */
export type MediaKind = 'image' | 'video' | 'audio' | 'pdf';

const BY_EXTENSION: Record<string, MediaKind> = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image',
  ico: 'image', avif: 'image', apng: 'image',
  mp4: 'video', m4v: 'video', webm: 'video', mov: 'video', ogv: 'video', mkv: 'video',
  mp3: 'audio', wav: 'audio', ogg: 'audio', oga: 'audio', m4a: 'audio', aac: 'audio', flac: 'audio', opus: 'audio', weba: 'audio',
  pdf: 'pdf',
};

export function mediaKind(path: string): MediaKind | null {
  const name = path.split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  return BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? null;
}

/** The address the app's own `media:` scheme serves a file at. */
export function mediaUrl(path: string, version: number | string = 0): string {
  return `media://file${path.split('/').map(encodeURIComponent).join('/')}?v=${encodeURIComponent(String(version))}`;
}

export const MEDIA_EXTENSIONS = Object.keys(BY_EXTENSION);
