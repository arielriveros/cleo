// What the open project's stores tell the project folder (features/projectFolder/folderSink.ts) about
// writes that React state does not carry: scene blobs saved on Save, and the byte payloads of images,
// sounds and bakes. Each store calls this after its own write, for the OPEN project only — a write that
// names a project id explicitly (an import, a folder ingest) is not an edit the folder should follow.
//
// A hub rather than an import of the sink, so these utils stay free of the features that depend on them.

export interface FolderStoreListener {
  texturesPut?(rows: { id: string; blob: Blob; mime: string; config: unknown }[]): void
  texturesDeleted?(ids: string[]): void
  audioPut?(rows: { id: string; blob: Blob; mime: string }[]): void
  audioDeleted?(ids: string[]): void
  bakePut?(id: string, bytes: Uint8Array): void
  bakesDeleted?(ids: string[]): void
  sceneSaved?(id: string, data: unknown): void
  sceneDeleted?(id: string): void
}

let listener: FolderStoreListener | null = null

export function setFolderStoreListener(next: FolderStoreListener | null): void {
  listener = next
}

export function folderStoreListener(): FolderStoreListener | null {
  return listener
}
