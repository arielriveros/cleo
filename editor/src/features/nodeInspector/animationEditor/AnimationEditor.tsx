import { useEffect, useState } from 'react';
import { ModelNode, Node } from 'cleo';
import Collapsable from '../../../components/Collapsable';
import './AnimationEditor.css';

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
    }
  };

  if (!hasAnimations) {
    return (
      <Collapsable title="Animation Editor">
        <div className="animation-editor-empty">
          <p>This node does not have any animations.</p>
          <p>Only ModelNodes with AnimatedModel can use the animation editor.</p>
        </div>
      </Collapsable>
    );
  }

  return (
    <Collapsable title="Animation Editor">
      <div className="animation-editor">
        <div className="animation-info">
          <p>Available Animations: {animationNames.length}</p>
          <ul className="animation-list">
            {animationNames.map((name, idx) => (
              <li key={idx}>{name}</li>
            ))}
          </ul>
        </div>

        <div className="animation-mappings">
          <div className="mappings-header">
            <h3>Animation Triggers</h3>
            <button className="add-mapping-btn" onClick={addMapping}>
              + Add Mapping
            </button>
          </div>

          {mappings.length === 0 ? (
            <p className="no-mappings">No animation mappings configured. Click "Add Mapping" to create one.</p>
          ) : (
            <>
              <p style={{ fontSize: '12px', color: '#888', margin: '8px 0' }}>
                ⚠️ Priority: First matching trigger plays. Order more specific animations first, idle/fallback animations last.
              </p>
              <div className="mappings-list">
                {mappings.map((mapping, index) => (
                  <div key={index} className="mapping-item">
                    <div className="mapping-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                      <strong style={{ color: '#4a9eff' }}>Trigger #{index + 1} (Priority: {index + 1})</strong>
                      <div style={{ display: 'flex', gap: '4px' }}>
                        <button
                          onClick={() => moveMapping(index, 'up')}
                          disabled={index === 0}
                          style={{ padding: '2px 8px', fontSize: '12px' }}
                          title="Move up (higher priority)"
                        >
                          ▲
                        </button>
                        <button
                          onClick={() => moveMapping(index, 'down')}
                          disabled={index === mappings.length - 1}
                          style={{ padding: '2px 8px', fontSize: '12px' }}
                          title="Move down (lower priority)"
                        >
                          ▼
                        </button>
                      </div>
                    </div>
                    
                    <div className="mapping-row">
                    <label>Animation:</label>
                    <select
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

                  <div className="mapping-row">
                    <label>Trigger Type:</label>
                    <select
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
                    <div className="mapping-row">
                      <label>Key:</label>
                      <select
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
                      <div className="mapping-row">
                        <label>Preset Direction (Local Space):</label>
                        <select
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
                      
                      <div className="mapping-row">
                        <label>Direction Vector (X, Y, Z):</label>
                        <div style={{ display: 'flex', gap: '5px', alignItems: 'center' }}>
                          <input
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
                            style={{ width: '60px' }}
                          />
                          <input
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
                            style={{ width: '60px' }}
                          />
                          <input
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
                            style={{ width: '60px' }}
                          />
                          <small style={{ color: '#888', fontSize: '11px' }}>
                            (Local to node)
                          </small>
                        </div>
                      </div>
                      
                      <div className="mapping-row">
                        <label>Direction Threshold:</label>
                        <input
                          type="number"
                          value={mapping.directionThreshold ?? 0.8}
                          onChange={(e) => updateMapping(index, 'directionThreshold', parseFloat(e.target.value))}
                          step="0.05"
                          min="0"
                          max="1"
                          placeholder="0.8"
                        />
                        <small style={{ marginLeft: '8px', color: '#888' }}>
                          (0-1, higher = more precise)
                        </small>
                      </div>
                    </>
                  )}

                  {mapping.triggerType === 'speed' && (
                    <div className="mapping-row">
                      <label>Speed Threshold:</label>
                      <input
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
                    <div className="mapping-row">
                      <label>Condition:</label>
                      <input
                        type="text"
                        value={mapping.customCondition || ''}
                        onChange={(e) => updateMapping(index, 'customCondition', e.target.value)}
                        placeholder="e.g., node.speed > 5"
                      />
                    </div>
                  )}

                  <button
                    className="remove-mapping-btn"
                    onClick={() => removeMapping(index)}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
            </>
          )}

          <button className="apply-btn" onClick={applyMappings}>
            Apply Mappings
          </button>
        </div>
      </div>
    </Collapsable>
  );
}
