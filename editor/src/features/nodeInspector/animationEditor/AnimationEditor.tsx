import { useEffect, useState } from 'react';
import { ModelNode, Node } from 'cleo';
import Collapsable from '../../../components/Collapsable';
import './AnimationEditor.css';

interface AnimationMapping {
  animationName: string;
  trigger: string;
  triggerType: 'key' | 'direction' | 'custom';
  keyCode?: string;
  direction?: 'forward' | 'backward' | 'left' | 'right' | 'up' | 'down';
  customCondition?: string;
}

const AVAILABLE_KEYS = [
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE',
  'Space', 'ShiftLeft', 'ControlLeft',
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
  'Digit1', 'Digit2', 'Digit3', 'Digit4'
];

const DIRECTIONS = ['forward', 'backward', 'left', 'right', 'up', 'down'];

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

  const updateMapping = (index: number, field: keyof AnimationMapping, value: any) => {
    const newMappings = [...mappings];
    newMappings[index] = { ...newMappings[index], [field]: value };
    
    // Clear other trigger fields when changing trigger type
    if (field === 'triggerType') {
      delete newMappings[index].keyCode;
      delete newMappings[index].direction;
      delete newMappings[index].customCondition;
      
      // Set default values for new trigger type
      if (value === 'key') {
        newMappings[index].keyCode = 'Space';
      } else if (value === 'direction') {
        newMappings[index].direction = 'forward';
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
            <div className="mappings-list">
              {mappings.map((mapping, index) => (
                <div key={index} className="mapping-item">
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
                    <div className="mapping-row">
                      <label>Direction:</label>
                      <select
                        value={mapping.direction || 'forward'}
                        onChange={(e) => updateMapping(index, 'direction', e.target.value)}
                      >
                        {DIRECTIONS.map((dir) => (
                          <option key={dir} value={dir}>
                            {dir.charAt(0).toUpperCase() + dir.slice(1)}
                          </option>
                        ))}
                      </select>
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
          )}

          <button className="apply-btn" onClick={applyMappings}>
            Apply Mappings
          </button>
        </div>
      </div>
    </Collapsable>
  );
}
