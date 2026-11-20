// Publish ▸ Host (publishHost.ts): the folder a developer deploys. The built host and allocator, the same game as the
// web build, and a starting point for each kind of hosting. (The image itself was built and run in Docker: see the
// phase-9 notes in docs/design/netsync.md.)
import { describe, expect, it } from 'vitest';
import { hostDependencies, publishHostFiles } from '../src/publishHost';

const text = (files: Map<string, Uint8Array>, p: string) => new TextDecoder().decode(files.get(p)!);

describe('a published host folder', () => {
    const bin = new Uint8Array([1, 2, 3]);
    const files = publishHostFiles({
        bin, scripts: 'window.CLEO_GAME_SCRIPTS = {}', name: 'My Game!',
        hostFiles: new Map([['cleo-host.mjs', new Uint8Array([1])], ['cleo-allocator.mjs', new Uint8Array([2])], ['chunks/a.mjs', new Uint8Array([3])], ['cleo-host.mjs.map', new Uint8Array([4])]]),
    });

    it('holds the built host, the game and a template per kind of hosting', () => {
        expect([...files.keys()].sort()).toEqual([
            '.dockerignore', '.env.example', 'Dockerfile', 'README.md', 'chunks/a.mjs', 'cleo-allocator.mjs', 'cleo-host.mjs',
            'deploy/agones-fleet.yaml', 'deploy/cleo-host@.service', 'deploy/edgegap.md', 'docker-compose.yml', 'game/game.bin',
            'game/game.scripts.js', 'netsync.hosting.json', 'package.json',
        ]);
        expect(files.get('game/game.bin')).toBe(bin);
    });

    it('pins the host’s npm packages and names everything after the game', () => {
        const pkg = JSON.parse(text(files, 'package.json'));
        expect(pkg.name).toBe('my-game-host');
        expect(pkg.dependencies).toEqual(hostDependencies());
        expect(pkg.dependencies['@fails-components/webtransport']).toMatch(/^\d/);
        expect(text(files, 'docker-compose.yml')).toContain('image: my-game-host');
        expect(text(files, 'deploy/agones-fleet.yaml')).toContain('name: my-game');
    });

    it('builds on a base the WebTransport addon loads on, and drains on SIGTERM', () => {
        const docker = text(files, 'Dockerfile');
        expect(docker).toContain('FROM node:24-trixie-slim');
        expect(docker).toContain('EXPOSE 4433/udp 4480/tcp 4490/tcp');
        expect(docker).toContain('STOPSIGNAL SIGTERM');
        // One VPS: each host's UDP port the same inside and out, and the allocator on 443.
        const compose = text(files, 'docker-compose.yml');
        expect(compose).toContain('ports: ["4433:4433/udp"]');
        expect(compose).toContain('ports: ["4434:4434/udp"]');
        expect(compose).toContain('ports: ["443:8443/tcp"]');
        const hosting = JSON.parse(text(files, 'netsync.hosting.json'));
        expect(hosting.fleet.hosts.map((h: any) => h.control)).toEqual(['http://host-1:4490', 'http://host-2:4490']);
    });
});
