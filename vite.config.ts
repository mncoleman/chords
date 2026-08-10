import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';

// Which release is on the screen. Deploys here are a manual wrangler push and
// the app installs to a home screen with a service worker in front of it, so
// "is this fixed?" and "am I looking at the fix?" are two different questions —
// and without a stamp on the page there is no way to tell them apart.
function buildStamp(): string {
  let rev = 'dev';
  try {
    rev = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
    // A dirty tree is a build nobody can go back to; say so rather than name a
    // commit that does not describe what is running.
    if (execSync('git status --porcelain', { encoding: 'utf8' }).trim()) rev += '+';
  } catch {
    // Built outside a checkout. The date alone still tells the two apart.
  }
  const when = new Date().toISOString().slice(0, 16).replace('T', ' ');
  return `${rev} · ${when} UTC`;
}

// base './' keeps every asset and data fetch relative, so the same build works
// at https://<user>.github.io/chords/ and at any other mount point.
export default defineConfig({
  base: './',
  build: { outDir: 'dist' },
  define: { __BUILD__: JSON.stringify(buildStamp()) },
});
