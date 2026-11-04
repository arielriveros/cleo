// Inline SVG glyphs for the effect stacks: a camera's post effects (CameraEditor) and a sound's effect
// rack (EffectRackEditor). Same idiom as sectionIcons, but sized by the container (Glyph is 100%).
import React from 'react';
import { Glyph } from '../sceneInspector/iconBase';

type P = React.SVGProps<SVGSVGElement>;
const dot = (cx: number, cy: number, r = 1.4) => <circle cx={cx} cy={cy} r={r} fill='currentColor' stroke='none' />;

// --- Camera post effects ---------------------------------------------------------------------------

/** Focus brackets around a point: depth of field. */
export const DepthOfFieldIcon = (p: P) => (<Glyph {...p}><path d='M4 8.5V5a1 1 0 0 1 1-1h3.5M15.5 4H19a1 1 0 0 1 1 1v3.5M20 15.5V19a1 1 0 0 1-1 1h-3.5M8.5 20H5a1 1 0 0 1-1-1v-3.5' /><circle cx='12' cy='12' r='3.5' /></Glyph>);
/** A sun with long shafts falling from it: god rays. */
export const GodRaysIcon = (p: P) => (<Glyph {...p}><circle cx='7' cy='7' r='3' /><path d='M10.5 10.5 20 20M7.5 11.5 9.5 21M11.5 7.5 21 9.5' /></Glyph>);
/** A bright core in fading halos: bloom. */
export const BloomIcon = (p: P) => (<Glyph {...p}><circle cx='12' cy='12' r='2.6' fill='currentColor' stroke='none' /><circle cx='12' cy='12' r='5.8' strokeOpacity='0.6' /><circle cx='12' cy='12' r='9.2' strokeOpacity='0.3' /></Glyph>);
/** A light source and the ghosts strung out across the lens from it: lens flare. */
export const LensFlareIcon = (p: P) => (<Glyph {...p}><circle cx='6.5' cy='6.5' r='2.5' /><path d='M6.5 1.5v1.5M6.5 10v1.5M1.5 6.5H3M10 6.5h1.5' /><circle cx='13.5' cy='13.5' r='1.4' /><circle cx='18.5' cy='18.5' r='2.6' /></Glyph>);
/** Three offset channels: chromatic aberration. */
export const ChromaticIcon = (p: P) => (<Glyph {...p}><circle cx='9' cy='9.5' r='5' /><circle cx='15' cy='9.5' r='5' /><circle cx='12' cy='14.5' r='5' /></Glyph>);
/** A frame darkening toward its edges: vignette. */
export const VignetteIcon = (p: P) => (<Glyph {...p}><rect x='3' y='5' width='18' height='14' rx='2' /><ellipse cx='12' cy='12' rx='5.5' ry='4' strokeDasharray='2 1.8' /></Glyph>);
/** A strip of film: film grain. */
export const FilmGrainIcon = (p: P) => (<Glyph {...p}><rect x='5' y='3' width='14' height='18' rx='1.5' /><path d='M9 3v18M15 3v18' />{dot(7, 6.5, 0.9)}{dot(7, 12, 0.9)}{dot(7, 17.5, 0.9)}{dot(17, 6.5, 0.9)}{dot(17, 12, 0.9)}{dot(17, 17.5, 0.9)}</Glyph>);
/** A four-point sparkle: any post effect without a glyph of its own. */
export const PostEffectIcon = (p: P) => (<Glyph {...p}><path d='M12 3c.7 4.6 1.9 5.9 6.5 6.5-4.6.7-5.8 1.9-6.5 6.5-.7-4.6-1.9-5.8-6.5-6.5C10.1 8.9 11.3 7.6 12 3Z' /><path d='M18.5 15.5v4M16.5 17.5h4' /></Glyph>);

// --- Sound effects ---------------------------------------------------------------------------------

/** Three faders: a filter. */
export const FilterIcon = (p: P) => (<Glyph {...p}><path d='M6 4v16M12 4v16M18 4v16' /><rect x='4' y='13' width='4' height='3' rx='1' fill='currentColor' /><rect x='10' y='7' width='4' height='3' rx='1' fill='currentColor' /><rect x='16' y='11' width='4' height='3' rx='1' fill='currentColor' /></Glyph>);
/** A waveform clipped flat at the top and bottom: distortion. */
export const DistortionIcon = (p: P) => (<Glyph {...p}><path d='M2.5 12h2l2-6h4l2 12h4l2-6h3' /></Glyph>);
/** A pulse repeating quieter each time: delay. */
export const DelayIcon = (p: P) => (<Glyph {...p}><path d='M4 19V6M9.5 19V9.5M15 19v-6M20.5 19v-3' /></Glyph>);
/** A source and the widening wavefronts it fills the room with: reverb. */
export const ReverbIcon = (p: P) => (<Glyph {...p}>{dot(5, 12, 1.6)}<path d='M9 8.5a5 5 0 0 1 0 7M12.5 5.5a9.5 9.5 0 0 1 0 13M16 2.5a13.5 13.5 0 0 1 0 19' /></Glyph>);
/** Peaks pressed in toward a line: a compressor. */
export const CompressorIcon = (p: P) => (<Glyph {...p}><path d='M4 12h16' /><path d='M12 3v5.5M9 5.5l3 3 3-3M12 21v-5.5M9 18.5l3-3 3 3' /></Glyph>);
