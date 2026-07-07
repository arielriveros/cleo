import React, { useEffect, useMemo, useState } from 'react';
import { useCleoEngine } from '../EngineContext';
import { UIElement } from '../../utils/UIModel';
import { UIRuntime } from './uiRuntime';
import { PlayElement, styleToReact } from './PlayElement';

// Edit mode: click selects the element in the inspector.
function EditElement({ el, onSelect }: { el: UIElement, onSelect: (id: string) => void }) {
  const click = (e: React.MouseEvent) => { e.stopPropagation(); onSelect(el.id); };
  if (el.type === 'container')
    return <div style={styleToReact(el.style)} onClick={click} data-ui-id={el.id}>
      {(el.children || []).map(child => <EditElement key={child.id} el={child} onSelect={onSelect} />)}
    </div>;
  if (el.type === 'text')
    return <div style={styleToReact(el.style)} onClick={click} data-ui-id={el.id}>{el.content}</div>;
  if (el.type === 'image')
    return <img style={styleToReact(el.style)} onClick={click} src={el.src} alt={el.alt || ''} data-ui-id={el.id} />;
  if (el.type === 'button')
    return <button style={styleToReact(el.style)} onClick={click} data-ui-id={el.id}>{el.label}</button>;
  return null;
}

export default function UIOverlay() {
  const { ui, isPlayMode, eventEmitter } = useCleoEngine();
  const [, setTick] = useState(0);
  const [explorerTab, setExplorerTab] = useState<'Scene' | 'UI'>('Scene');

  // Re-render on runtime mutations while in play mode.
  useEffect(() => {
    const onTick = () => setTick(t => t + 1);
    eventEmitter.on('UI_RUNTIME_TICK', onTick);
    return () => { eventEmitter.off('UI_RUNTIME_TICK', onTick); };
  }, [eventEmitter]);

  // Track the left sidebar's active tab so the overlay only shows while editing UI.
  useEffect(() => {
    const onTab = (tab: 'Scene' | 'UI') => setExplorerTab(tab);
    eventEmitter.on('EXPLORER_TAB', onTab);
    return () => { eventEmitter.off('EXPLORER_TAB', onTab); };
  }, [eventEmitter]);

  const onSelect = (id: string) => eventEmitter.emit('SELECT_UI_ELEMENT', id);

  // The overlay root is click-through; interactive elements (buttons) and modal containers opt in
  // via their own pointerEvents so the HUD never blocks input to the 3D viewport.
  const containerStyle: React.CSSProperties = useMemo(() => ({
    position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, pointerEvents: 'none'
  }), [isPlayMode]);

  const playing = isPlayMode && UIRuntime.running;

  // Hide the overlay in edit mode unless the UI tab is active (avoids cluttering the Scene view).
  if (!isPlayMode && explorerTab !== 'UI') return null;

  return (
    <div style={containerStyle}>
      {playing
        ? UIRuntime.getTree().map(el => <PlayElement key={el.id} el={el} />)
        : ui.elements.map(el => <EditElement key={el.id} el={el} onSelect={onSelect} />)}
    </div>
  );
}
