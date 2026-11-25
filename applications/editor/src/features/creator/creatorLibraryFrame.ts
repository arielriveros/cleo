// The storage frame's page (creator-library.html): serves this origin's Creator library to Cleo Creator running on
// its own site, which embeds this page hidden (app-kit creatorLibrary/frame.ts has the protocol and why it works).
//
// Only the Creator's own origins may connect: the build's VITE_CLEO_CREATOR_URL (its site), any listed in
// VITE_CLEO_CREATOR_ORIGINS, and in dev the Creator's dev server opened on its own port. firebase.json's
// frame-ancestors keeps any other site from embedding the page at all.

import { serveCreatorFrame } from '@cleo/app-kit/creatorLibrary/frame';

const origins = new Set<string>();
const add = (url: string | undefined) => {
  if (!url) return;
  try { origins.add(new URL(url).origin); } catch { /* not a URL */ }
};
add(import.meta.env.VITE_CLEO_CREATOR_URL);
for (const o of (import.meta.env.VITE_CLEO_CREATOR_ORIGINS ?? '').split(',')) add(o.trim());
if (import.meta.env.DEV) add(`http://localhost:${import.meta.env.VITE_CLEO_CREATOR_PORT ?? 8081}`);

serveCreatorFrame([...origins]);
