import { useState } from 'react';
import { Button, Collapsable, NumberInput, SegmentedControl, Select, Toggle } from '@cleo/app-kit/ui';
import { toast } from '@cleo/app-kit/feedback/toastStore';
import { defaultCalibration, solvePnp, turnCamera, type CalibrationDoc } from '../reference/calibrate';
import { SENSORS, focalOfVfov, projectPoint, cameraBasis, vfovOfFocal, type Vec2, type Vec3 } from '../reference/referenceCamera';
import { useMotion } from './motionContext';

// Reference ▸ Camera, Calibrate and Match pose: setting the stage's camera up as the video was filmed, so the
// character stands in the footage's perspective.
//
//   Camera       Look through it (the viewport framed as the video, its lens and roll); Set from view after
//                lining it up by eye; its lens as a focal length; turn the shot about the subject.
//   Calibrate    lines along the filmed ground's two axes give the lens and the angle (vanishing points);
//                the subject's feet place the origin and its height (or a ruler) the distance.
//   Match pose   pin joints of the posed character to where they are in the frame: the camera that puts
//                them there.

/** The joints offered for pins: the body's landmarks, by humanoid slot. */
const PIN_SLOTS = ['head', 'neck', 'hips', 'spine', 'upperArm.L', 'foreArm.L', 'hand.L', 'upperArm.R', 'foreArm.R', 'hand.R',
  'upLeg.L', 'leg.L', 'foot.L', 'toe.L', 'upLeg.R', 'leg.R', 'foot.R', 'toe.R'];

const short = (n: string) => n.replace(/^.*[:|]/, '');

