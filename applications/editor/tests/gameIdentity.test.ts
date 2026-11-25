import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import { join } from 'path';
import {
  DEFAULT_PROJECT_SETTINGS, PROJECT_SETTINGS_VERSION, cleanAppId, cleanGameVersion, isDefaultProjectSettings, legacyAppId,
  newAppId, parseProjectSettings, projectSettingsConfig, resolveAppId,
} from '../src/features/options/projectSettings';
import { PLAYER_CONTRACT, packGameBin } from '../src/features/publish/pack';
import { unpackGameBin } from '../src/player/unpack';
import { ICO_SIZES, encodeIco, iconWarnings, withGameHead } from '../src/features/publish/gameIcons';
import { isCapturedCover } from '../src/features/options/coverCapture';

// Who a published game is (Options ▸ Project ▸ Published game): its version, its app id, its icon and the project's
// cover — what an installer, an update and the project browser know it by (docs/design/game-updates.md §1).

const require = createRequire(import.meta.url);
const templates = require(join(__dirname, '..', '..', 'app-kit', 'desktop', 'gameTemplates.js'));

describe('project identity settings', () => {
  it('defaults to version 1.0.0, no app id, icon or cover, and is still "default" (nothing written for it)', () => {
    expect(PROJECT_SETTINGS_VERSION).toBe(7);
    expect(DEFAULT_PROJECT_SETTINGS.identity).toEqual({ version: '1.0.0', appId: '', icon: '', cover: '' });
    expect(parseProjectSettings(null).identity).toEqual(DEFAULT_PROJECT_SETTINGS.identity);
    expect(isDefaultProjectSettings(parseProjectSettings(undefined))).toBe(true);
  });

  it('reads a project from before it (format 6) as the defaults, and moves it to format 7', () => {
    const before = parseProjectSettings({ version: 6, publish: { title: 'Keep' } });
    expect(before.version).toBe(7);
    expect(before.identity).toEqual({ version: '1.0.0', appId: '', icon: '', cover: '' });
  });

  it('reads tolerantly: a bad version is 1.0.0, a bad app id or texture id is none', () => {
    const s = parseProjectSettings({ identity: { version: 'soon', appId: 'not an id', icon: 'a b', cover: 3 } });
    expect(s.identity).toEqual({ version: '1.0.0', appId: '', icon: '', cover: '' });
    const ok = parseProjectSettings({ identity: { version: ' v2.1.0-beta.1 ', appId: ' com.studio.keep ', icon: 'icon.png', cover: 'cover-1a2b3c4d.jpg' } });
    expect(ok.identity).toEqual({ version: '2.1.0-beta.1', appId: 'com.studio.keep', icon: 'icon.png', cover: 'cover-1a2b3c4d.jpg' });
  });

  it('stays out of the published config (the window block is sent whole to the game)', () => {
    const s = parseProjectSettings({ identity: { version: '2.0.0', appId: 'com.x.y', icon: 'i.png' } });
    const config = projectSettingsConfig(s);
    expect(JSON.stringify(config)).not.toContain('com.x.y');
    expect(config.window).toEqual({ title: '', width: 1280, height: 720, fullscreen: false, resizable: true });
  });

  it('cleans what is typed', () => {
    expect(cleanGameVersion('1.2.3')).toBe('1.2.3');
    expect(cleanGameVersion('v1.2.3')).toBe('1.2.3');
    expect(cleanGameVersion('1.2')).toBe('');
    expect(cleanGameVersion('1.2.3+meta')).toBe('');
    expect(cleanAppId('com.studio.game')).toBe('com.studio.game');
    expect(cleanAppId('game')).toBe('');
    expect(cleanAppId('com..x')).toBe('');
  });
});

describe('app ids', () => {
  it('an older project keeps the id its installers had: the shell\'s, made from its name', () => {
    for (const name of ['My Game!', 'Hollow Keep 2', 'Cleo Game', '', '東京', 'x'.repeat(90)])
      expect(legacyAppId(name), name).toBe(templates.gameAppId(name));
  });

  it('resolves the project\'s own id first, else the legacy one from the title, else the project name', () => {
    const s = parseProjectSettings({ publish: { title: 'The Keep' } });
    expect(resolveAppId(s, 'Project')).toBe('com.cleo.game.thekeep');
    expect(resolveAppId(parseProjectSettings({}), 'My Project')).toBe('com.cleo.game.myproject');
    expect(resolveAppId(parseProjectSettings({ identity: { appId: 'com.studio.keep' } }), 'x')).toBe('com.studio.keep');
  });

  it('a new project gets one of its own, unique, and valid', () => {
    let n = 0;
    const seq = () => ((n++ * 7) % 36) / 36;
    const a = newAppId('Hollow Keep', seq), b = newAppId('Hollow Keep', Math.random);
    expect(a).toMatch(/^com\.cleo\.game\.hollowkeep\.[0-9a-z]{6}$/);
    expect(cleanAppId(a)).toBe(a);
    expect(templates.isAppId(a)).toBe(true);
    expect(a).not.toBe(b);
    expect(newAppId('!!!')).toMatch(/^com\.cleo\.game\.game\.[0-9a-z]{6}$/);
  });
});

