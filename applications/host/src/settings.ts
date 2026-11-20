// cleo-host's settings (docs/design/netsync.md §7.2, "the host contract"). Each comes from, in order: a command-line
// flag, an environment variable (what a container platform sets), the game's own NetSync settings (`config.netsync`
// in game.bin, set in the editor's Project › NetSync), then the default.
//
//   flag                  environment                 game config     default
//   --game <file>         NETSYNC_GAME                                 (none: a session only)
//   --scripts <file>      NETSYNC_SCRIPTS                              game.scripts.js beside the game
//   --example <folder>                                                 (development: pack a project folder)
//   --serve                                                            (with --example: serve it as a web game)
//   --dev                                                              Play › Multiplayer's host: waits for the
//                                                                      editor's game on 127.0.0.1:4490
//   --wt-port <n>         NETSYNC_UDP_PORT                             4433   WebTransport (UDP)
//   --ws-port <n>         NETSYNC_TCP_PORT                             4480   WebSocket (TCP)
//   --control-port <n>    NETSYNC_CONTROL_PORT                         4490   HTTP control (off: none; 0: any free port)
//   --public-address <a>  NETSYNC_PUBLIC_ADDRESS                       (the request's Host header)
//   --session <json>      NETSYNC_SESSION             —                (none: wait for an allocation, or open now)
//   --token-key <key>     NETSYNC_TOKEN_KEY                            (none: no join token asked)
//   --lifecycle <name>    NETSYNC_LIFECYCLE                            none   none | agones | edgegap
//                         NETSYNC_CERT, NETSYNC_CERT_KEY               (made at start) the WebTransport certificate,
//                                                                      PEM or base64 PEM (an allocator that starts
//                                                                      the host hands it one whose hash it knows)
//   --await-allocation    NETSYNC_AWAIT_ALLOCATION=1                   off    a warm host: no session until allocated
//   --reuse               NETSYNC_REUSE=1                              off    after a session, wait for the next
//   --drain-seconds <n>   NETSYNC_DRAIN_SECONDS                        30
//   --empty-seconds <n>   NETSYNC_EMPTY_SECONDS                        30     a session everyone left ends after this
//   --join-seconds <n>    NETSYNC_JOIN_SECONDS                         120    an allocated session nobody joined ends
//   --log <fmt>           NETSYNC_LOG                                  text   text | json
//   --control-secret <s>  NETSYNC_CONTROL_SECRET                       (none) bearer for POST /allocate
//   --tick-rate <n>       NETSYNC_TICK_RATE           tickRate         30
//   --max-peers <n>       NETSYNC_MAX_PEERS           maxPeers         16
//   --player-template <t> NETSYNC_PLAYER_TEMPLATE     playerTemplate   (none: only the level's own player characters)
//   --spawn x,y,z         NETSYNC_SPAWN               spawn            0,1,0
//   --trust coop|versus   NETSYNC_TRUST               trust            coop
//   --physics <backend>   NETSYNC_PHYSICS                              the game's

export interface SessionSpec {
    /** The session's id: join tokens name it. */
    id: string;
    /** Scene to start it in (the game's entry scene when absent). */
    scene?: string;
    /** Game mode (co-op, deathmatch…): reported on /status, and handed to the game (HostApp.session). */
    mode?: string;
    maxPeers?: number;
}

export interface HostSettings {
    game?: string;
    scripts?: string;
    example?: string;
    serve: boolean;
    udpPort: number;
    tcpPort: number;
    controlPort: number;
    publicAddress?: string;
    session?: SessionSpec;
    tokenKey?: string;
    lifecycle: 'none' | 'agones' | 'edgegap';
    certPem?: string;
    keyPem?: string;
    awaitAllocation: boolean;
    reuse: boolean;
    drainSeconds: number;
    emptySeconds: number;
    joinSeconds: number;
    log: 'text' | 'json';
    controlSecret?: string;
    verbose: boolean;
    physics?: string;
    /** Left undefined when neither a flag nor the environment set them: the game's config decides (see gameDefaults). */
    tickRate?: number;
    maxPeers?: number;
    playerTemplate?: string;
    spawn?: number[];
    trust?: 'coop' | 'versus';
}

