// Docs media encoding, with ffmpeg on PATH.
//
//   node tools/docsMedia/encode.mjs gif <framesDir> <out.gif> [--crop x,y,w,h] [--width 720] [--fps 12] [--from s] [--to s]
//   node tools/docsMedia/encode.mjs png <in.png> <out.png> [--crop x,y,w,h] [--width 1280]
//
// A GIF is made from a /record screencast (f0000.jpg… + frames.json, the time of each frame): the frames are laid
// end to end with their real durations (the concat demuxer), resampled to a steady --fps, cropped, scaled and
// mapped through one palette generated from the clip itself (two passes). A PNG is cropped, scaled and saved as
// an 8-bit palette image when that stays visually safe -- documentation images, not masters.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [mode, input, output, ...rest] = process.argv.slice(2);
const opt = (name, fallback) => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] : fallback;
};
const crop = opt('crop')?.split(',').map(Number);
const cropFilter = crop ? `crop=${crop[2]}:${crop[3]}:${crop[0]}:${crop[1]},` : '';
const ffmpeg = (args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });

if (mode === 'gif') {
    const width = Number(opt('width', 720)), fps = Number(opt('fps', 12));
    const from = Number(opt('from', 0)), to = Number(opt('to', Infinity));
    const times = JSON.parse(fs.readFileSync(path.join(input, 'frames.json'), 'utf8'));
    const lines = [];
    times.forEach((t, i) => {
        if (t < from || t > to) return;
        const next = times[i + 1] ?? t + 1 / 30;
        lines.push(`file '${path.join(input, `f${String(i).padStart(4, '0')}.jpg`).split(path.sep).join('/')}'`, `duration ${Math.max(0.001, next - t).toFixed(4)}`);
    });
    const list = path.join(os.tmpdir(), `docs-media-${process.pid}.txt`);
    fs.writeFileSync(list, lines.join('\n'));
    const palette = path.join(os.tmpdir(), `docs-media-${process.pid}-pal.png`);
    const base = `fps=${fps},${cropFilter}scale=${width}:-1:flags=lanczos`;
    ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-vf', `${base},palettegen=stats_mode=diff:max_colors=256`, palette]);
    ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-i', palette,
            '-lavfi', `${base}[v];[v][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`, '-loop', '0', output]);
    fs.rmSync(list); fs.rmSync(palette);
} else if (mode === 'png') {
    const width = Number(opt('width', 1280));
    ffmpeg(['-i', input, '-vf', `${cropFilter}scale='min(${width},iw)':-1:flags=lanczos`, '-pix_fmt', 'rgb24', output]);
} else {
    console.error('usage: encode.mjs gif|png <in> <out> [options]');
    process.exit(2);
}
console.log(`${output}  ${(fs.statSync(output).size / 1024).toFixed(0)} KB`);