export function ReferenceCameraSections() {
  const {
    doc, reference: r, rig, lookThrough, setLookThrough, viewCamera, setCamera, calibrating, setCalibrating, calibration,
    setCalibration, solve, placingPin, setPlacingPin, jointPositions, gate, subjectHeight,
  } = useMotion();
  const ref = doc.reference;
  const video = r.video;
  const [sensor, setSensor] = useState('ff');
  const [solveLens, setSolveLens] = useState(false);
  const [pinJoint, setPinJoint] = useState<string>('');
  if (!ref || !video) return null;
  const camera = ref.camera;
  const sensorH = SENSORS.find(s => s.id === sensor)?.height ?? 24;
  // A frame taller than wide: the sensor's long side runs up the frame.
  const frameSensorH = video.height > video.width ? sensorH * 1.5 : sensorH;
  const cal = calibration ?? defaultCalibration(video.width, video.height, subjectHeight);
  const setCal = (patch: Partial<CalibrationDoc>) => setCalibration({ ...cal, ...patch }, true);

  const pinnable = rig
    ? (() => {
        const bySlot = PIN_SLOTS.flatMap(s => { const i = rig.bySlot.get(s); return i !== undefined ? [rig.bones[i].name] : []; });
        return bySlot.length >= 4 ? bySlot : rig.bones.filter(b => b.joint).map(b => b.name);
      })()
    : [];
  const joint = pinJoint && pinnable.includes(pinJoint) ? pinJoint : pinnable.find(j => !cal.pins.some(p => p.joint === j)) ?? pinnable[0] ?? '';

  const matchPose = () => {
    const world = jointPositions();
    const pins = cal.pins.filter(p => world.has(p.joint));
    const start = camera ?? viewCamera();
    if (!start) { toast.info('Look through the reference, or set the camera from the view, first.'); return; }
    const res = solvePnp(pins.map(p => [...world.get(p.joint)!] as Vec3), pins.map(p => p.at), video.width, video.height, start, { solveLens });
    if (!res) { toast.error(`Pin at least ${solveLens ? 5 : 4} joints, spread over the body, then try again.`, { title: 'Could not match the pose' }); return; }
    setCamera(res.camera);
    toast.success(`The camera puts the pinned joints within ${res.rms.toFixed(1)} px of their pins.`);
    if (!lookThrough) setLookThrough(true);
  };
  // How far each pin is from its joint as the current camera sees it.
  const pinError = (() => {
    if (!camera || !cal.pins.length) return null;
    const world = jointPositions(), b = cameraBasis(camera);
    let sum = 0, n = 0;
    for (const p of cal.pins) {
      const w = world.get(p.joint);
      const pr = w && projectPoint(b, camera.vfov, video.width, video.height, w);
      if (pr) { sum += (pr.px[0] - p.at[0]) ** 2 + (pr.px[1] - p.at[1]) ** 2; n++; }
    }
    return n ? Math.sqrt(sum / n) : null;
  })();

  return (<>
    <Collapsable title='Camera' persistKey='cleo_creator_motion_ref_camera'>
      <div className='flex flex-wrap items-center gap-1'>
        <Toggle label='Look through' checked={lookThrough} disabled={!camera && !gate}
                onChange={on => { if (on && !camera) { const c = viewCamera(); if (c) setCamera(c); } setLookThrough(on); }} />
        <div className='flex-1' />
        <Button size='sm' title='The reference camera becomes the view as it is now (orbit it into place by eye first)'
                onClick={() => { const c = viewCamera(); if (c) setCamera(c); }}>Set from view</Button>
      </div>
      {camera ? (<>
        <div className='flex items-center gap-1 pt-1'>
          <span className='w-16 shrink-0 text-ui-sm text-muted'>Lens</span>
          <NumberInput className='w-16' value={Math.round(focalOfVfov(camera.vfov, frameSensorH) * 10) / 10} step={1}
                       onChange={mm => mm > 0 && setCamera({ ...camera, vfov: vfovOfFocal(mm, frameSensorH) })} />
          <span className='text-ui-xs text-dim'>mm</span>
          <Select className='min-w-0 flex-1' value={sensor} title='The camera’s sensor: a focal length means a different field of view on each'
                  onChange={e => setSensor(e.target.value)}>
            {SENSORS.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
          </Select>
        </div>
        <div className='pt-1 text-ui-xs text-dim tabular-nums'>
          {camera.vfov.toFixed(1)}° high · tilt {camera.pitch.toFixed(1)}° · roll {camera.roll.toFixed(1)}° · {cameraHeight(camera).toFixed(2)} m up
        </div>
        <div className='flex items-center gap-1 pt-1' title='Turn the camera about the subject: it then faces another way in the shot'>
          <span className='w-16 shrink-0 text-ui-sm text-muted'>Turn</span>
          {[-90, -15, 15, 90, 180].map(d => (
            <Button key={d} size='sm' variant='ghost' onClick={() => setCamera(turnCamera(camera, d))}>{d > 0 ? `+${d}` : d}°</Button>
          ))}
        </div>
      </>) : (
        <div className='pt-1 text-ui-xs text-dim'>No camera yet: orbit the view until the floor lines up with the video and Set from view, or Calibrate below.</div>
      )}
    </Collapsable>

    <Collapsable title='Calibrate' persistKey='cleo_creator_motion_ref_calibrate'>
      <Toggle label='Show the lines' checked={calibrating === 'lines'} onChange={on => { setCalibrating(on ? 'lines' : 'off'); setPlacingPin(null); }} />
      {calibrating === 'lines' && (<>
        <div className='py-1 text-ui-xs text-dim'>
          Lay the red lines along one direction of the filmed floor (tile edges, a road, a wall’s foot) and the blue along the other,
          the white cross under the subject’s feet and the green mark on top of its head.
        </div>
        <SegmentedControl<'2vp' | '1vp'> size='sm' value={cal.mode} onChange={mode => setCal({ mode })}
          options={[
            { value: '2vp', label: 'Two axes', title: 'Lines along both ground axes: the lens is solved' },
            { value: '1vp', label: 'One axis + lens', title: 'Lines along one axis and a known lens (one red line sets the roll)' },
          ]} />
        {cal.mode === '1vp' && (
          <div className='flex items-center gap-1 pt-1'>
            <span className='w-16 shrink-0 text-ui-sm text-muted'>Lens</span>
            <NumberInput className='w-16' value={Math.round(focalOfVfov(cal.vfov, frameSensorH) * 10) / 10} step={1}
                         onChange={mm => mm > 0 && setCal({ vfov: vfovOfFocal(mm, frameSensorH) })} />
            <span className='text-ui-xs text-dim'>mm ({SENSORS.find(s => s.id === sensor)?.label})</span>
          </div>
        )}
        <div className='flex items-center gap-1 pt-1'>
          <span className='w-16 shrink-0 text-ui-sm text-muted'>Scale by</span>
          <SegmentedControl<'subject' | 'ruler'> size='sm' value={cal.scale} onChange={scale => setCal({ scale })}
            options={[{ value: 'subject', label: 'Height', title: 'The subject’s height: feet to the top of the head' }, { value: 'ruler', label: 'Ruler', title: 'Two points on the ground a known distance apart' }]} />
        </div>
        {cal.scale === 'subject' ? (
          <Row label='Height'>
            <NumberInput className='w-16' value={cal.height} step={0.01} onChange={v => v > 0 && setCal({ height: v })} /><span className='text-ui-xs text-dim'>m</span>
            {rig && <Button size='sm' variant='ghost' title='The character’s own height' onClick={() => setCal({ height: Math.round(subjectHeight * 100) / 100 })}>Character’s</Button>}
          </Row>
        ) : (
          <Row label='Length'>
            <NumberInput className='w-16' value={cal.ruler.length} step={0.05} onChange={v => v > 0 && setCal({ ruler: { ...cal.ruler, length: v } })} /><span className='text-ui-xs text-dim'>m</span>
          </Row>
        )}
        <div className={`pt-1 text-ui-xs ${solve && !solve.ok ? 'text-warning' : 'text-dim'}`}>
          {!solve ? '' : solve.ok ? `Solved: ${solve.solve.camera.vfov.toFixed(1)}° lens, tilt ${solve.solve.camera.pitch.toFixed(1)}°, roll ${solve.solve.camera.roll.toFixed(1)}° — the camera follows each drag.` : solve.error}
        </div>
        <Button size='sm' className='mt-1' title='Lay the lines out afresh' onClick={() => setCal({ ...defaultCalibration(video.width, video.height, cal.height), pins: cal.pins })}>Reset lines</Button>
      </>)}
    </Collapsable>

    <Collapsable title='Match pose' persistKey='cleo_creator_motion_ref_match'>
      <div className='pb-1 text-ui-xs text-dim'>
        Pose the character as the subject is in this frame, then pin its joints to where they are in the video: the camera that puts them there is solved.
      </div>
      <div className='flex items-center gap-1'>
        <Select className='min-w-0 flex-1' value={joint} onChange={e => setPinJoint(e.target.value)} disabled={!pinnable.length}>
          {pinnable.map(j => <option key={j} value={j}>{short(j)}{cal.pins.some(p => p.joint === j) ? ' · pinned' : ''}</option>)}
        </Select>
        <Button size='sm' active={!!placingPin} disabled={!joint}
                title='Then click where this joint is in the frame'
                onClick={() => { setCalibrating('pins'); setPlacingPin(placingPin ? null : joint); }}>{placingPin ? 'Click the frame…' : 'Pin'}</Button>
      </div>
      {cal.pins.length > 0 && (
        <div className='flex flex-col pt-1'>
          {cal.pins.map((p, i) => (
            <div key={`${p.joint}${i}`} className='flex items-center gap-1 text-ui-sm'>
              <span className='min-w-0 flex-1 truncate'>{short(p.joint)}</span>
              <span className='text-ui-xs text-dim tabular-nums'>{Math.round(p.at[0])}, {Math.round(p.at[1])}</span>
              <Button size='sm' variant='remove' title='Remove the pin' onClick={() => setCal({ pins: cal.pins.filter((_, j) => j !== i) })}>Remove</Button>
            </div>
          ))}
        </div>
      )}
      <Toggle label='Show the pins' checked={calibrating === 'pins'} onChange={on => setCalibrating(on ? 'pins' : 'off')} />
      <Toggle label='Solve the lens too' checked={solveLens} onChange={setSolveLens} />
      <div className='flex items-center gap-1 pt-1'>
        <Button size='sm' disabled={cal.pins.length < (solveLens ? 5 : 4)} title={`Needs ${solveLens ? 5 : 4} pins or more, spread over the body`} onClick={matchPose}>Match the camera</Button>
        {pinError !== null && <span className='text-ui-xs text-dim tabular-nums'>pins off by {pinError.toFixed(1)} px</span>}
      </div>
    </Collapsable>
  </>);
}

/** How high the camera stands over the ground, metres. */
function cameraHeight(c: { target: Vec3; distance: number; pitch: number }): number {
  return c.target[1] + Math.sin((c.pitch * Math.PI) / 180) * c.distance;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className='flex items-center gap-1 pt-1'><span className='w-16 shrink-0 text-ui-sm text-muted'>{label}</span>{children}</div>;
}

export type { Vec2 };