/** What a game says about itself in `config.netsync` (Project › NetSync). */
export interface GameNetSyncConfig {
    tickRate?: number;
    maxPeers?: number;
    playerTemplate?: string;
    spawn?: number[];
    trust?: 'coop' | 'versus';
}

export function readSettings(argv: readonly string[], env: Record<string, string | undefined>): HostSettings {
    const flag = (name: string): string | undefined => {
        const i = argv.indexOf(name);
        return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
    };
    const has = (name: string) => argv.includes(name);
    const pick = (f: string, e: string) => flag(f) ?? (env[e] !== undefined && env[e] !== '' ? env[e] : undefined);
    const num = (f: string, e: string, fallback?: number): number | undefined => {
        const v = pick(f, e);
        if (v === undefined) return fallback;
        const n = Number(v);
        if (!Number.isFinite(n)) throw new Error(`${f} / ${e}: "${v}" is not a number`);
        return n;
    };
    const on = (f: string, e: string) => has(f) || /^(1|true|yes|on)$/i.test(env[e] ?? '');
    const sessionText = pick('--session', 'NETSYNC_SESSION');
    let session: SessionSpec | undefined;
    if (sessionText) {
        session = JSON.parse(sessionText);
        if (!session?.id) throw new Error('--session / NETSYNC_SESSION needs an "id"');
    }
    const lifecycle = pick('--lifecycle', 'NETSYNC_LIFECYCLE') ?? 'none';
    if (lifecycle !== 'none' && lifecycle !== 'agones' && lifecycle !== 'edgegap') throw new Error(`--lifecycle / NETSYNC_LIFECYCLE: unknown "${lifecycle}" (none | agones | edgegap)`);
    const trust = pick('--trust', 'NETSYNC_TRUST');
    if (trust !== undefined && trust !== 'coop' && trust !== 'versus') throw new Error(`--trust / NETSYNC_TRUST: "${trust}" (coop | versus)`);
    const spawn = pick('--spawn', 'NETSYNC_SPAWN');
    return {
        game: pick('--game', 'NETSYNC_GAME'),
        scripts: pick('--scripts', 'NETSYNC_SCRIPTS'),
        example: flag('--example'),
        serve: has('--serve'),
        udpPort: num('--wt-port', 'NETSYNC_UDP_PORT', 4433)!,
        tcpPort: num('--ws-port', 'NETSYNC_TCP_PORT', 4480)!,
        controlPort: pick('--control-port', 'NETSYNC_CONTROL_PORT') === 'off' ? -1 : num('--control-port', 'NETSYNC_CONTROL_PORT', 4490)!,
        publicAddress: pick('--public-address', 'NETSYNC_PUBLIC_ADDRESS'),
        session,
        tokenKey: pick('--token-key', 'NETSYNC_TOKEN_KEY'),
        lifecycle: lifecycle as HostSettings['lifecycle'],
        certPem: env.NETSYNC_CERT || undefined,
        keyPem: env.NETSYNC_CERT_KEY || undefined,
        awaitAllocation: on('--await-allocation', 'NETSYNC_AWAIT_ALLOCATION'),
        reuse: on('--reuse', 'NETSYNC_REUSE'),
        drainSeconds: num('--drain-seconds', 'NETSYNC_DRAIN_SECONDS', 30)!,
        emptySeconds: num('--empty-seconds', 'NETSYNC_EMPTY_SECONDS', 30)!,
        joinSeconds: num('--join-seconds', 'NETSYNC_JOIN_SECONDS', 120)!,
        log: pick('--log', 'NETSYNC_LOG') === 'json' ? 'json' : 'text',
        controlSecret: pick('--control-secret', 'NETSYNC_CONTROL_SECRET'),
        verbose: has('--verbose'),
        physics: pick('--physics', 'NETSYNC_PHYSICS'),
        tickRate: num('--tick-rate', 'NETSYNC_TICK_RATE'),
        maxPeers: num('--max-peers', 'NETSYNC_MAX_PEERS'),
        playerTemplate: pick('--player-template', 'NETSYNC_PLAYER_TEMPLATE'),
        spawn: spawn ? spawn.split(',').map(Number) : undefined,
        trust: trust as HostSettings['trust'],
    };
}

