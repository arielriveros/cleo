import { useState } from 'react';
import { Button, Collapsable, FileButton, NumberInput, SegmentedControl, Select, Slider, Toggle } from '@cleo/app-kit/ui';
import { PanelBody } from '../../app/workspace';
import { referenceSpan, videoFrameAt, videoTimeOf } from '../reference/referenceDoc';
import { rateLabel } from '../reference/videoDoc';
import { VIDEO_ACCEPT } from '../reference/videoImport';
import { useMotion } from './motionContext';
import { ReferenceCameraSections } from './ReferenceCameraSections';
import { TRACK_ROLES, footContacts, roleOf, type TrackRole } from '../reference/tracks';
import type { ReferenceMode } from './motionStage';

// The Reference tab: a video the motion is made against. Link a clip (a new file, or one already in the
// library under /Video), line its time up with the motion's (offset, the rate it was filmed at, in and out),
// and choose how it is drawn. Its frames then play with the motion, a frame at a time when stepping, and
// a key can be made at any frame to pose the character against it.

const PROXIES = [[480, '480 px'], [720, '720 px'], [1080, '1080 px'], [0, 'Full size']] as const;

export function ReferencePanel() {
  const {
    doc, setDoc, reference: r, linkVideo, setReference, keyFromFrame, stage, setStage, transport, stageTime, view, rig,
  } = useMotion();
  const [linking, setLinking] = useState(false);
  const ref = doc.reference;
  const video = r.video;
  const link = async (source: File | string | null) => {
    setLinking(true);
    try { await linkVideo(source); } finally { setLinking(false); }
  };

  const libraryPicker = (
    <Select className='flex-1' value='' disabled={!r.library.length || linking}
            title='A clip already in the library (Assets ▸ /Video)'
            onChange={e => { if (e.target.value) void link(e.target.value); }}>
      <option value=''>{r.library.length ? 'From the library…' : 'No clips in the library yet'}</option>
      {r.library.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
    </Select>
  );

  if (!ref) {
    return (
      <PanelBody>
        <Collapsable title='Video' persistKey='cleo_creator_motion_ref_video'>
          <div className='pb-2 text-ui-sm text-muted'>
            Film or find the action, then animate over it: the video plays with the motion, frame for frame.
          </div>
          <div className='flex items-center gap-1'>
            <FileButton accept={VIDEO_ACCEPT} disabled={linking} onFiles={files => { if (files[0]) void link(files[0]); }}
                        title='An .mp4, .mov or .webm (H.264, HEVC, VP9 or AV1). It is kept in the library, under /Video'>
              {linking ? 'Adding…' : 'Load video…'}
            </FileButton>
            {libraryPicker}
          </div>
        </Collapsable>
      </PanelBody>
    );
  }

  const span = referenceSpan(ref);
  const filmedAt = video ? video.fps * ref.speed : 0;
  const t = stageTime();
  const frame = r.timestamps ? videoFrameAt(ref, r.timestamps, t) : null;
  const realFps = filmedAt;
  const fpsMatches = realFps > 0 && Math.abs(doc.fps - Math.round(realFps * 1000) / 1000) < 1e-3;

  return (
    <PanelBody>
      <Collapsable title='Video' persistKey='cleo_creator_motion_ref_video'>
        <div className='flex items-center gap-1'>
          <span className='min-w-0 flex-1 truncate text-ui-sm text-fg' title={r.name ?? undefined}>{r.name ?? 'Reference'}</span>
          <FileButton size='sm' accept={VIDEO_ACCEPT} disabled={linking} title='Use another video file instead'
                      onFiles={files => { if (files[0]) void link(files[0]); }}>Replace…</FileButton>
          <Button size='sm' variant='remove' title='Stop using a reference (the clip stays in the library)' onClick={() => void link(null)}>Unlink</Button>
        </div>
        {video && (
          <div className='pt-1 text-ui-xs text-dim tabular-nums'>
            {video.width}×{video.height} · {rateLabel(video.fps)} fps{r.vfr ? ' (variable)' : ''} · {video.duration.toFixed(2)} s
            {video.codec ? ` · ${video.codec}` : ''}{video.hasAudio ? ' · sound' : ''}
          </div>
        )}
        {r.vfr && <div className='pt-1 text-ui-xs text-warning'>Its frames are unevenly spaced (a phone’s variable frame rate): each is placed at its own time.</div>}
        {r.busy && <div className='pt-1 text-ui-xs text-muted'>{r.busy}</div>}
        {r.error && <div className='pt-1 text-ui-xs text-danger-fg'>{r.error}</div>}
        <div className='flex items-center gap-1 pt-2'>{libraryPicker}</div>
      </Collapsable>

      <Collapsable title='Timing' persistKey='cleo_creator_motion_ref_timing'>
        <Row label='Filmed at' title='The rate the camera filmed at: higher than the file’s for slow motion (a phone’s 240 fps clip plays at 30). The motion runs at real speed.'>
          <NumberInput className='w-20' value={Math.round(filmedAt * 1000) / 1000} step={1} disabled={!video}
                       onChange={v => video && v > 0 && setReference({ ...ref, speed: v / video.fps })} />
          <span className='text-ui-xs text-dim'>fps</span>
          {video && ref.speed !== 1 && <Button size='sm' variant='ghost' title='Filmed at the rate it plays at' onClick={() => setReference({ ...ref, speed: 1 })}>Real speed</Button>}
        </Row>
        <Row label='Offset' title='The video’s time at the motion’s start, seconds. Drag the Video lane on the Timeline to slide it.'>
          <NumberInput className='w-20' value={Math.round(ref.offset * 1000) / 1000} step={1 / Math.max(1, video?.fps ?? 30)}
                       onChange={v => setReference({ ...ref, offset: v })} />
          <span className='text-ui-xs text-dim'>s</span>
          <Button size='sm' variant='ghost' title='The frame at the playhead starts the motion'
                  onClick={() => { setReference({ ...ref, offset: videoTimeOf(ref, t) }); transport.seek(0); }}>Start here</Button>
        </Row>
        <Row label='In · out' title='The stretch of the video used, in its own seconds. Drag the Video lane’s ends to trim it.'>
          <NumberInput className='w-16' value={Math.round(ref.in * 1000) / 1000} step={0.04}
                       onChange={v => setReference({ ...ref, in: Math.min(ref.out - 0.04, Math.max(video?.start ?? 0, v)) })} />
          <NumberInput className='w-16' value={Math.round(ref.out * 1000) / 1000} step={0.04}
                       onChange={v => setReference({ ...ref, out: Math.max(ref.in + 0.04, Math.min((video?.start ?? 0) + (video?.duration ?? Infinity), v)) })} />
          <Button size='sm' variant='ghost' title='Trim to the playhead: the video starts or ends at the frame shown'
                  onClick={() => { const v = videoTimeOf(ref, t); setReference(v - ref.in < ref.out - v ? { ...ref, in: Math.min(v, ref.out - 0.04) } : { ...ref, out: Math.max(v, ref.in + 0.04) }); }}>Trim here</Button>
        </Row>
        <div className='pt-1 text-ui-xs text-dim tabular-nums'>
          On the timeline from {span.start.toFixed(2)} s to {span.end.toFixed(2)} s
          {frame !== null && view !== 'clip' ? ` · frame ${frame + 1}` : ''}
        </div>
        <Row label='Motion' title='The motion’s bake rate against the video’s real-time rate'>
          <span className='text-ui-xs text-muted tabular-nums'>{rateLabel(doc.fps)} fps</span>
          <Button size='sm' disabled={!video || fpsMatches} title={video ? `Bake the motion at the video’s real-time rate, ${rateLabel(Math.round(realFps * 1000) / 1000)} fps` : undefined}
                  onClick={() => setDoc({ ...doc, fps: Math.min(240, Math.max(10, Math.round(realFps * 1000) / 1000)) })}>Match video</Button>
        </Row>
        <Toggle label='Keys snap to the video’s frames' checked={stage.refSnap} onChange={v => setStage({ ...stage, refSnap: v })} />
      </Collapsable>

      <Collapsable title='Display' persistKey='cleo_creator_motion_ref_display'>
        <SegmentedControl<ReferenceMode> size='sm' value={stage.refMode} onChange={v => setStage({ ...stage, refMode: v })}
          options={[
            { value: 'off', label: 'Off', title: 'Hide the video' },
            { value: 'over', label: 'Over', title: 'The video over the 3D view, see-through' },
            { value: 'behind', label: 'Behind', title: 'The video behind the character, where no geometry is (the floor is hidden)' },
          ]} />
        <div className={stage.refMode !== 'over' || stage.refDifference ? 'pointer-events-none opacity-50' : undefined}>
          <Slider label='Opacity' min={0.05} max={1} step={0.01} readout value={stage.refOpacity} onChange={v => setStage({ ...stage, refOpacity: v })} />
        </div>
        <Toggle label='Difference' checked={stage.refDifference} disabled={stage.refMode !== 'over'} onChange={v => setStage({ ...stage, refDifference: v })} />
        <Toggle label='Mirror' checked={stage.refFlip} onChange={v => setStage({ ...stage, refFlip: v })} />
        <Toggle label='Film gate' checked={stage.refGate} onChange={v => setStage({ ...stage, refGate: v })} />
        <Toggle label='Sound' checked={stage.refSound} disabled={!video?.hasAudio} onChange={v => setStage({ ...stage, refSound: v })} />
        <Row label='Decode at' title='The width the video is decoded at for the viewport: smaller plays a 4K clip smoothly'>
          <Select className='w-28' value={String(stage.refProxy)} onChange={e => setStage({ ...stage, refProxy: Number(e.target.value) })}>
            {PROXIES.map(([w, label]) => <option key={w} value={w}>{label}</option>)}
          </Select>
        </Row>
      </Collapsable>

      <AnalysisSection />

      <TrackingSection />

      <ReferenceCameraSections />

      <Collapsable title='Keys' persistKey='cleo_creator_motion_ref_keys'>
        <div className='pb-1 text-ui-xs text-dim'>Step to a frame where the action turns (, and . step a frame), then make a key there and pose the character to match.</div>
        <Button size='sm' disabled={!rig} title='A key at the playhead with a new pose: the motion as it is at this frame' onClick={keyFromFrame}>Key from frame</Button>
        {view !== 'clip' && <div className='pt-1 text-ui-xs text-dim tabular-nums'>The playhead shows the video at {videoTimeOf(ref, t).toFixed(3)} s{frame !== null ? `, frame ${frame + 1}` : ' (outside the clip)'}.</div>}
      </Collapsable>
    </PanelBody>
  );
}

/** Reference ▸ Analysis: the classical computer vision over the whole clip, and what it offers. */
function AnalysisSection() {
  const { reference: r, analysisView: a, addKeysAtCandidates, stage, setStage, rig, lookThrough } = useMotion();
  const busy = r.analyzing !== null;
  const frames = r.analysis?.times.length ?? 0;
  return (
    <Collapsable title='Analysis' persistKey='cleo_creator_motion_ref_analysis'>
      <div className='pb-1 text-ui-xs text-dim'>
        Reads the whole clip for where the action holds and turns (key poses), held frames, cuts, and the moving subject.
      </div>
      <div className='flex items-center gap-1'>
        <Button size='sm' disabled={busy || !r.player} onClick={() => void r.analyze()}
                title='Read the clip frame by frame (in the background): it is kept with the clip'>{r.analysis ? 'Analyze again' : 'Analyze'}</Button>
        {busy && (<>
          <div className='h-1.5 min-w-0 flex-1 overflow-hidden rounded bg-surface'>
            <div className='h-full bg-primary' style={{ width: `${Math.round((r.analyzing ?? 0) * 100)}%` }} />
          </div>
          <Button size='sm' variant='ghost' onClick={r.cancelAnalysis}>Cancel</Button>
        </>)}
      </div>
      {a && (<>
        <div className='pt-1 text-ui-xs text-dim tabular-nums'>
          {frames} frames · {a.candidates.length} key candidate{a.candidates.length === 1 ? '' : 's'}
          {a.onEvery > 1 ? ` · animated on ${a.onEvery === 2 ? 'twos' : a.onEvery === 3 ? 'threes' : `${a.onEvery}s`}` : ''}
          {a.cuts.length ? ` · ${a.cuts.length} cut${a.cuts.length === 1 ? '' : 's'}` : ''}
        </div>
        {a.cameraMoves && <div className='pt-1 text-ui-xs text-warning'>The camera moves in this clip: the subject is found against a still background, so its box is unreliable.</div>}
        <Slider label='Key sensitivity' min={0} max={1} step={0.05} readout value={stage.refKeySensitivity}
                onChange={v => setStage({ ...stage, refKeySensitivity: v })} />
        <Button size='sm' disabled={!rig || !a.candidates.length} title='A key with a pose from the motion at every candidate: pose each against its frame'
                onClick={addKeysAtCandidates}>Add keys at candidates</Button>
        <div className='pt-2 text-ui-sm text-muted'>Subject</div>
        <Toggle label='Show its box' checked={stage.refShowBox} onChange={v => setStage({ ...stage, refShowBox: v })} />
        <div className='flex items-center gap-1 pt-1' title={lookThrough || stage.refMode !== 'over' ? 'Cropping is for the Over display, not while looking through' : undefined}>
          <span className='w-16 shrink-0 text-ui-sm text-muted'>Crop</span>
          <SegmentedControl<'none' | 'union' | 'follow'> size='sm' value={stage.refCrop} onChange={v => setStage({ ...stage, refCrop: v })}
            options={[
              { value: 'none', label: 'Whole', title: 'The whole frame' },
              { value: 'union', label: 'Subject', title: 'Zoomed onto everywhere the subject goes: still' },
              { value: 'follow', label: 'Follow', title: 'Zoomed onto the subject, following it' },
            ]} />
        </div>
      </>)}
    </Collapsable>
  );
}

/** Reference ▸ Tracking: points followed through the clip, and the feet planted from them. */
function TrackingSection() {
  const {
    reference: r, showTracks, setShowTracks, trackRole, setTrackRole, placingTrack, setPlacingTrack, suggestions, suggestPoints, plantFeet, doc,
  } = useMotion();
  const tracks = r.tracks.tracks;
  const busy = r.tracking !== null;
  const fps = r.video?.fps ?? 30;
  const summary = (id: string, role: TrackRole) => {
    const pts = r.tracks.result?.points[id];
    if (!pts) return 'not tracked yet';
    let found = 0;
    for (let i = 0; i < pts.length; i += 2) if (Number.isFinite(pts[i])) found++;
    const share = `${Math.round((found / Math.max(1, pts.length / 2)) * 100)}% followed`;
    return role === 'footL' || role === 'footR' ? `${share} · ${footContacts(pts, fps).length} contacts` : share;
  };
  const remove = (id: string) => r.setTracks({ ...r.tracks, tracks: tracks.filter(t => t.id !== id) });
  const setRole = (id: string, role: TrackRole) => r.setTracks({ ...r.tracks, tracks: tracks.map(t => (t.id === id ? { ...t, role } : t)) });
  return (
    <Collapsable title='Tracking' persistKey='cleo_creator_motion_ref_tracking'>
      <div className='pb-1 text-ui-xs text-dim'>
        Follow a foot, a hand or the head through the clip: put a point on it, Track, and correct it on any frame by dragging it there.
      </div>
      <Toggle label='Show the tracks' checked={showTracks} onChange={on => { setShowTracks(on); if (!on) setPlacingTrack(false); }} />
      <div className='flex items-center gap-1 pt-1'>
        <Select className='min-w-0 flex-1' value={trackRole} onChange={e => setTrackRole(e.target.value as TrackRole)} title='What the next point is'>
          {TRACK_ROLES.map(x => <option key={x.id} value={x.id}>{x.label}</option>)}
        </Select>
        <Button size='sm' active={placingTrack} title='Then click it on the frame' onClick={() => { setShowTracks(true); setPlacingTrack(!placingTrack); }}>
          {placingTrack ? 'Click the frame…' : 'Add point'}
        </Button>
        <Button size='sm' variant='ghost' disabled={!r.player} title='The subject’s furthest points on this frame (head, hands, feet, a tail): click one to track it'
                onClick={() => { setShowTracks(true); void suggestPoints(); }}>Suggest</Button>
      </div>
      {suggestions.length > 0 && <div className='pt-1 text-ui-xs text-dim'>{suggestions.length} suggestions on the frame: click one to track it as the {roleOf(trackRole).label.toLowerCase()}.</div>}
      {tracks.length > 0 && (
        <div className='flex flex-col pt-1'>
          {tracks.map(t => (
            <div key={t.id} className='flex items-center gap-1 text-ui-sm'>
              <span className='inline-block h-2.5 w-2.5 shrink-0 rounded-full' style={{ background: roleOf(t.role).color }} />
              <Select className='w-28' value={t.role} onChange={e => setRole(t.id, e.target.value as TrackRole)}>
                {TRACK_ROLES.map(x => <option key={x.id} value={x.id}>{x.label}</option>)}
              </Select>
              <span className='min-w-0 flex-1 truncate text-ui-xs text-dim' title={`${t.seeds.length} frame${t.seeds.length === 1 ? '' : 's'} set by hand`}>{summary(t.id, t.role)}</span>
              <Button size='sm' variant='remove' onClick={() => remove(t.id)} title='Remove the track'>Remove</Button>
            </div>
          ))}
        </div>
      )}
      <div className='flex items-center gap-1 pt-1'>
        <Button size='sm' disabled={!tracks.length || busy || !r.player} onClick={() => void r.trackAll()}
                title='Follow every point through the clip (in the background), from each frame it was set on'>{busy ? 'Tracking…' : 'Track'}</Button>
        {busy && (
          <div className='h-1.5 min-w-0 flex-1 overflow-hidden rounded bg-surface'>
            <div className='h-full bg-primary' style={{ width: `${Math.round((r.tracking ?? 0) * 100)}%` }} />
          </div>
        )}
        <div className='flex-1' />
        <Button size='sm' disabled={!r.tracks.result || !doc.reference?.camera}
                title={doc.reference?.camera ? 'In every key where a tracked foot is planted, put the foot’s IK goal where it meets the ground' : 'Needs the reference camera (Camera, Calibrate or Match pose)'}
                onClick={plantFeet}>Plant feet</Button>
      </div>
    </Collapsable>
  );
}

function Row({ label, title, children }: { label: string; title?: string; children: React.ReactNode }) {
  return (
    <div className='flex items-center gap-1 pt-1' title={title}>
      <span className='w-16 shrink-0 text-ui-sm text-muted'>{label}</span>
      {children}
    </div>
  );
}
