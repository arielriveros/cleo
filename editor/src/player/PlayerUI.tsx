import React, { useEffect, useState } from 'react';
import type EventEmitter from 'events';
import { UIRuntime } from '../features/uiInspector/uiRuntime';
import { PlayElement } from '../features/uiInspector/PlayElement';

// Standalone play-mode UI overlay for the published game. Renders the UIRuntime tree and
// re-renders whenever a runtime tick mutates it. Reuses the shared PlayElement renderer so
// the published HUD is pixel-identical to the editor's play mode.
export default function PlayerUI({ emitter }: { emitter: EventEmitter }) {
  const [, setTick] = useState(0);

  useEffect(() => {
    const onTick = () => setTick(t => t + 1);
    emitter.on('UI_RUNTIME_TICK', onTick);
    return () => { emitter.off('UI_RUNTIME_TICK', onTick); };
  }, [emitter]);

  const containerStyle: React.CSSProperties = {
    position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, pointerEvents: 'none',
  };

  if (!UIRuntime.running) return null;

  return (
    <div style={containerStyle}>
      {UIRuntime.getTree().map(el => <PlayElement key={el.id} el={el} />)}
    </div>
  );
}
