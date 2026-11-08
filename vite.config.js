import { defineConfig } from 'vite';

// The character model lives in the project root and is imported as an asset
// (see src/config.js), so Vite fingerprints and copies it into dist/ on build.
export default defineConfig({
  server: { port: 5174, open: false },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
});
