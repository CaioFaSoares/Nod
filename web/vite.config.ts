// The portal's build (E04 M1): vite over `web/`, out to `host/public` — the directory the host
// serves while `WEB_UI` is on (`host/routes/web.ts`'s map names exactly these files, so the names
// are pinned: no hash, no chunk, one `app.js` and one `style.css`).
//
// The page shares the app's models (`shared/library.ts`) and views (`shared/library.css`), and the
// same derivation the app's backend runs (`shared/auth.ts`) — the imports here are the whole
// "cannot drift" story of RF-79 and RF-75.

import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  build: {
    outDir: '../host/public',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: 'app.js',
        chunkFileNames: 'app.js',
        assetFileNames: 'style.css',
      },
    },
  },
});
