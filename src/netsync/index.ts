// NetSync: online multiplayer for Cleo (docs/design/netsync.md). Phase 1 — links and sessions.
//
// Everything here runs in the browser, in a worker and in Node: no DOM, no Node built-ins. The host's
// listeners (the WebTransport and WebSocket servers) are Node-only and live in applications/host.

export { ByteReader, ByteWriter } from './bytes';
export { FixedTicker, ManualScheduler, realScheduler } from './time';
export type { Scheduler } from './time';

export { LinkBase, PULSE_BUDGET, concatBytes, frame, frameReader } from './link/netLink';
export type { LinkKind, NetLink } from './link/netLink';
export { WebTransportLink } from './link/webTransportLink';
export type { DatagramWriterKind, WebTransportLike } from './link/webTransportLink';
export { WEBSOCKET_BACKLOG_LIMIT, WebSocketLink, openWebSocket } from './link/webSocketLink';
export type { WebSocketLike } from './link/webSocketLink';
export { createLoopbackPair } from './link/loopbackLink';
export { ConditionedLink } from './link/conditionedLink';
export type { LinkConditions } from './link/conditionedLink';
export { connect } from './link/connect';
export type { ConnectOptions, Connection, HostEndpoint } from './link/connect';

export { ClockSync } from './session/clockSync';
export { FIRST_APP_TYPE, NETSYNC_PROTOCOL, hashContent } from './session/messages';
export type { Hello, RefuseCode } from './session/messages';
export { HostPeer, HostSession } from './session/hostSession';
export type { HostSessionEvents, HostSessionOptions } from './session/hostSession';
export { JoinRefusedError, PeerSession } from './session/peerSession';
export type { JoinOptions, PeerSessionEvents, PeerState } from './session/peerSession';

// Phase 3: synced state.
export { packQuaternion, quantizeState, sameState, unpackQuaternion, POSITION_SCALE, VELOCITY_SCALE } from './sync/quantize';
export type { QState } from './sync/quantize';
export { SyncHost, defaultIsSynced } from './sync/syncHost';
export type { SyncHostOptions, SyncPeerStats } from './sync/syncHost';
export { SyncPeer } from './sync/syncPeer';
export type { SyncPeerOptions } from './sync/syncPeer';

// Phase 4: remote control.
export { COMMAND_TYPE, CommandQueue, PeerCommands, POSSESS_TYPE, RemoteControl, decodeCommands, encodeCommands } from './sync/commands';
export type { Command, RemoteControlOptions } from './sync/commands';

// Phase 5: prediction.
export { followerSceneJson } from './sync/syncPeer';
export { Predictor } from './sync/predictor';
export type { PredictionStats, PredictorOptions } from './sync/predictor';

// Phase 6: carrying and weapons.
export { CarryHost, CarryPeer } from './sync/carry';
export type { CarryHostOptions, CarryHostStats, CarryPeerOptions, Trust } from './sync/carry';
export { LagCompensator, WeaponHost, WeaponPeer } from './sync/weapons';
export type { HitEvent, HitReport, WeaponHostOptions, WeaponHostStats } from './sync/weapons';

// Phase 7: scripts.
export { ScriptHost, ScriptPeer, decodeValue, encodeValue } from './sync/scriptSync';
export type { ScriptHostOptions, ScriptHostStats, ScriptPeerOptions } from './sync/scriptSync';
