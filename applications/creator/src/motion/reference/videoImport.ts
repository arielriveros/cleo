// A video file becomes a reference clip in the Creator library (kind 'video', under /Video).
//
// Read with mediabunny (the editor's movie writer's library, which reads as well): the container's size,
// rotation, length, codec and average frame rate, whether the browser can decode it at all (WebCodecs: H.264,
// HEVC where the GPU has it, VP8/9, AV1 -- not ProRes or DNxHD), and whether it has sound. The file is stored
// as it came, the asset's one private file -- no copy in memory, no full hash -- and never written again.

import { ALL_FORMATS, BlobSource, Input } from 'mediabunny';
import { hashChunks, newCreatorAssetId, putCreatorAsset } from '@cleo/app-kit/creatorLibrary';
import { normaliseVideoDoc, snapFrameRate, type VideoAssetDoc } from './videoDoc';

/** File extensions the picker offers (what browsers can usually decode once demuxed). */
export const VIDEO_ACCEPT = '.mp4,.m4v,.mov,.webm,.mkv,video/*';

export const isVideoFile = (name: string) => /\.(mp4|m4v|mov|webm|mkv)$/i.test(name);

/** Open a video for reading. Dispose the input when done. */
export function openVideo(blob: Blob): Input<BlobSource> {
  return new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
}

/** What the library keeps about a clip, read from the file. Throws, in words, when it cannot be used. */
export async function probeVideo(file: Blob, fileName: string): Promise<VideoAssetDoc> {
  const input = openVideo(file);
  try {
    const track = await input.getPrimaryVideoTrack().catch(() => null);
    if (!track) throw new Error('This file has no video the browser can read (try an .mp4 or .webm).');
    if (!(await track.canDecode())) {
      throw new Error(`The browser cannot decode its ${track.codec ?? 'unknown'} video. Re-encode it as H.264 (an ordinary .mp4) or VP9.`);
    }
    const [start, end, stats, audio, mime] = await Promise.all([
      track.getFirstTimestamp(), track.computeDuration(), track.computePacketStats(), input.getPrimaryAudioTrack().catch(() => null),
      input.getMimeType().catch(() => (file.type || 'video/mp4')),
    ]);
    const doc = normaliseVideoDoc({
      version: 1, fileName, mime, sizeBytes: file.size,
      width: track.displayWidth, height: track.displayHeight, rotation: track.rotation,
      duration: Math.max(0, end - start), start, codec: track.codec,
      fps: snapFrameRate(stats.averagePacketRate), frameCount: stats.packetCount,
      vfr: false, hasAudio: !!audio && (await audio.canDecode().catch(() => false)),
    });
    if (!doc) throw new Error('Could not read the video.');
    return doc;
  } finally {
    input.dispose();
  }
}

/** Store a video file as a new reference clip. Returns its library id, name and document. */
export async function importVideo(file: File): Promise<{ id: string; name: string; doc: VideoAssetDoc }> {
  const ext = /\.[^.]+$/.exec(file.name)?.[0]?.toLowerCase() ?? '.mp4';
  const fileName = `source${ext}`;
  const doc = await probeVideo(file, fileName);
  const name = file.name.replace(/\.[^.]+$/, '') || 'Reference';
  const id = newCreatorAssetId('video');
  await putCreatorAsset({
    id, kind: 'video', name, doc, sidecar: null, files: [],
    privateFiles: [{ name: fileName, mime: file.type || doc.mime, blob: file }],
    contentHash: await quickFileHash(file),
  });
  return { id, name, doc };
}

/**
 * The content hash of a large file without reading it all: its name, size and date, and its first and last
 * 64 KB. Enough to tell two clips apart; the file is never rewritten, so the hash only guards the import.
 */
export async function quickFileHash(file: Blob & { name?: string; lastModified?: number }): Promise<string> {
  const head = new Uint8Array(await file.slice(0, 65536).arrayBuffer());
  const tail = new Uint8Array(await file.slice(Math.max(0, file.size - 65536)).arrayBuffer());
  const label = new TextEncoder().encode(`${file.name ?? ''}|${file.size}|${file.lastModified ?? 0}`);
  return hashChunks([label, head, tail]);
}
