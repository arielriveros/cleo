import { useEffect, useMemo, useRef, useState } from 'react';
import {
  creatorChannel, getCreatorFiles, listCreatorAssets, putCreatorFile, type CreatorAssetMeta,
} from '@cleo/app-kit/creatorLibrary';
import { ReferencePlayer } from '../reference/referencePlayer';
import { referenceClient, isAbort } from '../reference/referenceClient';
import type { TimestampsResult } from '../reference/referenceWorker';
import {
  ANALYSIS_FILE, PEAKS_FILE, THUMBS_FILE, packAnalysis, packPeaks, packThumbs, unpackAnalysis, unpackPeaks, unpackThumbs,
  type AudioPeaks, type ThumbStrip,
} from '../reference/referenceCache';
import type { AnalysisResult } from '../reference/cv/analysisJob';
import type { TrackResult } from '../reference/cv/trackJob';
import type { Extremity } from '../reference/cv/silhouette';
import { EMPTY_TRACKS, TRACKS_FILE, normaliseTracks, tracksBlob, type TracksState } from '../reference/tracks';
import type { VideoAssetDoc } from '../reference/videoDoc';

// The Motion Creator's linked reference clip, opened: the player that shows its frames, its frame
// timestamps (read by the worker every time it opens: they are not stored), and the timeline's thumbnails
// and sound peaks (made by the worker once, then kept beside the clip in the library). Also the library's
// clips, for the Reference tab's picker.

export interface ReferenceState {
  videoId: string | null;
  name: string | null;
  video: VideoAssetDoc | null;
  player: ReferencePlayer | null;
  /** Every frame's video time, ascending; null while they are read. */
  timestamps: Float64Array | null;
  vfr: boolean;
  thumbs: { strip: ThumbStrip; urls: string[] } | null;
  peaks: AudioPeaks | null;
  /** What is being done now ("Reading the frames…"), or null. */
  busy: string | null;
  error: string | null;
  /** The library's reference clips, by name. */
  library: CreatorAssetMeta[];
  /** The clip's analysis (Reference ▸ Analysis), once made: kept beside it. */
  analysis: AnalysisResult | null;
  /** Analyze progress (0..1) while it runs, else null. */
  analyzing: number | null;
  analyze: () => Promise<void>;
  cancelAnalysis: () => void;
  /** Reference ▸ Tracking: the clip's tracks and the tracker's last result (kept with the clip). */
  tracks: TracksState;
  setTracks: (next: TracksState) => void;
  /** Tracking progress (0..1) while it runs, else null. */
  tracking: number | null;
  trackAll: () => Promise<void>;
  /** The subject's silhouette's extremities at video time `at` (unit square), the shot spanning `shot`. */
  suggest: (at: number, shot: [number, number]) => Promise<Extremity[]>;
}

const THUMB_HEIGHT = 54;

