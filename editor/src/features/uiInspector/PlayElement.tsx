import React from 'react';
import { UIRuntime, RuntimeElement } from './uiRuntime';

// Shared style translation used by both the editor overlay and the standalone player.
export function styleToReact(style: any): React.CSSProperties {
  const css: any = { position: 'absolute', ...style };
  // translate numeric sizes to px
  const pxProps = ['left', 'top', 'width', 'height', 'padding', 'margin', 'fontSize', 'borderRadius', 'gap'];
  pxProps.forEach(k => {
    if (typeof css[k] === 'number') css[k] = `${css[k]}px`;
  });
  return css as React.CSSProperties;
}

// Play mode: render the runtime tree; hidden elements are skipped; buttons run their onClick handler.
// Shared between the in-editor UIOverlay (play mode) and the published game player.
export function PlayElement({ el }: { el: RuntimeElement }) {
  if (el.visible === false) return null;
  if (el.type === 'container')
    return <div style={styleToReact(el.style)} data-ui-id={el.id}>
      {(el.children || []).map(child => <PlayElement key={child.id} el={child} />)}
    </div>;
  if (el.type === 'text')
    return <div style={styleToReact(el.style)} data-ui-id={el.id}>{(el as any).content}</div>;
  if (el.type === 'image')
    return <img style={styleToReact(el.style)} src={(el as any).src} alt={(el as any).alt || ''} data-ui-id={el.id} />;
  if (el.type === 'button')
    return <button style={{ ...styleToReact(el.style), pointerEvents: 'auto' }} data-ui-id={el.id}
      onClick={(e) => { e.stopPropagation(); UIRuntime.handleClick(el.id); }}>{(el as any).label}</button>;
  return null;
}
