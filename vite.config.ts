import { defineConfig } from 'vite';

// base './' keeps every asset and data fetch relative, so the same build works
// at https://<user>.github.io/chords/ and at any other mount point.
export default defineConfig({
  base: './',
  build: { outDir: 'dist' },
});