export function useReference(videoId: string | undefined, proxyWidth: number): ReferenceState {
  const [player, setPlayer] = useState<ReferencePlayer | null>(null);
  const [timestamps, setTimestamps] = useState<TimestampsResult | null>(null);
  const [thumbs, setThumbs] = useState<ThumbStrip | null>(null);
  const [peaks, setPeaks] = useState<AudioPeaks | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [library, setLibrary] = useState<CreatorAssetMeta[]>([]);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [analyzing, setAnalyzing] = useState<number | null>(null);
  const analysisAbort = useRef<AbortController | null>(null);
  const [tracks, setTracksState] = useState<TracksState>(EMPTY_TRACKS);
  const [tracking, setTracking] = useState<number | null>(null);
  const tracksRef = useRef(tracks);
  tracksRef.current = tracks;
  const saveTimer = useRef(0);
  const proxy = useRef(proxyWidth);
  proxy.current = proxyWidth;

  // The library's clips, kept live.
  useEffect(() => {
    let alive = true;
    const read = () => void listCreatorAssets().then(all => {
      if (alive) setLibrary(all.filter(a => a.kind === 'video' && !a.deleted).sort((a, b) => a.name.localeCompare(b.name)));
    });
    read();
    const off = creatorChannel().subscribe(read);
    return () => { alive = false; off(); };
  }, []);

  // The linked clip: its player, then its frames, thumbnails and peaks.
  useEffect(() => {
    setPlayer(null); setTimestamps(null); setThumbs(null); setPeaks(null); setError(null); setBusy(null); setAnalysis(null);
    analysisAbort.current?.abort(); setAnalyzing(null); setTracksState(EMPTY_TRACKS); setTracking(null);
    if (!videoId) return;
    const abort = new AbortController();
    let opened: ReferencePlayer | null = null;
    const step = (label: string | null) => { if (!abort.signal.aborted) setBusy(label); };
    void (async () => {
      try {
        step('Opening the video…');
        opened = await ReferencePlayer.open(videoId, proxy.current || Infinity);
        if (abort.signal.aborted) { opened.dispose(); return; }
        setPlayer(opened);
        const client = referenceClient();
        const blob = opened.blob, doc = opened.doc;
        step('Reading the frames…');
        const ts = await client.run<TimestampsResult>(videoId, blob, { job: 'timestamps' }, { signal: abort.signal });
        setTimestamps(ts);
        // A kept analysis comes back with the clip.
        const [an] = await getCreatorFiles(videoId, [ANALYSIS_FILE]);
        const kept = an ? await unpackAnalysis(an.blob) : null;
        if (kept && !abort.signal.aborted) setAnalysis(kept);
        const [tf] = await getCreatorFiles(videoId, [TRACKS_FILE]);
        if (tf && !abort.signal.aborted) { try { setTracksState(normaliseTracks(JSON.parse(await tf.blob.text()))); } catch { /* a broken file: none */ } }
        // Thumbnails: kept beside the clip once made.
        const [cached] = await getCreatorFiles(videoId, [THUMBS_FILE]);
        let strip = cached ? await unpackThumbs(cached.blob) : null;
        if (!strip) {
          step('Making thumbnails…');
          const every = Math.max(0.25, doc.duration / 480);
          strip = await client.run<ThumbStrip>(videoId, blob, { job: 'thumbs', every, height: THUMB_HEIGHT }, {
            signal: abort.signal, progress: (d, n) => step(`Making thumbnails… ${n ? Math.round((d / n) * 100) : 0}%`),
          });
          void putCreatorFile(videoId, { name: THUMBS_FILE, mime: 'application/octet-stream', blob: packThumbs(strip) });
        }
        if (!abort.signal.aborted) setThumbs(strip);
        if (doc.hasAudio) {
          const [pc] = await getCreatorFiles(videoId, [PEAKS_FILE]);
          let p = pc ? await unpackPeaks(pc.blob) : null;
          if (!p) {
            step('Reading the sound…');
            p = await client.run<AudioPeaks | null>(videoId, blob, { job: 'peaks', perSecond: 50 }, { signal: abort.signal });
            if (p) void putCreatorFile(videoId, { name: PEAKS_FILE, mime: 'application/octet-stream', blob: packPeaks(p) });
          }
          if (!abort.signal.aborted) setPeaks(p);
        }
        step(null);
      } catch (e) {
        if (isAbort(e) || abort.signal.aborted) return;
        setError(String((e as Error)?.message ?? e));
        setBusy(null);
      }
    })();
    return () => { abort.abort(); opened?.dispose(); };
  }, [videoId]);

  useEffect(() => { player?.setProxyWidth(proxyWidth || Infinity); }, [player, proxyWidth]);

  // Object URLs for the thumbnails, released with them.
  const thumbUrls = useMemo(() => (thumbs ? { strip: thumbs, urls: thumbs.images.map(b => URL.createObjectURL(b)) } : null), [thumbs]);
  useEffect(() => () => { thumbUrls?.urls.forEach(u => URL.revokeObjectURL(u)); }, [thumbUrls]);

  const analyze = async () => {
    if (!videoId || !player) return;
    analysisAbort.current?.abort();
    const abort = new AbortController();
    analysisAbort.current = abort;
    setAnalyzing(0);
    try {
      const r = await referenceClient().run<AnalysisResult | null>(videoId, player.blob, { job: 'analyze' }, {
        signal: abort.signal, progress: (d, n) => setAnalyzing(n ? Math.min(1, d / n) : 0),
      });
      if (!r || abort.signal.aborted) return;
      setAnalysis(r);
      void putCreatorFile(videoId, { name: ANALYSIS_FILE, mime: 'application/octet-stream', blob: packAnalysis(r) });
    } catch (e) {
      if (!isAbort(e)) setError(String((e as Error)?.message ?? e));
    } finally {
      if (analysisAbort.current === abort) { analysisAbort.current = null; setAnalyzing(null); }
    }
  };

  /** The tracks changed: kept with the clip after a quiet spell. */
  const setTracks = (next: TracksState) => {
    setTracksState(next);
    tracksRef.current = next;
    if (!videoId) return;
    window.clearTimeout(saveTimer.current);
    const id = videoId;
    saveTimer.current = window.setTimeout(() => {
      void putCreatorFile(id, { name: TRACKS_FILE, mime: 'application/json', blob: tracksBlob(tracksRef.current) });
    }, 400);
  };
  const trackAll = async () => {
    if (!videoId || !player || !tracksRef.current.tracks.length) return;
    setTracking(0);
    try {
      const r = await referenceClient().run<TrackResult | null>(videoId, player.blob,
        { job: 'track', tracks: tracksRef.current.tracks.map(t => ({ id: t.id, seeds: t.seeds })) },
        { progress: (d, n) => setTracking(n ? Math.min(1, d / n) : 0) });
      if (!r) return;
      setTracks({
        ...tracksRef.current,
        result: {
          times: Array.from(r.times),
          points: Object.fromEntries(r.tracks.map(t => [t.id, Array.from(t.points)])),
          error: Object.fromEntries(r.tracks.map(t => [t.id, Array.from(t.error)])),
        },
      });
    } catch (e) {
      if (!isAbort(e)) setError(String((e as Error)?.message ?? e));
    } finally {
      setTracking(null);
    }
  };
  const suggest = async (at: number, shot: [number, number]) => {
    if (!videoId || !player) return [];
    try { return await referenceClient().run<Extremity[]>(videoId, player.blob, { job: 'extremities', at, shot }); }
    catch { return []; }
  };

  const meta = library.find(a => a.id === videoId);
  return {
    videoId: videoId ?? null, name: meta?.name ?? null, video: player?.doc ?? null, player,
    timestamps: timestamps?.timestamps ?? null, vfr: timestamps?.vfr ?? false,
    thumbs: thumbUrls, peaks, busy, error, library,
    analysis, analyzing, analyze, cancelAnalysis: () => analysisAbort.current?.abort(),
    tracks, setTracks, tracking, trackAll, suggest,
  };
}
