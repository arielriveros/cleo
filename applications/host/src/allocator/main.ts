// cleo-allocator (docs/design/netsync.md §7.2): the allocator and the gateway, one small service.
//
//   npm run allocator -- --config netsync.hosting.json
//   npm run allocator -- --keys          print a new join-token key pair (private: the allocator; public: hosts)
//
// netsync.hosting.json (secrets may come from the environment instead):
//
//   {
//     "port": 8443,                                   // NETSYNC_ALLOCATOR_PORT
//     "tls": { "cert": "/etc/ssl/play.pem", "key": "/etc/ssl/play.key" },   // or none, behind a TLS proxy
//     "gatewayUrl": "wss://play.example.com",         // the public URL of this service's WebSocket side
//     "privateKey": "…",                              // NETSYNC_TOKEN_PRIVATE_KEY
//     "maxPeers": 16,
//     "modes": { "coop": { "maxPeers": 8 }, "deathmatch": { "maxPeers": 16, "scene": "Arena" } },
//     "hooks": "./hooks.mjs",                         // exports onRequest(join, req) and/or chooseRegion(join, req)
//     "fleet": { "type": "static", "hosts": [ { "name": "fra-1", "control": "http://10.0.0.5:4490", "publicAddress": "203.0.113.5" } ] }
//     //       { "type": "docker", "image": "mygame-host:1.2", "publicAddress": "203.0.113.5" }
//     //       { "type": "agones", "fleet": "mygame" }
//     //       { "type": "edgegap", "apiToken": "…", "application": "mygame", "version": "1.2" }   // NETSYNC_EDGEGAP_TOKEN
//   }

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { generateTokenKeys } from '../joinToken';
import { Allocator } from './allocator';
import { AgonesFleet, DockerFleet, EdgegapFleet, StaticFleet, type FleetAdapter } from './fleet';

const args = process.argv.slice(2);
const arg = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const log = (line: string) => console.log(`[${new Date().toISOString().slice(11, 23)}] ${line}`);

if (args.includes('--keys')) {
    const k = generateTokenKeys();
    const oneLine = (pem: string) => pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
    console.log(`# The allocator's, secret (for an env file, one line):\nNETSYNC_TOKEN_PRIVATE_KEY=${oneLine(k.privateKey)}\n` +
        `# Every host's (public):\nNETSYNC_TOKEN_KEY=${oneLine(k.publicKey)}\n\n# The same as PEM:\n${k.privateKey}${k.publicKey}`);
    process.exit(0);
}

const configPath = arg('--config') ?? process.env.NETSYNC_HOSTING_CONFIG ?? 'netsync.hosting.json';
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const dir = path.dirname(path.resolve(configPath));
const privateKey: string = process.env.NETSYNC_TOKEN_PRIVATE_KEY ?? config.privateKey;
if (!privateKey) throw new Error('No join-token key: set NETSYNC_TOKEN_PRIVATE_KEY (npm run allocator -- --keys makes a pair).');
// Hosts started per match get the public half.
const tokenKey = createPublicKey(createPrivateKey(privateKey.includes('-----BEGIN') ? privateKey : { key: Buffer.from(privateKey, 'base64'), format: 'der', type: 'pkcs8' }))
    .export({ type: 'spki', format: 'pem' }).toString();

const f = config.fleet ?? {};
let fleet: FleetAdapter;
switch (f.type) {
    case 'static': fleet = new StaticFleet(f.hosts ?? []); break;
    case 'docker': fleet = new DockerFleet({ ...f, tokenKey }); break;
    case 'agones': fleet = new AgonesFleet(f); break;
    case 'edgegap': fleet = new EdgegapFleet({ ...f, apiToken: process.env.NETSYNC_EDGEGAP_TOKEN ?? f.apiToken, tokenKey }); break;
    default: throw new Error(`fleet.type must be static, docker, agones or edgegap (got ${JSON.stringify(f.type)})`);
}

const hooks = config.hooks ? await import(pathToFileURL(path.resolve(dir, config.hooks)).href) : {};
const read = (p?: string) => (p ? readFileSync(path.resolve(dir, p), 'utf8') : undefined);
const allocator = await Allocator.start({
    fleet, privateKey,
    port: Number(process.env.NETSYNC_ALLOCATOR_PORT ?? config.port ?? 8080),
    tls: config.tls ? { cert: read(config.tls.cert)!, key: read(config.tls.key)! } : undefined,
    gatewayUrl: config.gatewayUrl,
    maxPeers: config.maxPeers,
    modes: config.modes,
    routeSecret: process.env.NETSYNC_ROUTE_SECRET ?? config.routeSecret,
    onRequest: hooks.onRequest, chooseRegion: hooks.chooseRegion,
    log,
});
log(`cleo-allocator on ${config.tls ? 'https' : 'http'}://localhost:${allocator.port} (POST /join), gateway ${config.gatewayUrl ?? 'off (tickets name hosts directly)'}, fleet ${fleet.name}`);

const stop = async () => { await allocator.close(); process.exit(0); };
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