/** The settings a game's own config fills in where neither a flag nor the environment did. */
export function withGameDefaults(s: HostSettings, game: GameNetSyncConfig | undefined): Required<Pick<HostSettings, 'tickRate' | 'maxPeers' | 'spawn' | 'trust'>> & { playerTemplate?: string } {
    const g = game ?? {};
    return {
        tickRate: s.tickRate ?? (typeof g.tickRate === 'number' ? g.tickRate : 30),
        maxPeers: s.maxPeers ?? (typeof g.maxPeers === 'number' ? g.maxPeers : 16),
        playerTemplate: s.playerTemplate ?? (typeof g.playerTemplate === 'string' && g.playerTemplate ? g.playerTemplate : undefined),
        spawn: s.spawn ?? (Array.isArray(g.spawn) && g.spawn.length === 3 ? g.spawn : [0, 1, 0]),
        trust: s.trust ?? (g.trust === 'versus' ? 'versus' : 'coop'),
    };
}

/** `cleo-host --help`: the table above. */
export const HELP = "cleo-host: a NetSync dedicated host (Cleo docs/design/netsync.md, section 7.2).\n\nEach setting: a flag, else its environment variable, else the game's config.netsync, else the default.\n\n   flag                  environment                 game config     default\n   --game <file>         NETSYNC_GAME                                 (none: a session only)\n   --scripts <file>      NETSYNC_SCRIPTS                              game.scripts.js beside the game\n   --example <folder>                                                 (development: pack a project folder)\n   --serve                                                            (with --example: serve it as a web game)\n   --dev                                                              Play › Multiplayer's host: waits for the\n                                                                      editor's game on 127.0.0.1:4490\n   --wt-port <n>         NETSYNC_UDP_PORT                             4433   WebTransport (UDP)\n   --ws-port <n>         NETSYNC_TCP_PORT                             4480   WebSocket (TCP)\n   --control-port <n>    NETSYNC_CONTROL_PORT                         4490   HTTP control (off: none; 0: any free port)\n   --public-address <a>  NETSYNC_PUBLIC_ADDRESS                       (the request's Host header)\n   --session <json>      NETSYNC_SESSION             —                (none: wait for an allocation, or open now)\n   --token-key <key>     NETSYNC_TOKEN_KEY                            (none: no join token asked)\n   --lifecycle <name>    NETSYNC_LIFECYCLE                            none   none | agones | edgegap\n                         NETSYNC_CERT, NETSYNC_CERT_KEY               (made at start) the WebTransport certificate,\n                                                                      PEM or base64 PEM (an allocator that starts\n                                                                      the host hands it one whose hash it knows)\n   --await-allocation    NETSYNC_AWAIT_ALLOCATION=1                   off    a warm host: no session until allocated\n   --reuse               NETSYNC_REUSE=1                              off    after a session, wait for the next\n   --drain-seconds <n>   NETSYNC_DRAIN_SECONDS                        30\n   --empty-seconds <n>   NETSYNC_EMPTY_SECONDS                        30     a session everyone left ends after this\n   --join-seconds <n>    NETSYNC_JOIN_SECONDS                         120    an allocated session nobody joined ends\n   --log <fmt>           NETSYNC_LOG                                  text   text | json\n   --control-secret <s>  NETSYNC_CONTROL_SECRET                       (none) bearer for POST /allocate\n   --tick-rate <n>       NETSYNC_TICK_RATE           tickRate         30\n   --max-peers <n>       NETSYNC_MAX_PEERS           maxPeers         16\n   --player-template <t> NETSYNC_PLAYER_TEMPLATE     playerTemplate   (none: only the level's own player characters)\n   --spawn x,y,z         NETSYNC_SPAWN               spawn            0,1,0\n   --trust coop|versus   NETSYNC_TRUST               trust            coop\n   --physics <backend>   NETSYNC_PHYSICS                              the game's\n";
