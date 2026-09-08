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
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; font-src 'self' data:; connect-src 'none'; frame-src panel:";

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
