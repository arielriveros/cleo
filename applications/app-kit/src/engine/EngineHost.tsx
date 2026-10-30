import { createContext, useContext, type ReactNode } from 'react';
import type { CleoEngine } from 'cleo';

/** The few things a bus needs to be, for the panels that only ever announce a change. */
export interface EngineHostBus {
  emit(event: string, ...args: any[]): unknown;
  on(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
}

/**
 * The slice of an application's engine state that shared chrome reads: the running engine, whether a
 * game is playing in it, and the app's event bus. Every application that hosts a `CleoEngine` provides
 * one -- the editor from inside its EngineProvider, Cleo Creator from its own small host -- so the
 * renderer and performance panels, the viewport host and anything else in the app-kit never reach for
 * an application's own context.
 */
export interface EngineHost {
  /** Null until the engine has initialised (device acquired, shaders built). */
  instance: CleoEngine | null;
  /** True while a game runs in the engine; settings panels re-sync from the renderer when it flips. */
  isPlayMode: boolean;
  /** Where panels announce a change (`SCENE_CHANGED` after a renderer setting moves). */
  eventEmitter: EngineHostBus | null;
}

const NO_HOST: EngineHost = { instance: null, isPlayMode: false, eventEmitter: null };

const EngineHostContext = createContext<EngineHost>(NO_HOST);

export function EngineHostProvider({ value, children }: { value: EngineHost; children: ReactNode }) {
  return <EngineHostContext.Provider value={value}>{children}</EngineHostContext.Provider>;
}

export function useEngineHost(): EngineHost {
  return useContext(EngineHostContext);
}
