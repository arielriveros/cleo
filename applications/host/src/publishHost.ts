// Publish ▸ Host (docs/design/netsync.md §7.2): a game's dedicated host as a folder a developer deploys wherever they
// choose. The same game.bin and game.scripts.js as the web build (one content hash), the built cleo-host and
// cleo-allocator, and the files each kind of hosting starts from:
//
//   cleo-host.mjs, cleo-allocator.mjs, chunks/    the host and the allocator + gateway (npm run build:host)
//   package.json                                  their npm dependencies (the WebTransport addon is native)
//   game/game.bin, game/game.scripts.js           the game
//   Dockerfile                                    the container image: node:24-trixie-slim (glibc ≥ 2.38)
//   docker-compose.yml, netsync.hosting.json      one VPS: two warm hosts and the allocator + gateway on 443
//   deploy/cleo-host@.service                     one VPS without Docker: systemd, one unit per host
//   deploy/agones-fleet.yaml                      Kubernetes + Agones: a Fleet of hosts
//   deploy/edgegap.md                             Edgegap: the app version's settings
//   README.md                                     what to do with each
//
// Moving between providers is a template and two adapter names; the image and the game stay the same.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
/** Where `npm run build:host` leaves the built host. */
export const HOST_DIST = path.resolve(here, '../dist');

/** The npm packages the built host loads from node_modules, pinned as this repo's host is. */
export function hostDependencies(): Record<string, string> {
    const pkg = JSON.parse(readFileSync(path.resolve(here, '../package.json'), 'utf8'));
    return pkg.dependencies;
}

export interface PublishHostInput {
    /** The game, as published for the web. */
    bin: Uint8Array;
    scripts: string;
    /** A name for the image and services: lowercase, digits and dashes. */
    name: string;
    /** The built host's files by path (cleo-host.mjs, chunks/…); default: read from HOST_DIST. */
    hostFiles?: Map<string, Uint8Array>;
}

/** Every file of the published host folder, by its path in it. */
export function publishHostFiles(input: PublishHostInput): Map<string, Uint8Array> {
    const name = input.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'game';
    const files = new Map<string, Uint8Array>();
    const text = (p: string, s: string) => files.set(p, new TextEncoder().encode(s));
    for (const [p, bytes] of input.hostFiles ?? readHostDist()) if (!p.endsWith('.map')) files.set(p, bytes);
    files.set('game/game.bin', input.bin);
    text('game/game.scripts.js', input.scripts);
    text('package.json', JSON.stringify({
        name: `${name}-host`, private: true, type: 'module',
        description: `${input.name}: its NetSync dedicated host (cleo-host) and allocator + gateway (cleo-allocator).`,
        scripts: { start: 'node cleo-host.mjs', allocator: 'node cleo-allocator.mjs --config netsync.hosting.json', keys: 'node cleo-allocator.mjs --keys' },
        engines: { node: '>=22' },
        dependencies: hostDependencies(),
    }, null, 2) + '\n');
    text('.dockerignore', 'node_modules\nnpm-debug.log\n.env\ntls/\n');
    text('Dockerfile', DOCKERFILE);
    text('docker-compose.yml', compose(name));
    text('netsync.hosting.json', JSON.stringify(STATIC_HOSTING, null, 2) + '\n');
    text('.env.example', ENV_EXAMPLE);
    text('deploy/cleo-host@.service', systemd(name));
    text('deploy/agones-fleet.yaml', agones(name));
    text('deploy/edgegap.md', EDGEGAP);
    text('README.md', readme(input.name, name));
    return files;
}

function readHostDist(): Map<string, Uint8Array> {
    if (!existsSync(path.join(HOST_DIST, 'cleo-host.mjs'))) throw new Error(`No built host at ${HOST_DIST}: run "npm run build:host" first.`);
    const out = new Map<string, Uint8Array>();
    const walk = (dir: string, prefix: string) => {
        for (const entry of readdirSync(dir)) {
            const full = path.join(dir, entry);
            if (statSync(full).isDirectory()) walk(full, `${prefix}${entry}/`);
            else out.set(`${prefix}${entry}`, new Uint8Array(readFileSync(full)));
        }
    };
    walk(HOST_DIST, '');
    return out;
}

// ----- templates -------------------------------------------------------------------------------------------------