describe('the game in game.bin', () => {
  const data = (game?: any) => ({
    version: 2, entry: 'main',
    scenes: { main: { name: 'Main', scene: { name: 'root', children: [] } } },
    ...(game ? { game } : {}),
  });

  it('carries its name, version and app id in the manifest, with no contract bump', () => {
    const game = { name: 'Hollow Keep', version: '1.2.0', appId: 'com.studio.keep' };
    const manifest = unpackGameBin(packGameBin(data(game)).buffer).manifest;
    expect(manifest.game).toEqual(game);
    expect(manifest.contract).toBe(PLAYER_CONTRACT);
    expect(PLAYER_CONTRACT).toBe(53);
  });

  it('is absent from a pack built without it (Play in window), and changes the content hash', () => {
    const plain = unpackGameBin(packGameBin(data()).buffer).manifest;
    expect(plain.game).toBeUndefined();
    const named = unpackGameBin(packGameBin(data({ name: 'K', version: '1.0.0', appId: 'com.a.b' })).buffer).manifest;
    expect(named.contentHash).not.toBe(plain.contentHash);
  });
});

describe('the game icon', () => {
  const png = (size: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, size & 0xff, 1, 2, 3]);

  it('packs PNGs into an ICO: header, one entry per size (256 written as 0), data at the offsets', () => {
    const entries = ICO_SIZES.map(size => ({ size, png: png(size) }));
    const ico = encodeIco(entries);
    const view = new DataView(ico.buffer);
    expect(view.getUint16(0, true)).toBe(0);
    expect(view.getUint16(2, true)).toBe(1);
    expect(view.getUint16(4, true)).toBe(ICO_SIZES.length);
    let expectedOffset = 6 + 16 * ICO_SIZES.length;
    ICO_SIZES.forEach((size, i) => {
      const e = 6 + 16 * i;
      expect(ico[e]).toBe(size >= 256 ? 0 : size);
      expect(ico[e + 1]).toBe(size >= 256 ? 0 : size);
      expect(view.getUint16(e + 4, true)).toBe(1);
      expect(view.getUint16(e + 6, true)).toBe(32);
      expect(view.getUint32(e + 8, true)).toBe(8);
      expect(view.getUint32(e + 12, true)).toBe(expectedOffset);
      expect([...ico.slice(expectedOffset, expectedOffset + 8)]).toEqual([...png(size)]);
      expectedOffset += 8;
    });
    expect(ico.length).toBe(expectedOffset);
    // The bytes the shell's ICON_FILES check accepts.
    expect([...ico.slice(0, 4)]).toEqual([0, 0, 1, 0]);
    expect(ICO_SIZES).toContain(256);
  });

  it('warns about an image that is not square, or too small to stay sharp', () => {
    expect(iconWarnings(512, 512)).toEqual([]);
    expect(iconWarnings(1024, 512)).toHaveLength(1);
    expect(iconWarnings(128, 128)[0]).toMatch(/under 256/);
    expect(iconWarnings(0, 0)).toEqual([]);
  });
});

describe('the published page\'s head', () => {
  const html = '<!DOCTYPE html>\n<html>\n<head>\n    <title>Cleo Game</title>\n    <script defer src="game.scripts.js"></script>\n</head>\n<body></body>\n</html>\n';

  it('takes the game\'s title, escaped', () => {
    expect(withGameHead(html, { title: 'Keep & <Co>' })).toContain('<title>Keep &amp; &lt;Co&gt;</title>');
    expect(withGameHead(html, { title: '  ' })).toContain('<title>Cleo Game</title>');
  });

  it('links the icon files when the game ships them, inside the head', () => {
    const out = withGameHead(html, { icon: true });
    const head = out.slice(0, out.indexOf('</head>'));
    expect(head).toContain('<link rel="icon" href="icon.ico" sizes="any">');
    expect(head).toContain('<link rel="icon" type="image/png" href="icon.png">');
    expect(head).toContain('<link rel="apple-touch-icon" href="icon.png">');
    expect(withGameHead(html, {})).toBe(html);
  });
});

describe('cover captures', () => {
  it('are told apart from picked images by their id, so only a capture is ever replaced', () => {
    expect(isCapturedCover('cover-1a2b3c4d.jpg')).toBe(true);
    expect(isCapturedCover('cover.jpg')).toBe(false);
    expect(isCapturedCover('keyart.png')).toBe(false);
    expect(isCapturedCover('cover-1a2b3c4d.png')).toBe(false);
  });
});
