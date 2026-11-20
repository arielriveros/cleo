import { describe, expect, it } from 'vitest';
import { HELP, readSettings } from '../src/settings';

// The two settings the desktop editor starts its dev host with (app-kit/desktop/devHostProcess.js): where the
// certificate is kept (an installed app cannot write beside its own files) and whose process the host goes with.

describe('the dev host settings', () => {
    it('keeps the certificate where it is told, by flag or environment, and beside the host otherwise', () => {
        expect(readSettings(['--dev', '--cache', 'C:/data/dev-host'], {}).cacheDir).toBe('C:/data/dev-host');
        expect(readSettings(['--dev'], { NETSYNC_CACHE: '/var/cache/cleo' }).cacheDir).toBe('/var/cache/cleo');
        expect(readSettings(['--dev'], {}).cacheDir).toBeUndefined();
    });

    it('takes the process it goes with as a number, and refuses anything else', () => {
        expect(readSettings(['--dev', '--owner-pid', '1234'], {}).ownerPid).toBe(1234);
        expect(readSettings(['--dev'], {}).ownerPid).toBeUndefined();
        expect(() => readSettings(['--dev', '--owner-pid', 'abc'], {})).toThrow(/not a number/);
    });

    it('lists both in --help', () => {
        expect(HELP).toContain('--cache <folder>');
        expect(HELP).toContain('--owner-pid <n>');
    });
});
