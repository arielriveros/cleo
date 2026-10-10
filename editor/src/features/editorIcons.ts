// Rasterise the light-probe glyph (inner ring + dashed outer ring, matching the inspector's ProbeIcon) to
// a white-on-transparent PNG data URL for the probe's billboard; a sprite Material.Basic tints it cyan.
export function buildProbeIconDataURL(): string {
  const size = 64, cx = size / 2, cy = size / 2;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  ctx.strokeStyle = 'white';
  ctx.lineWidth = 4;
  ctx.beginPath(); ctx.arc(cx, cy, 10, 0, Math.PI * 2); ctx.stroke();
  ctx.setLineDash([4, 6]);
  ctx.beginPath(); ctx.arc(cx, cy, 24, 0, Math.PI * 2); ctx.stroke();
  return canvas.toDataURL('image/png');
}

// Rasterise the decal glyph (a dashed projector box, a down arrow and the filled print it leaves, matching
// the scene tree's DecalIcon) to a white-on-transparent PNG data URL for a decal's billboard.
export function buildDecalIconDataURL(): string {
  const size = 64, c = size / 2;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  ctx.strokeStyle = 'white';
  ctx.fillStyle = 'white';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 4;

  ctx.setLineDash([6, 5]);
  ctx.strokeRect(10, 8, 44, 28);
  ctx.setLineDash([]);

  ctx.beginPath();
  ctx.moveTo(c, 14); ctx.lineTo(c, 38);
  ctx.moveTo(c - 7, 31); ctx.lineTo(c, 38); ctx.lineTo(c + 7, 31);
  ctx.stroke();

  ctx.beginPath();
  ctx.ellipse(c, 51, 22, 7, 0, 0, Math.PI * 2);
  ctx.fill();
  return canvas.toDataURL('image/png');
}

// Rasterise the light glyph (a filled core with eight rays, matching the inspector's LightIcon) to a
// white-on-transparent PNG data URL for the light's billboard; a sprite Material.Basic tints it.
export function buildLightIconDataURL(): string {
  const size = 64, c = size / 2;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  ctx.strokeStyle = 'white';
  ctx.fillStyle = 'white';
  ctx.lineCap = 'round';
  ctx.lineWidth = 5;
  ctx.beginPath(); ctx.arc(c, c, 11, 0, Math.PI * 2); ctx.fill();
  for (let i = 0; i < 8; ++i) {
    const a = (i / 8) * Math.PI * 2;
    const cos = Math.cos(a), sin = Math.sin(a);
    ctx.beginPath();
    ctx.moveTo(c + cos * 18, c + sin * 18);
    ctx.lineTo(c + cos * 27, c + sin * 27);
    ctx.stroke();
  }
  return canvas.toDataURL('image/png');
}

// Rasterise the sound glyph (a speaker with two radiating arcs, matching the inspector's SoundIcon) to a
// white-on-transparent PNG data URL for a Sound node's billboard; a sprite Material.Basic tints it.
export function buildSoundIconDataURL(): string {
  const size = 64, c = size / 2;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  ctx.strokeStyle = 'white';
  ctx.fillStyle = 'white';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 4;

  // The cone, drawn as one filled path so it reads at billboard size.
  ctx.beginPath();
  ctx.moveTo(c - 22, c - 8);
  ctx.lineTo(c - 12, c - 8);
  ctx.lineTo(c - 2, c - 20);
  ctx.lineTo(c - 2, c + 20);
  ctx.lineTo(c - 12, c + 8);
  ctx.lineTo(c - 22, c + 8);
  ctx.closePath();
  ctx.fill();

  for (const r of [10, 18]) {
    ctx.beginPath();
    ctx.arc(c - 2, c, r, -Math.PI / 3, Math.PI / 3);
    ctx.stroke();
  }
  return canvas.toDataURL('image/png');
}

// Rasterise the particle glyph (dots fanning up out of an emitter point, matching the scene tree's
// ParticlesIcon) for a particle system's billboard.
export function buildParticleIconDataURL(): string {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  ctx.strokeStyle = 'white';
  ctx.fillStyle = 'white';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  const dot = (x: number, y: number, r: number, fill: boolean) => {
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    if (fill) ctx.fill(); else ctx.stroke();
  };
  dot(32, 54, 5, true);
  dot(16, 28, 5, false); dot(32, 18, 6, false); dot(48, 27, 4.5, false);
  dot(24, 8, 3, true); dot(44, 9, 3, true);
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(32, 48); ctx.lineTo(19, 33);
  ctx.moveTo(32, 48); ctx.lineTo(32, 25);
  ctx.moveTo(32, 48); ctx.lineTo(45, 32);
  ctx.stroke();
  return canvas.toDataURL('image/png');
}

// Rasterise the force-field glyph (wind lines curling round a centre, matching ForceFieldIcon).
export function buildForceFieldIconDataURL(): string {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  ctx.strokeStyle = 'white';
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(6, 20); ctx.lineTo(36, 20); ctx.arc(36, 13, 7, Math.PI / 2, -Math.PI, true);
  ctx.moveTo(6, 32); ctx.lineTo(48, 32); ctx.arc(48, 41, 9, -Math.PI / 2, Math.PI, false);
  ctx.moveTo(6, 44); ctx.lineTo(24, 44);
  ctx.stroke();
  return canvas.toDataURL('image/png');
}
