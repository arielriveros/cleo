import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createRequire } from 'module';
import { isValidSlot as engineIsValidSlot } from '../src/core/save/doc';

/**
 * The save files of a published desktop game (app-kit/desktop/gameSaves.js), which the sandboxed page reaches
 * only through `window.cleoSaves` (gamePreload.js). The page names slots, never paths, so the slot check IS
 * the wall between a game and the rest of the disk; and a save that half-writes over the only copy is a
 * player's progress gone.
 */

const ROOT = join(__dirname, '..');
const DESKTOP = join(ROOT, 'applications', 'app-kit', 'desktop');
const require = createRequire(import.meta.url);
const saves = require(join(DESKTOP, 'gameSaves.js'));

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cleo-game-saves-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('slots', () => {
    const cases = ['auto', 'slot-1', 'quick_save', 'a.b', '', '.', '..', '.hidden', '../x', 'a/b', 'a\\b', 'C:x', 'CON', 'nul.cleosave',
        'com1', 'LPT9', 'x'.repeat(64), 'x'.repeat(65), 'a b', 'é', 'a\u0000b'];

    it('are the same names the engine accepts', () => {
        for (const slot of cases) expect(saves.isValidSlot(slot)).toBe(engineIsValidSlot(slot));
    });

    it('never let a name reach outside the folder', async () => {
        const files = saves.createSaveFiles(dir);
        for (const bad of ['../escape', '..', 'a/b', 'a\\b', '/abs', 'C:\\x', 'CON'])
            await expect(files.write(bad, '{}')).rejects.toThrow(/Not a save slot/);
        expect(existsSync(join(dir, '..', 'escape.cleosave'))).toBe(false);
    });
});

describe('the files', () => {
    it('write, list, read back and remove', async () => {
        const files = saves.createSaveFiles(join(dir, 'saves'));   // made on the first write
        expect(await files.list()).toEqual([]);
        expect(await files.read('auto')).toBeNull();
        await files.write('auto', '{"n":1}');
        await files.write('slot2', '{"n":2}');
        expect(await files.list()).toEqual(['auto', 'slot2']);
        expect(await files.read('auto')).toBe('{"n":1}');
        await files.remove('auto');
        expect(await files.list()).toEqual(['slot2']);
        expect(await files.read('auto')).toBeNull();
    });

    it('keep the save it replaced as a backup, and read the backup when the save is gone', async () => {
        const files = saves.createSaveFiles(dir);
        await files.write('auto', 'first');
        await files.write('auto', 'second');
        expect(readFileSync(join(dir, 'auto.cleosave.bak'), 'utf-8')).toBe('first');
        rmSync(join(dir, 'auto.cleosave'));
        expect(await files.read('auto')).toBe('first');
        expect(await files.list()).toEqual(['auto']);
    });

    it('leave no temporary file behind', async () => {
        const files = saves.createSaveFiles(dir);
        await files.write('auto', 'x');
        expect(existsSync(join(dir, 'auto.cleosave.tmp'))).toBe(false);
    });

    it('ignore other files in the folder', async () => {
        const files = saves.createSaveFiles(dir);
        writeFileSync(join(dir, 'notes.txt'), '');
        writeFileSync(join(dir, '..bad.cleosave'), '');
        await files.write('ok', '{}');
        expect(await files.list()).toEqual(['ok']);
    });

    it('refuse what is not text, and a save past the size cap', async () => {
        const files = saves.createSaveFiles(dir);
        await expect(files.write('auto', 42)).rejects.toThrow(/text/);
        await expect(files.write('auto', 'x'.repeat(saves.MAX_SAVE_BYTES + 1))).rejects.toThrow(/larger than/);
    });
});

describe('the IPC bridge', () => {
    function fakeIpc() {
        const handlers = new Map<string, Function>();
        return { handlers, handle: (channel: string, fn: Function) => handlers.set(channel, fn) };
    }
    const fromGame = { senderFrame: { url: 'game://app/index.html' } };
    const fromElsewhere = { senderFrame: { url: 'https://example.com/' } };

    it('answers the four calls the preload makes, for the game page only', async () => {
        const ipc = fakeIpc();
        saves.register(ipc, dir);
        expect([...ipc.handlers.keys()].sort()).toEqual(['cleo-saves:list', 'cleo-saves:read', 'cleo-saves:remove', 'cleo-saves:write']);
        await ipc.handlers.get('cleo-saves:write')!(fromGame, 'auto', '{}');
        expect(await ipc.handlers.get('cleo-saves:list')!(fromGame)).toEqual(['auto']);
        expect(() => ipc.handlers.get('cleo-saves:read')!(fromElsewhere, 'auto')).toThrow(/only for the game page/);
    });

    it('is what the preload calls, and the preload needs nothing but electron', () => {
        const preload = readFileSync(join(DESKTOP, 'gamePreload.js'), 'utf-8');
        for (const channel of ['cleo-saves:list', 'cleo-saves:read', 'cleo-saves:write', 'cleo-saves:remove'])
            expect(preload).toContain(`'${channel}'`);
        // A sandboxed preload cannot require local files.
        const requires = [...preload.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]);
        expect(requires).toEqual(['electron']);
        expect(preload).toContain("exposeInMainWorld('cleoSaves'");
    });
});

describe('the desktop game main.js', () => {
    const templates = require(join(DESKTOP, 'gameTemplates.js'));

    it('keeps its data in the folder window.json names, set before the app is ready', () => {
        const main: string = templates.GAME_MAIN_JS;
        expect(main).toContain("require('./gameSaves')");
        const setPath = main.indexOf("app.setPath('userData'");
        expect(setPath).toBeGreaterThan(0);
        expect(setPath).toBeLessThan(main.indexOf('app.whenReady()'));
        expect(main).toContain("gameSaves.register(ipcMain, path.join(app.getPath('userData'), 'saves'))");
    });
});
