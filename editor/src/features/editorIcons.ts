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
