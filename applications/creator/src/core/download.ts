import type { ExportFile } from './generator';

/** Hand one file to the browser as a download. Web-only for now: there is no desktop shell for Creator. */
export function downloadFile(file: ExportFile): void {
  const url = URL.createObjectURL(new Blob([file.bytes as BlobPart], { type: file.mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked on the next tick: Chromium starts the download synchronously from the click, Firefox not quite.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function downloadAll(files: readonly ExportFile[]): Promise<void> {
  for (const f of files) {
    downloadFile(f);
    // Browsers drop rapid-fire downloads from one gesture; a short gap keeps every file.
    await new Promise(r => setTimeout(r, 150));
  }
}
