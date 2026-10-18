import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The screens run in the browser. In development, requests to /v1 are passed on to the API (npm run api), so the
// browser sees one address and no cross-site rules (CORS) are needed.
// The API address can be changed with API_URL (for example when port 3000 is taken).
const api = process.env.API_URL ?? 'http://127.0.0.1:3000';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  server: { port: 5173, proxy: { '/v1': api, '/openapi.json': api } },
  build: { outDir: '../dist-web', emptyOutDir: true },
});
