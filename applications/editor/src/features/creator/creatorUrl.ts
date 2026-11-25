/**
 * Where Cleo Creator is. On this origin at /creator/ in dev and in the desktop app; the web build names the
 * Creator's own site (VITE_CLEO_CREATOR_URL), which reaches this origin's library through its storage frame
 * (creatorLibraryFrame.ts). Either way what it saves lands in the shared Creator library.
 */
export function creatorUrl(host: { dev: boolean; desktop: boolean; url?: string }): string {
  return host.dev || host.desktop || !host.url ? '/creator/' : host.url
}
