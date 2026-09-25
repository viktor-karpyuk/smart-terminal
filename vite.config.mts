import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/*
 * `frame-src panel:` is the one thing the app may frame that is not itself.
 *
 * A view an extension brings is served over the `panel:` scheme so that it is
 * its own document with its own policy — a `srcdoc` frame inherits this one,
 * and under `script-src 'self'` that meant every panel rendered its static HTML
 * and nothing else, in the packaged app only, because development has no CSP at
 * all. Naming the scheme here is what lets the app host those frames while
 * still saying it loads nothing else from anywhere.
 */
/*
 * `worker-src blob:` is what lets an extension's renderer run at all.
 *
 * A preview's code runs in a worker built from a blob (src/lib/extensionRender.ts).
 * With no `worker-src`, the browser falls back to `script-src 'self'`, which a
 * blob: URL is not — so in the packaged app every extension preview was refused
 * before its first line, while development, which has no policy, showed them
 * working. Only the app itself makes those blobs. A worker made from one takes
 * this document's policy with it, so `connect-src 'none'` still keeps it off the
 * network.
 */
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; font-src 'self' data:; connect-src 'none'; worker-src blob:; frame-src panel:";

/**
 * The production bundle is fully local, so it gets a strict policy. Dev is left
 * alone because Vite injects an inline react-refresh preamble that 'self' blocks.
 */
function contentSecurityPolicy() {
  return {
    name: 'inject-csp',
    apply: 'build' as const,
    transformIndexHtml(html: string) {
      return html.replace(
        '<head>',
        `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
      );
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [react(), contentSecurityPolicy()],
  server: { port: 5173, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true, target: 'chrome120' },
});
