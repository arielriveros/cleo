import { useEffect, useState } from 'react';
import { ModelNode, Node } from 'cleo';
import Collapsable from '../../../components/Collapsable';

interface AnimationMapping {
  animationName: string;
  trigger: string;
  triggerType: 'key' | 'direction' | 'speed' | 'custom';
  keyCode?: string;
  direction?: [number, number, number]; // 3D vector (x, y, z) in local space
  directionThreshold?: number; // Dot product threshold for direction matching
  speedThreshold?: number;
  customCondition?: string;
}

const AVAILABLE_KEYS = [
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE',
  'Space', 'ShiftLeft', 'ControlLeft',
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
  'Digit1', 'Digit2', 'Digit3', 'Digit4'
];

const COMMON_DIRECTIONS: { name: string; vector: [number, number, number] }[] = [
  { name: 'Idle (No Movement)', vector: [0, 0, 0] },
  { name: 'Forward', vector: [0, 0, 1] },
  { name: 'Backward', vector: [0, 0, -1] },
  { name: 'Left', vector: [-1, 0, 0] },
  { name: 'Right', vector: [1, 0, 0] },
  { name: 'Up', vector: [0, 1, 0] },
  { name: 'Down', vector: [0, -1, 0] },
];

export default function AnimationEditor(props: { node: Node }) {
  const [animationNames, setAnimationNames] = useState<string[]>([]);
  const [mappings, setMappings] = useState<AnimationMapping[]>([]);
  const [hasAnimations, setHasAnimations] = useState(false);
  const [blendTime, setBlendTime] = useState<number>(0.3); // Default blend time

  useEffect(() => {
    // Check if node is a ModelNode with an AnimatedModel
    if (props.node instanceof ModelNode) {
      const model = (props.node as ModelNode).model;
      
      // Check if model has animations property (AnimatedModel)
      if ('animations' in model && Array.isArray(model.animations)) {
        const animations = model.animations;
        if (animations.length > 0) {
          setHasAnimations(true);
          setAnimationNames(animations.map((anim: any) => anim.name));
          
          // Load existing mappings if any
          const animator = (props.node as ModelNode).animator;
          if (animator && 'getAnimationMappings' in animator) {
            const existingMappings = (animator as any).getAnimationMappings();
            if (existingMappings && existingMappings.length > 0) {
              setMappings(existingMappings);
            }
            
            // Load blend time if available
            if ('blendTime' in animator) {
              setBlendTime((animator as any).blendTime);
            }
          }
        } else {
          setHasAnimations(false);
        }
      } else {
        setHasAnimations(false);
      }
    } else {
      setHasAnimations(false);
    }
  }, [props.node]);

  const addMapping = () => {
    if (animationNames.length === 0) return;
    
    const newMapping: AnimationMapping = {
      animationName: animationNames[0],
      trigger: 'key',
      triggerType: 'key',
      keyCode: 'Space'
    };
    setMappings([...mappings, newMapping]);
  };

  const removeMapping = (index: number) => {
    const newMappings = mappings.filter((_, i) => i !== index);
    setMappings(newMappings);
  };

  const moveMapping = (index: number, direction: 'up' | 'down') => {
    const newMappings = [...mappings];
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    
    if (targetIndex < 0 || targetIndex >= newMappings.length) return;
    
    // Swap the mappings
    [newMappings[index], newMappings[targetIndex]] = [newMappings[targetIndex], newMappings[index]];
    setMappings(newMappings);
  };

  const updateMapping = (index: number, field: keyof AnimationMapping, value: any) => {
    const newMappings = [...mappings];
    newMappings[index] = { ...newMappings[index], [field]: value };
    
    // Clear other trigger fields when changing trigger type
    if (field === 'triggerType') {
      delete newMappings[index].keyCode;
      delete newMappings[index].direction;
      delete newMappings[index].directionThreshold;
      delete newMappings[index].speedThreshold;
      delete newMappings[index].customCondition;
      
      // Set default values for new trigger type
      if (value === 'key') {
        newMappings[index].keyCode = 'Space';
      } else if (value === 'direction') {
        newMappings[index].direction = [0, 0, 1]; // Forward by default
        newMappings[index].directionThreshold = 0.8;
      } else if (value === 'speed') {
        newMappings[index].speedThreshold = 1.0;
      }
    }
    
    setMappings(newMappings);
  };

  const applyMappings = () => {
    if (props.node instanceof ModelNode) {
      const animator = (props.node as ModelNode).animator;
      if (animator && 'setAnimationMappings' in animator) {
        (animator as any).setAnimationMappings(mappings);
        console.log('Animation mappings applied:', mappings);
      }
      
      // Also set blend time
      if (animator && 'blendTime' in animator) {
        (animator as any).blendTime = blendTime;
        console.log('Blend time set to:', blendTime);
      }
    }
  };

  if (!hasAnimations) {
    return (
      <Collapsable title="Animation Editor">
        <div className="p-4 text-sm text-gray-400 border border-[#2d2d77] rounded bg-[#2b2b2b]">
          <p>This node does not have any animations.</p>
          <p>Only ModelNodes with AnimatedModel can use the animation editor.</p>
        </div>
      </Collapsable>
    );
  }

  const inputCls = 'bg-[#3b3b3b] text-white border border-[#2d2d77] rounded px-2 py-1';
  const btn = 'px-3 py-1 rounded bg-[#326acc] hover:bg-[#2a59a9] text-white border border-[#274b8f] disabled:opacity-50 disabled:cursor-not-allowed';
  const btnGhost = 'px-2 py-1 rounded border border-[#2d2d77] hover:bg-[#3b3b3b]';
  const btnDanger = 'px-2 py-1 rounded bg-red-600 hover:bg-red-700 text-white border border-red-700';

  return (
    <Collapsable title="Animation Editor">
      <div className="p-2 flex flex-col gap-4">
        <div className="border border-[#2d2d77] rounded p-2">
          <p>Available Animations: {animationNames.length}</p>
          <ul className="list-disc pl-5 text-sm mt-1">
            {animationNames.map((name, idx) => (
              <li key={idx}>{name}</li>
            ))}
          </ul>
        </div>

        <div className="border border-[#2d2d77] rounded p-2">
          <div className="flex items-center justify-between mb-2">
            <h3 className="font-semibold">Animation Triggers</h3>
            <button className={btn} onClick={addMapping}>+ Add Mapping</button>
          </div>

          {mappings.length === 0 ? (
            <p className="text-sm text-gray-400">No animation mappings configured. Click "Add Mapping" to create one.</p>
          ) : (
            <>
              <p className="text-xs text-gray-400 my-2">
                ⚠️ Priority: First matching trigger plays. Order more specific animations first, idle/fallback animations last.
              </p>
              <div className="flex flex-col gap-3">
                {mappings.map((mapping, index) => (
                  <div key={index} className="border border-[#2d2d77] rounded p-2">
                    <div className="flex items-center justify-between mb-2">
                      <strong className="text-[#4a9eff]">Trigger #{index + 1} (Priority: {index + 1})</strong>
                      <div className="flex gap-1">
                        <button
                          className={btnGhost}
                          onClick={() => moveMapping(index, 'up')}
                          disabled={index === 0}
                          title="Move up (higher priority)"
                        >
                          ▲
                        </button>
                        <button
                          className={btnGhost}
                          onClick={() => moveMapping(index, 'down')}
                          disabled={index === mappings.length - 1}
                          title="Move down (lower priority)"
                        >
                          ▼
                        </button>
                      </div>
                    </div>
                    
                    <div className="flex items-center gap-2 mb-2">
                      <label className="min-w-[100px]">Animation:</label>
                      <select
                        className={inputCls}
                        value={mapping.animationName}
                        onChange={(e) => updateMapping(index, 'animationName', e.target.value)}
                      >
                        {animationNames.map((name) => (
                          <option key={name} value={name}>
                            {name}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="flex items-center gap-2 mb-2">
                      <label className="min-w-[100px]">Trigger Type:</label>
                      <select
                        className={inputCls}
                        value={mapping.triggerType}
                        onChange={(e) => updateMapping(index, 'triggerType', e.target.value)}
                      >
                        <option value="key">Key Press</option>
                        <option value="direction">Movement Direction</option>
                        <option value="speed">Speed Threshold</option>
                        <option value="custom">Custom Condition</option>
                      </select>
                    </div>

                    {mapping.triggerType === 'key' && (
                      <div className="flex items-center gap-2 mb-2">
                        <label className="min-w-[100px]">Key:</label>
                        <select
                          className={inputCls}
                          value={mapping.keyCode || 'Space'}
                          onChange={(e) => updateMapping(index, 'keyCode', e.target.value)}
                        >
                          {AVAILABLE_KEYS.map((key) => (
                            <option key={key} value={key}>
                              {key}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}

                    {mapping.triggerType === 'direction' && (
                      <>
                        <div className="flex items-center gap-2 mb-2">
                          <label className="min-w-[100px]">Preset Direction (Local Space):</label>
                          <select
                            className={inputCls}
                            value={JSON.stringify(mapping.direction || [0, 0, 1])}
                            onChange={(e) => {
                              const vector = JSON.parse(e.target.value);
                              updateMapping(index, 'direction', vector);
                            }}
                          >
                            {COMMON_DIRECTIONS.map((dir) => (
                              <option key={dir.name} value={JSON.stringify(dir.vector)}>
                                {dir.name}
                              </option>
                            ))}
                            <option value="custom">Custom...</option>
                          </select>
                        </div>
                        
                        <div className="flex items-center gap-2 mb-2">
                          <label className="min-w-[100px]">Direction Vector (X, Y, Z):</label>
                          <div className="flex items-center gap-2">
                            <input
                              className={inputCls + ' w-[80px]'}
                              type="number"
                              value={mapping.direction?.[0] ?? 0}
                              onChange={(e) => {
                                const newDir: [number, number, number] = [
                                  parseFloat(e.target.value) || 0,
                                  mapping.direction?.[1] ?? 0,
                                  mapping.direction?.[2] ?? 1
                                ];
                                updateMapping(index, 'direction', newDir);
                              }}
                              step="0.1"
                              placeholder="X"
                            />
                            <input
                              className={inputCls + ' w-[80px]'}
                              type="number"
                              value={mapping.direction?.[1] ?? 0}
                              onChange={(e) => {
                                const newDir: [number, number, number] = [
                                  mapping.direction?.[0] ?? 0,
                                  parseFloat(e.target.value) || 0,
                                  mapping.direction?.[2] ?? 1
                                ];
                                updateMapping(index, 'direction', newDir);
                              }}
                              step="0.1"
                              placeholder="Y"
                            />
                            <input
                              className={inputCls + ' w-[80px]'}
                              type="number"
                              value={mapping.direction?.[2] ?? 1}
                              onChange={(e) => {
                                const newDir: [number, number, number] = [
                                  mapping.direction?.[0] ?? 0,
                                  mapping.direction?.[1] ?? 0,
                                  parseFloat(e.target.value) || 0
                                ];
                                updateMapping(index, 'direction', newDir);
                              }}
                              step="0.1"
                              placeholder="Z"
                            />
                            <small className="text-xs text-gray-400">(Local to node)</small>
                          </div>
                        </div>
                        
                        <div className="flex items-center gap-2 mb-2">
                          <label className="min-w-[100px]">Direction Threshold:</label>
                          <input
                            className={inputCls + ' w-[120px]'}
                            type="number"
                            value={mapping.directionThreshold ?? 0.8}
                            onChange={(e) => updateMapping(index, 'directionThreshold', parseFloat(e.target.value))}
                            step="0.05"
                            min="0"
                            max="1"
                            placeholder="0.8"
                          />
                          <small className="text-xs text-gray-400">(0-1, higher = more precise)</small>
                        </div>
                      </>
                    )}

                    {mapping.triggerType === 'speed' && (
                      <div className="flex items-center gap-2 mb-2">
                        <label className="min-w-[100px]">Speed Threshold:</label>
                        <input
                          className={inputCls + ' w-[120px]'}
                          type="number"
                          value={mapping.speedThreshold || 1.0}
                          onChange={(e) => updateMapping(index, 'speedThreshold', parseFloat(e.target.value))}
                          step="0.1"
                          min="0"
                          placeholder="e.g., 1.0"
                        />
                      </div>
                    )}

                    {mapping.triggerType === 'custom' && (
                      <div className="flex items-center gap-2 mb-2">
                        <label className="min-w-[100px]">Condition:</label>
                        <input
                          className={inputCls + ' flex-1'}
                          type="text"
                          value={mapping.customCondition || ''}
                          onChange={(e) => updateMapping(index, 'customCondition', e.target.value)}
                          placeholder="e.g., node.speed > 5"
                        />
                      </div>
                    )}

                    <button className={btnDanger} onClick={() => removeMapping(index)}>
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}

          <div className="mt-4 p-3 rounded bg-[#2a2a2a]">
            <div className="flex items-center gap-3">
              <label className="font-semibold min-w-[100px]">Blend Time:</label>
              <input
                className={inputCls + ' flex-1'}
                type="number"
                value={blendTime}
                onChange={(e) => setBlendTime(Math.max(0, parseFloat(e.target.value) || 0))}
                step="0.05"
                min="0"
                max="2"
              />
              <span className="text-xs text-gray-400 min-w-[60px]">seconds</span>
            </div>
            <p className="text-xs text-gray-400 mt-2">
              Duration for smooth transitions between animations (0 = instant switch)
            </p>
          </div>

          <button className={btn + ' mt-3'} onClick={applyMappings}>
            Apply Mappings
          </button>
        </div>
      </div>
    </Collapsable>
  );
}
