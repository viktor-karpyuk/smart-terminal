import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; font-src 'self' data:; connect-src 'none'";

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
