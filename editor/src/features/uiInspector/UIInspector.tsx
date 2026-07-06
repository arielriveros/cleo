import React, { useEffect, useMemo, useState } from 'react';
import { useCleoEngine } from '../EngineContext';
import Collapsable from '../../components/Collapsable';
import { UIElement, UIElementType } from '../../utils/UIModel';

type Editable = UIElement & { [key: string]: any };

export default function UIInspector() {
  const { ui, addUIElement, updateUIElement, removeUIElement, eventEmitter } = useCleoEngine();
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    const onSelect = (id: string) => setSelected(id);
    eventEmitter.on('SELECT_UI_ELEMENT', onSelect);
    return () => { eventEmitter.off('SELECT_UI_ELEMENT', onSelect); };
  }, [eventEmitter]);

  const flatList = useMemo(() => {
    const out: UIElement[] = [];
    const walk = (arr: UIElement[], depth = 0) => {
      arr.forEach(el => {
        (el as any).__depth = depth;
        out.push(el);
        if ((el as any).children) walk((el as any).children, depth + 1);
      });
    };
    walk(ui.elements);
    return out;
  }, [ui]);

  const createElement = (type: UIElementType): UIElement => {
    if (type === 'container') return { id: '', type, name: 'Container', style: { position: 'absolute', left: 20, top: 20, width: 200, height: 100, backgroundColor: 'rgba(0,0,0,0.3)' }, children: [] };
    if (type === 'text') return { id: '', type, name: 'Text', style: { position: 'absolute', left: 20, top: 20, color: '#fff', fontSize: 16 }, content: 'Text' } as any;
    if (type === 'image') return { id: '', type, name: 'Image', style: { position: 'absolute', left: 20, top: 20, width: 64, height: 64 }, src: '', alt: '' } as any;
    if (type === 'button') return { id: '', type, name: 'Button', style: { position: 'absolute', left: 20, top: 20, padding: 8 }, label: 'Button' } as any;
    return { id: '', type: 'text', content: 'Text' } as any;
  };

  const selectedEl = useMemo(() => flatList.find(e => e.id === selected) || null, [flatList, selected]);

  const updateField = (key: string, value: any) => {
    if (!selectedEl) return;
    const updated: Editable = { ...selectedEl, [key]: value };
    updateUIElement(updated as UIElement);
  };

  const updateStyle = (key: string, value: any) => {
    if (!selectedEl) return;
    const updated: Editable = { ...selectedEl, style: { ...(selectedEl as any).style, [key]: value } };
    updateUIElement(updated as UIElement);
  };

  return (
    <div className='w-full h-full p-2 text-white'>
      <div className='flex gap-2 mb-2'>
        <button className='border border-[#2d2d77] rounded px-2 py-1 bg-[#3b3b3b]' onClick={() => addUIElement(createElement('container'))}>+ Container</button>
        <button className='border border-[#2d2d77] rounded px-2 py-1 bg-[#3b3b3b]' onClick={() => addUIElement(createElement('text'))}>+ Text</button>
        <button className='border border-[#2d2d77] rounded px-2 py-1 bg-[#3b3b3b]' onClick={() => addUIElement(createElement('image'))}>+ Image</button>
        <button className='border border-[#2d2d77] rounded px-2 py-1 bg-[#3b3b3b]' onClick={() => addUIElement(createElement('button'))}>+ Button</button>
      </div>

      <Collapsable title='UI Elements'>
        <div className='max-h-[30vh] overflow-auto'>
          {flatList.map(el => (
            <div key={el.id} className={`flex items-center justify-between px-2 py-1 cursor-pointer ${selected === el.id ? 'bg-[#2d2d77]' : ''}`}
                 style={{ paddingLeft: 8 + ((el as any).__depth || 0) * 12 }}
                 onClick={() => setSelected(el.id)}>
              <span>{el.name || el.type}</span>
              <button className='text-red-300' onClick={(e) => { e.stopPropagation(); removeUIElement(el.id); if (selected === el.id) setSelected(null); }}>Delete</button>
            </div>
          ))}
        </div>
      </Collapsable>

      {selectedEl && (<>
        <Collapsable title='Properties'>
          <div className='grid grid-cols-2 gap-2'>
            <label>Name</label>
            <input className='bg-[#3b3b3b] border border-[#2d2d77] rounded px-2 py-1' value={selectedEl.name || ''} onChange={e => updateField('name', e.target.value)} />

            <label>Type</label>
            <input disabled className='bg-[#3b3b3b] border border-[#2d2d77] rounded px-2 py-1' value={selectedEl.type} />

            {selectedEl.type === 'text' && <>
              <label>Content</label>
              <input className='bg-[#3b3b3b] border border-[#2d2d77] rounded px-2 py-1' value={(selectedEl as any).content || ''} onChange={e => updateField('content', e.target.value)} />
            </>}

            {selectedEl.type === 'image' && <>
              <label>Source</label>
              <input className='bg-[#3b3b3b] border border-[#2d2d77] rounded px-2 py-1' value={(selectedEl as any).src || ''} onChange={e => updateField('src', e.target.value)} />
            </>}

            {selectedEl.type === 'button' && <>
              <label>Label</label>
              <input className='bg-[#3b3b3b] border border-[#2d2d77] rounded px-2 py-1' value={(selectedEl as any).label || ''} onChange={e => updateField('label', e.target.value)} />
            </>}

            <label>Left</label>
            <input type='number' className='bg-[#3b3b3b] border border-[#2d2d77] rounded px-2 py-1' value={Number((selectedEl as any).style?.left ?? 0)} onChange={e => updateStyle('left', Number(e.target.value))} />
            <label>Top</label>
            <input type='number' className='bg-[#3b3b3b] border border-[#2d2d77] rounded px-2 py-1' value={Number((selectedEl as any).style?.top ?? 0)} onChange={e => updateStyle('top', Number(e.target.value))} />
            <label>Width</label>
            <input type='number' className='bg-[#3b3b3b] border border-[#2d2d77] rounded px-2 py-1' value={Number((selectedEl as any).style?.width ?? 0)} onChange={e => updateStyle('width', Number(e.target.value))} />
            <label>Height</label>
            <input type='number' className='bg-[#3b3b3b] border border-[#2d2d77] rounded px-2 py-1' value={Number((selectedEl as any).style?.height ?? 0)} onChange={e => updateStyle('height', Number(e.target.value))} />
            <label>Background</label>
            <input type='color' className='w-[32px] h-[32px] p-0 border border-[#2d2d77] rounded bg-transparent' value={(selectedEl as any).style?.backgroundColor || '#000000'} onChange={e => updateStyle('backgroundColor', e.target.value)} />
            <label>Color</label>
            <input type='color' className='w-[32px] h-[32px] p-0 border border-[#2d2d77] rounded bg-transparent' value={(selectedEl as any).style?.color || '#ffffff'} onChange={e => updateStyle('color', e.target.value)} />
          </div>
        </Collapsable>

        <Collapsable title='Script'>
          <div className='p-1'>
            <p className='text-xs text-gray-400 mb-1'>
              Runs in play mode. Define <code>onStart(el, ctx)</code>, <code>onUpdate(el, ctx, delta, time)</code>, or (buttons) <code>onClick(el, ctx)</code>.
              Context: <code>ctx.ui</code>, <code>ctx.scene</code>, <code>ctx.findNode</code>, <code>ctx.getData</code>, <code>ctx.setData</code>, <code>ctx.game</code>.
            </p>
            <textarea
              className='w-full h-48 bg-[#1e1e1e] text-white border border-[#2d2d77] rounded p-2 font-mono text-xs'
              spellCheck={false}
              placeholder={"function onUpdate(el, ctx) {\n  const p = ctx.findNode('playable');\n  const hp = ctx.getData(p).HealthPoints;\n  ctx.ui.setText(el, 'Health Left: ' + '❤'.repeat(Math.max(0, hp)));\n}"}
              value={(selectedEl as any).script || ''}
              onChange={e => updateField('script', e.target.value)}
            />
          </div>
        </Collapsable>
      </>)}
    </div>
  );
}