const DOCKERFILE = `# The game's NetSync host. One image runs either a host (the default command) or the allocator + gateway
# (node cleo-allocator.mjs --config …). Debian 13: the WebTransport addon needs glibc 2.38 or newer.
FROM node:24-trixie-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY . .
ENV NETSYNC_GAME=/app/game/game.bin \\
    NETSYNC_SCRIPTS=/app/game/game.scripts.js \\
    NETSYNC_LOG=json
# WebTransport (UDP), WebSocket (TCP), control (TCP; keep it off the internet).
EXPOSE 4433/udp 4480/tcp 4490/tcp
USER node
# SIGTERM drains: no new players, the session ends, then the host exits (NETSYNC_DRAIN_SECONDS).
STOPSIGNAL SIGTERM
CMD ["node", "cleo-host.mjs"]
`;

function compose(name: string): string {
    const host = (n: number) => `  host-${n}:
    image: ${name}-host
    restart: unless-stopped
    environment:
      NETSYNC_AWAIT_ALLOCATION: "1"
      NETSYNC_REUSE: "1"
      NETSYNC_UDP_PORT: "${4432 + n}"
      NETSYNC_PUBLIC_ADDRESS: \${PUBLIC_ADDRESS}
      NETSYNC_TOKEN_KEY: \${NETSYNC_TOKEN_KEY}
    # Only WebTransport is published: the allocator reaches WebSocket and control over this network.
    # A host's UDP port is the same inside and out (it tells players its own).
    ports: ["${4432 + n}:${4432 + n}/udp"]
    stop_grace_period: 45s
`;
    return `# One VPS (docs/design/netsync.md §7.1, option A): two warm hosts (one match each at a time, reset after it) and
# the allocator + gateway on 443. Add hosts by copying a block (next UDP port) and listing it in
# netsync.hosting.json. Put PUBLIC_ADDRESS and the token keys in .env (see .env.example).
#
#   docker compose build && docker compose up -d
services:
${host(1)}
${host(2)}
  allocator:
    image: ${name}-host
    build: .
    restart: unless-stopped
    command: ["node", "cleo-allocator.mjs", "--config", "/app/netsync.hosting.json"]
    environment:
      NETSYNC_TOKEN_PRIVATE_KEY: \${NETSYNC_TOKEN_PRIVATE_KEY}
      NETSYNC_ALLOCATOR_PORT: "8443"
    ports: ["443:8443/tcp"]
    volumes:
      - ./netsync.hosting.json:/app/netsync.hosting.json:ro
      - ./tls:/app/tls:ro
    depends_on: [host-1, host-2]
`;
}

const STATIC_HOSTING = {
    port: 8443,
    tls: { cert: 'tls/fullchain.pem', key: 'tls/privkey.pem' },
    gatewayUrl: 'wss://play.example.com',
    maxPeers: 16,
    modes: { coop: { maxPeers: 8 } },
    fleet: {
        type: 'static',
        hosts: [
            { name: 'host-1', control: 'http://host-1:4490', publicAddress: 'REPLACE-WITH-PUBLIC-ADDRESS', privateAddress: 'host-1' },
            { name: 'host-2', control: 'http://host-2:4490', publicAddress: 'REPLACE-WITH-PUBLIC-ADDRESS', privateAddress: 'host-2' },
        ],
    },
};

const ENV_EXAMPLE = `# The address players reach this machine at (an IP, or a name).
PUBLIC_ADDRESS=203.0.113.5
# npm run keys (or: docker compose run --rm allocator node cleo-allocator.mjs --keys) prints a pair, one line each.
NETSYNC_TOKEN_PRIVATE_KEY=
NETSYNC_TOKEN_KEY=
`;

function systemd(name: string): string {
    return `# One VPS without Docker: a host per instance (cleo-host@1, cleo-host@2…), each on its own UDP port.
#   sudo cp -r . /opt/${name}-host && cd /opt/${name}-host && npm install --omit=dev
#   sudo cp deploy/cleo-host@.service /etc/systemd/system/ && sudo systemctl enable --now cleo-host@1 cleo-host@2
# Node 22 or newer, and glibc 2.38 or newer (Debian 13, Ubuntu 24.04) for the WebTransport addon.
[Unit]
Description=${name} NetSync host %i
After=network-online.target

[Service]
WorkingDirectory=/opt/${name}-host
ExecStart=/usr/bin/node cleo-host.mjs
Environment=NETSYNC_GAME=/opt/${name}-host/game/game.bin
Environment=NETSYNC_AWAIT_ALLOCATION=1
Environment=NETSYNC_REUSE=1
Environment=NETSYNC_LOG=json
Environment=NETSYNC_UDP_PORT=443%i
Environment=NETSYNC_TCP_PORT=448%i
Environment=NETSYNC_CONTROL_PORT=449%i
EnvironmentFile=-/etc/${name}-host.env
KillSignal=SIGTERM
TimeoutStopSec=45
Restart=always
DynamicUser=yes

[Install]
WantedBy=multi-user.target
`;
}

