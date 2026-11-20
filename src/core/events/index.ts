// The event system: channels on a hub, delivered sync, async or deferred, to listeners on the channel or on a node.
// See hub.ts for the tour, and docs/scripting/events.md for what scripts see.
export { Emitter } from './emitter';
export { ChannelEmitter } from './channelEmitter';
export type { EventListenerFn, EventWhere, ListenOptions, ListenerRecord, ListenerList } from './emitter';
export { CleoEvent } from './event';
export type { EventPhase, DispatchFrame } from './event';
export { currentEvent, setEventErrorReporter, MAX_EVENT_DEPTH } from './dispatcher';
export type { EventErrorReporter } from './dispatcher';
export { EventChannel } from './channel';
export type { ChannelOptions, DispatchOptions, PostOptions, NextOptions, QueuedEvent } from './channel';
export { Subject, ValueSubject } from './subject';
export type { SubjectObserver } from './subject';
export { targetListenerCount, scriptListenerCount } from './eventTarget';
export type { EventTargetLike } from './eventTarget';
export { setEventTransportResolver, routeEvent } from './broker';
export type { EventTransport, EventTransportResolver, TransportResult, RemoteEventTarget, EventDestination, EventRoute } from './broker';
export {
    Events, CANCEL_EVENT, DEFAULT_CHANNEL, ANIMATION_CHANNEL, ENGINE_CHANNEL,
    getChannel, allChannels, splitEventName, resolveEvent, flushChannels, flushAllChannels, resetScriptChannels, hasScriptListeners,
    removeChannelListenersOwnedBy, listenOwned, sendEvent, fireEvent, discardQueuedFor, receiveRemoteEvent,
    addTargetListener, removeTargetListener, hasTargetListener, releaseTarget, dispatchAt,
} from './hub';
export type { SendOptions } from './hub';