function agones(name: string): string {
    return `# Kubernetes + Agones (docs/design/netsync.md §7.1, option C): a Fleet of warm hosts. The allocator's agones fleet
# adapter allocates from it ({"type": "agones", "fleet": "${name}"}), and needs a ServiceAccount allowed to create
# gameserverallocations and read gameservers. Push the image somewhere the cluster can pull from first.
apiVersion: agones.dev/v1
kind: Fleet
metadata:
  name: ${name}
spec:
  replicas: 2
  template:
    spec:
      ports:
        - name: webtransport
          portPolicy: Dynamic
          containerPort: 4433
          protocol: UDP
        - name: websocket
          portPolicy: Dynamic
          containerPort: 4480
          protocol: TCP
      health:
        initialDelaySeconds: 10
        periodSeconds: 5
      template:
        spec:
          terminationGracePeriodSeconds: 45
          containers:
            - name: host
              image: REPLACE-WITH-REGISTRY/${name}-host:latest
              env:
                - { name: NETSYNC_LIFECYCLE, value: agones }
                - { name: NETSYNC_AWAIT_ALLOCATION, value: "1" }
                - name: NETSYNC_TOKEN_KEY
                  valueFrom: { secretKeyRef: { name: ${name}-netsync, key: token-public-key } }
              resources:
                requests: { cpu: "1", memory: 512Mi }
                limits: { cpu: "1", memory: 1Gi }
`;
}

const EDGEGAP = `# Edgegap

Edgegap starts a host per match, near the first player (docs/design/netsync.md §7.1, option B).

1. Push the image (\`docker build -t REGISTRY/<name>-host .\`) to a registry Edgegap can pull from.
2. Create an application and a version with that image, 1 vCPU, and two ports:
   - \`webtransport\`: 4433, UDP
   - \`websocket\`: 4480, TCP
   Leave TLS upgrade off for both (the host pins its own certificate; the gateway does TLS for WebSocket).
3. Run the allocator somewhere that stays up (a small VPS: see docker-compose.yml, allocator service only) with
   \`"fleet": { "type": "edgegap", "application": "<app>", "version": "<version>" }\` and the API token in
   \`NETSYNC_EDGEGAP_TOKEN\`, exactly as Edgegap's dashboard shows it.

The allocator hands each deployment its session, the join-token public key and a certificate
(\`NETSYNC_SESSION\`, \`NETSYNC_TOKEN_KEY\`, \`NETSYNC_CERT\`, \`NETSYNC_CERT_KEY\`) and sets
\`NETSYNC_LIFECYCLE=edgegap\`, so the host stops its own deployment when the match ends.
`;

function readme(title: string, name: string): string {
    return `# ${title}: dedicated host

This folder runs the game's NetSync host. Publish ▸ Web gives the game players open; this is what they join. Both
come from the same build, so their content hash matches.

- \`cleo-host.mjs\`: runs the game headless for one session (a match) of up to 16 players.
- \`cleo-allocator.mjs\`: the allocator (hands players a join ticket for a host) and the gateway (the WebSocket
  fallback on 443). The only piece that has to stay up between matches.

Every host setting is an environment variable: \`node cleo-host.mjs --help\` lists them.

## Try it on this machine

\`\`\`sh
npm install --omit=dev
node cleo-host.mjs --game game/game.bin            # one host, its session open for good
\`\`\`

## Where to run it

| | Start from | Fleet / lifecycle |
|---|---|---|
| One VPS, Docker | \`docker-compose.yml\`, \`netsync.hosting.json\`, \`.env.example\` | \`static\` / \`none\` |
| One VPS, no Docker | \`deploy/cleo-host@.service\` | \`static\` / \`none\` |
| Kubernetes + Agones | \`deploy/agones-fleet.yaml\` | \`agones\` / \`agones\` |
| Edgegap | \`deploy/edgegap.md\` | \`edgegap\` / \`edgegap\` |
| A Docker host of your own, a container per match | the image | \`docker\` / \`none\` |

Start with one VPS: cheapest and simplest. The host needs UDP (any port) and the gateway TCP 443 with a real
certificate for your domain (\`tls/\`). Keep each host's control port (4490) off the internet.

## The game page

Players open the web build with a join ticket from the allocator: \`POST https://play.example.com/join\` with
\`{"mode": "coop"}\` answers \`{endpoint, token, session}\`; open the game at \`?join=<that JSON, URL-encoded>\`.
`;
}
