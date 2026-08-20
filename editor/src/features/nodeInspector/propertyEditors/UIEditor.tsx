import { useEffect, useState } from 'react';
import {
    UINode, UIRootNode, UITextNode, UIImageNode, UIButtonNode, UIStackNode, UISpacerNode,
    UIProgressBarNode, UISliderNode, UIToggleNode, UITextInputNode, UIColor,
} from 'cleo';
import Collapsable from '../../../components/Collapsable';
import { ColorInput, NumberInput, TextInput, Select, Toggle, Slider, PropertyTable, PropertyRow } from '../../../components/ui';
import { useEventBus } from '../../EventBusContext';
import { TextureManager, isDerivedTextureId } from 'cleo';

/**
 * The inspector for every UI element type.
 *
 * One component rather than eleven registered editors, because the shared rect/appearance block is most of
 * the surface and only the payload section differs — the same reason `UINode` owns most of the class.
 */

/** `Select` takes `<option>` children; this is the options-array shape the rest of this file wants. */
function Choice<T extends string>({ value, onChange, options }: {
    value: T;
    onChange: (v: T) => void;
    options: { value: T, label: string }[];
}) {
    return (
        <Select value={value} onChange={e => onChange(e.target.value as T)}>
            {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </Select>
    );
}

/**
 * Texture picker for a UI image.
 *
 * Its own control rather than the shared `TextureInspector`, which is bound to a `Material` and a slot
 * name — a UI image holds a bare texture id. Derived (channel-packed) textures are filtered out: they are
 * engine-owned and never assignable, per `isDerivedTextureId`.
 */
function TexturePicker({ value, onChange }: { value: string | null, onChange: (id: string | null) => void }) {
    const ids = Array.from(TextureManager.Instance.textures.keys())
        .filter(id => !isDerivedTextureId(id) && !id.startsWith('__editor__'));
    return (
        <Select value={value ?? ''} onChange={e => onChange(e.target.value || null)}>
            <option value=''>(none)</option>
            {/* A texture the scene references but the manager has dropped still has to be selectable, or
                the field would silently reset itself the moment anything re-rendered. */}
            {value && !ids.includes(value) && <option value={value}>{value} (missing)</option>}
            {ids.map(id => <option key={id} value={id}>{id}</option>)}
        </Select>
    );
}

/** UI colours are 0..1 sRGB (see `UIColor`); the DOM colour input speaks hex. */
const toHex = (c: UIColor): string =>
    '#' + [c[0], c[1], c[2]].map(v => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('');

/** Re-render this panel whenever the node changes, including from a script or an undo. */
function useNodeVersion(node: UINode): () => void {
    const eventEmitter = useEventBus();
    const [, setTick] = useState(0);
    const bump = () => setTick(t => t + 1);
    useEffect(() => {
        const onChanged = () => setTick(t => t + 1);
        eventEmitter.on('SCENE_CHANGED', onChanged);
        return () => { eventEmitter.off('SCENE_CHANGED', onChanged); };
    }, [eventEmitter]);
    return bump;
}

/** The nine pins plus the four stretch modes, as anchorMin/anchorMax pairs. */
const ANCHOR_PRESETS: { key: string, title: string, min: [number, number], max: [number, number] }[] = [
    { key: 'tl', title: 'Top left', min: [0, 0], max: [0, 0] },
    { key: 'tc', title: 'Top center', min: [0.5, 0], max: [0.5, 0] },
    { key: 'tr', title: 'Top right', min: [1, 0], max: [1, 0] },
    { key: 'sh-t', title: 'Stretch horizontally, top', min: [0, 0], max: [1, 0] },
    { key: 'ml', title: 'Middle left', min: [0, 0.5], max: [0, 0.5] },
    { key: 'mc', title: 'Center', min: [0.5, 0.5], max: [0.5, 0.5] },
    { key: 'mr', title: 'Middle right', min: [1, 0.5], max: [1, 0.5] },
    { key: 'sh-m', title: 'Stretch horizontally, middle', min: [0, 0.5], max: [1, 0.5] },
    { key: 'bl', title: 'Bottom left', min: [0, 1], max: [0, 1] },
    { key: 'bc', title: 'Bottom center', min: [0.5, 1], max: [0.5, 1] },
    { key: 'br', title: 'Bottom right', min: [1, 1], max: [1, 1] },
    { key: 'sh-b', title: 'Stretch horizontally, bottom', min: [0, 1], max: [1, 1] },
    { key: 'sv-l', title: 'Stretch vertically, left', min: [0, 0], max: [0, 1] },
    { key: 'sv-c', title: 'Stretch vertically, center', min: [0.5, 0], max: [0.5, 1] },
    { key: 'sv-r', title: 'Stretch vertically, right', min: [1, 0], max: [1, 1] },
    { key: 'fill', title: 'Stretch both', min: [0, 0], max: [1, 1] },
];

/** A tiny diagram of what each preset does, so the grid is readable without hovering every cell. */
function AnchorGlyph({ min, max }: { min: [number, number], max: [number, number] }) {
    const stretchX = min[0] !== max[0];
    const stretchY = min[1] !== max[1];
    const x = stretchX ? 3 : 3 + min[0] * 12;
    const y = stretchY ? 3 : 3 + min[1] * 12;
    const w = stretchX ? 12 : 3;
    const h = stretchY ? 12 : 3;
    return (
        <svg viewBox="0 0 18 18" width="18" height="18">
            <rect x="1" y="1" width="16" height="16" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.35" />
            <rect x={x} y={y} width={w} height={h} rx="0.8" fill="currentColor" />
        </svg>
    );
}

function AnchorPicker({ node, onChange }: { node: UINode, onChange: () => void }) {
    const active = ANCHOR_PRESETS.find(p =>
        p.min[0] === node.anchorMin[0] && p.min[1] === node.anchorMin[1] &&
        p.max[0] === node.anchorMax[0] && p.max[1] === node.anchorMax[1]);

    return (
        <div className='grid grid-cols-4 gap-1 p-1'>
            {ANCHOR_PRESETS.map(preset => (
                <button
                    key={preset.key}
                    type='button'
                    title={preset.title}
                    className={`flex items-center justify-center h-7 rounded border transition-colors ${
                        active?.key === preset.key
                            ? 'bg-selected border-white text-white'
                            : 'bg-control border-control text-muted hover:bg-control-hover hover:text-fg'}`}
                    onClick={() => {
                        node.anchorMin = [...preset.min] as [number, number];
                        node.anchorMax = [...preset.max] as [number, number];
                        onChange();
                    }}>
                    <AnchorGlyph min={preset.min} max={preset.max} />
                </button>
            ))}
        </div>
    );
}

/**
 * The rect fields.
 *
 * The labels change per axis, and that is the whole point: on a PINNED axis the offsets read as position
 * and size, on a STRETCHED one they read as insets from each edge. Same stored data (see `solveRect`),
 * two very different mental models — showing "Offset Min X" for both would make the widget unusable.
 */
function RectFields({ node, onChange }: { node: UINode, onChange: () => void }) {
    const stretchX = node.anchorMin[0] !== node.anchorMax[0];
    const stretchY = node.anchorMin[1] !== node.anchorMax[1];

    const setMin = (i: 0 | 1, v: number) => {
        const next: [number, number] = [...node.offsetMin] as [number, number];
        next[i] = v;
        node.offsetMin = next;
        onChange();
    };
    const setMax = (i: 0 | 1, v: number) => {
        const next: [number, number] = [...node.offsetMax] as [number, number];
        next[i] = v;
        node.offsetMax = next;
        onChange();
    };
    // On a pinned axis the user edits SIZE, which has to move the far offset with the near one.
    const setSize = (i: 0 | 1, v: number) => setMax(i, node.offsetMin[i] + v);

    return (
        <PropertyTable>
            <PropertyRow label={stretchX ? 'Left' : 'Pos X'}>
                <NumberInput value={node.offsetMin[0]} onChange={v => setMin(0, v)} />
            </PropertyRow>
            <PropertyRow label={stretchX ? 'Right' : 'Width'}>
                <NumberInput
                    value={stretchX ? node.offsetMax[0] : node.offsetMax[0] - node.offsetMin[0]}
                    onChange={v => (stretchX ? setMax(0, v) : setSize(0, v))} />
            </PropertyRow>
            <PropertyRow label={stretchY ? 'Top' : 'Pos Y'}>
                <NumberInput value={node.offsetMin[1]} onChange={v => setMin(1, v)} />
            </PropertyRow>
            <PropertyRow label={stretchY ? 'Bottom' : 'Height'}>
                <NumberInput
                    value={stretchY ? node.offsetMax[1] : node.offsetMax[1] - node.offsetMin[1]}
                    onChange={v => (stretchY ? setMax(1, v) : setSize(1, v))} />
            </PropertyRow>
            <PropertyRow label='Pivot X'>
                <Slider min={0} max={1} step={0.05} value={node.pivot[0]}
                    onChange={v => { node.pivot = [v, node.pivot[1]]; onChange(); }} />
            </PropertyRow>
            <PropertyRow label='Pivot Y'>
                <Slider min={0} max={1} step={0.05} value={node.pivot[1]}
                    onChange={v => { node.pivot = [node.pivot[0], v]; onChange(); }} />
            </PropertyRow>
            <PropertyRow label='Rotation'>
                <NumberInput value={node.rotationDeg} onChange={v => { node.rotationDeg = v; onChange(); }} />
            </PropertyRow>
            <PropertyRow label='Scale X'>
                <NumberInput step={0.1} value={node.scale2d[0]}
                    onChange={v => { node.scale2d = [v, node.scale2d[1]]; onChange(); }} />
            </PropertyRow>
            <PropertyRow label='Scale Y'>
                <NumberInput step={0.1} value={node.scale2d[1]}
                    onChange={v => { node.scale2d = [node.scale2d[0], v]; onChange(); }} />
            </PropertyRow>
        </PropertyTable>
    );
}

function AppearanceFields({ node, onChange }: { node: UINode, onChange: () => void }) {
    const setTintRGB = (rgb: [number, number, number]) => {
        node.tint = [rgb[0], rgb[1], rgb[2], node.tint[3]];
        onChange();
    };
    return (
        <PropertyTable>
            <PropertyRow label='Color'>
                <div className='flex items-center gap-2'>
                    <ColorInput color={toHex(node.tint)} onChange={setTintRGB} />
                    <Slider min={0} max={1} step={0.01} value={node.tint[3]}
                        onChange={v => { node.tint = [node.tint[0], node.tint[1], node.tint[2], v]; onChange(); }} />
                </div>
            </PropertyRow>
            <PropertyRow label='Opacity'>
                <Slider min={0} max={1} step={0.01} value={node.opacity}
                    onChange={v => { node.opacity = v; onChange(); }} />
            </PropertyRow>
            <PropertyRow label='Z order'>
                <NumberInput value={node.zOrder} onChange={v => { node.zOrder = v; onChange(); }} />
            </PropertyRow>
            <PropertyRow label='Interactive'>
                <Toggle checked={node.interactive} onChange={v => { node.interactive = v; onChange(); }} />
            </PropertyRow>
            <PropertyRow label='Clip children'>
                <Toggle checked={node.clip} onChange={v => { node.clip = v; onChange(); }} />
            </PropertyRow>
            <PropertyRow label='Corner radius'>
                <NumberInput min={0} value={node.borderRadius} onChange={v => { node.borderRadius = v; onChange(); }} />
            </PropertyRow>
            <PropertyRow label='Border'>
                <div className='flex items-center gap-2'>
                    <NumberInput min={0} value={node.borderWidth} onChange={v => { node.borderWidth = v; onChange(); }} />
                    <ColorInput color={toHex(node.borderColor)}
                        onChange={rgb => { node.borderColor = [rgb[0], rgb[1], rgb[2], node.borderColor[3]]; onChange(); }} />
                </div>
            </PropertyRow>
            <PropertyRow label='Padding'>
                <div className='grid grid-cols-4 gap-1'>
                    {(['L', 'T', 'R', 'B'] as const).map((axis, i) => (
                        <NumberInput key={axis} value={node.padding[i]} title={axis}
                            onChange={v => {
                                const next = [...node.padding] as [number, number, number, number];
                                next[i] = v;
                                node.padding = next;
                                onChange();
                            }} />
                    ))}
                </div>
            </PropertyRow>
        </PropertyTable>
    );
}

function RootFields({ node, onChange }: { node: UIRootNode, onChange: () => void }) {
    const world = node.space === 'world';
    return (
        <PropertyTable>
            <PropertyRow label='Space'>
                <Choice value={node.space} onChange={v => { node.space = v as any; onChange(); }}
                    options={[{ value: 'screen', label: 'Screen' }, { value: 'world', label: 'World' }]} />
            </PropertyRow>
            <PropertyRow label='Reference W'>
                <NumberInput min={1} value={node.referenceResolution[0]}
                    onChange={v => { node.referenceResolution = [v, node.referenceResolution[1]]; onChange(); }} />
            </PropertyRow>
            <PropertyRow label='Reference H'>
                <NumberInput min={1} value={node.referenceResolution[1]}
                    onChange={v => { node.referenceResolution = [node.referenceResolution[0], v]; onChange(); }} />
            </PropertyRow>
            {!world && <>
                <PropertyRow label='Scale mode'>
                    <Choice value={node.scaleMode} onChange={v => { node.scaleMode = v as any; onChange(); }}
                        options={[
                            { value: 'scaleWithScreen', label: 'Scale with screen' },
                            { value: 'constantPixel', label: 'Constant pixel' },
                            { value: 'constantPhysical', label: 'Constant physical' },
                        ]} />
                </PropertyRow>
                {node.scaleMode === 'scaleWithScreen' &&
                    <PropertyRow label='Match W/H'>
                        <Slider min={0} max={1} step={0.05} value={node.matchWidthOrHeight}
                            onChange={v => { node.matchWidthOrHeight = v; onChange(); }} />
                    </PropertyRow>}
            </>}
            {world && <>
                <PropertyRow label='Follow node id'>
                    <TextInput value={node.uiTargetId ?? ''} placeholder='(this node)'
                        onChange={v => { node.uiTargetId = v || null; onChange(); }} />
                </PropertyRow>
                <PropertyRow label='Ref. distance'>
                    <NumberInput min={0.01} step={0.5} value={node.referenceDistance}
                        onChange={v => { node.referenceDistance = v; onChange(); }} />
                </PropertyRow>
                <PropertyRow label='Min scale'>
                    <NumberInput min={0} step={0.05} value={node.minScale}
                        onChange={v => { node.minScale = v; onChange(); }} />
                </PropertyRow>
                <PropertyRow label='Max scale'>
                    <NumberInput min={0} step={0.5} value={node.maxScale}
                        onChange={v => { node.maxScale = v; onChange(); }} />
                </PropertyRow>
                <PropertyRow label='Clamp to screen'>
                    <Toggle checked={node.clampToScreen} onChange={v => { node.clampToScreen = v; onChange(); }} />
                </PropertyRow>
                <PropertyRow label='Hide behind camera'>
                    <Toggle checked={node.hideBehindCamera} onChange={v => { node.hideBehindCamera = v; onChange(); }} />
                </PropertyRow>
            </>}
        </PropertyTable>
    );
}

function PayloadFields({ node, onChange }: { node: UINode, onChange: () => void }) {
    if (node instanceof UIRootNode) return <RootFields node={node} onChange={onChange} />;

    if (node instanceof UITextNode) return (
        <PropertyTable>
            <PropertyRow label='Text'><TextInput value={node.text} onChange={v => { node.text = v; onChange(); }} /></PropertyRow>
            <PropertyRow label='Font size'><NumberInput min={1} value={node.fontSize} onChange={v => { node.fontSize = v; onChange(); }} /></PropertyRow>
            <PropertyRow label='Font family'><TextInput value={node.fontFamily} placeholder='(inherit)' onChange={v => { node.fontFamily = v; onChange(); }} /></PropertyRow>
            <PropertyRow label='Weight'><NumberInput min={100} max={900} step={100} value={node.fontWeight} onChange={v => { node.fontWeight = v; onChange(); }} /></PropertyRow>
            <PropertyRow label='Align'>
                <Choice value={node.align} onChange={v => { node.align = v as any; onChange(); }}
                    options={[{ value: 'left', label: 'Left' }, { value: 'center', label: 'Center' }, { value: 'right', label: 'Right' }]} />
            </PropertyRow>
            <PropertyRow label='Vertical'>
                <Choice value={node.vAlign} onChange={v => { node.vAlign = v as any; onChange(); }}
                    options={[{ value: 'top', label: 'Top' }, { value: 'middle', label: 'Middle' }, { value: 'bottom', label: 'Bottom' }]} />
            </PropertyRow>
            <PropertyRow label='Wrap'><Toggle checked={node.wrap} onChange={v => { node.wrap = v; onChange(); }} /></PropertyRow>
            <PropertyRow label='Line height'><NumberInput min={0} step={0.1} value={node.lineHeight} onChange={v => { node.lineHeight = v; onChange(); }} /></PropertyRow>
        </PropertyTable>
    );

    if (node instanceof UIImageNode) return (
        <>
            <PropertyTable>
                {/* The texture STORE, not a raw URL: this is what puts a UI image into asset hashing,
                    resync and the publish pass that packs referenced textures into the shipped bundle. */}
                <PropertyRow label='Texture'>
                    <TexturePicker value={node.textureId} onChange={id => { node.textureId = id; onChange(); }} />
                </PropertyRow>
                <PropertyRow label='Fit'>
                    <Choice value={node.fit} onChange={v => { node.fit = v as any; onChange(); }}
                        options={[
                            { value: 'fill', label: 'Fill' }, { value: 'contain', label: 'Contain' },
                            { value: 'cover', label: 'Cover' }, { value: 'tile', label: 'Tile' },
                        ]} />
                </PropertyRow>
            </PropertyTable>
        </>
    );

    if (node instanceof UIButtonNode) return (
        <PropertyTable>
            <PropertyRow label='Label'><TextInput value={node.label} onChange={v => { node.label = v; onChange(); }} /></PropertyRow>
            <PropertyRow label='Disabled'><Toggle checked={node.disabled} onChange={v => { node.disabled = v; onChange(); }} /></PropertyRow>
            <PropertyRow label='Disabled color'>
                <ColorInput color={toHex(node.disabledTint)}
                    onChange={rgb => { node.disabledTint = [rgb[0], rgb[1], rgb[2], node.disabledTint[3]]; onChange(); }} />
            </PropertyRow>
        </PropertyTable>
    );

    if (node instanceof UIStackNode) return (
        <PropertyTable>
            <PropertyRow label='Direction'>
                <Choice value={node.direction} onChange={v => { node.direction = v as any; onChange(); }}
                    options={[{ value: 'column', label: 'Column' }, { value: 'row', label: 'Row' }]} />
            </PropertyRow>
            <PropertyRow label='Gap'><NumberInput value={node.gap} onChange={v => { node.gap = v; onChange(); }} /></PropertyRow>
            <PropertyRow label='Justify'>
                <Choice value={node.justify} onChange={v => { node.justify = v as any; onChange(); }}
                    options={[
                        { value: 'start', label: 'Start' }, { value: 'center', label: 'Center' },
                        { value: 'end', label: 'End' }, { value: 'spaceBetween', label: 'Space between' },
                        { value: 'spaceAround', label: 'Space around' },
                    ]} />
            </PropertyRow>
            <PropertyRow label='Align'>
                <Choice value={node.align} onChange={v => { node.align = v as any; onChange(); }}
                    options={[
                        { value: 'stretch', label: 'Stretch' }, { value: 'start', label: 'Start' },
                        { value: 'center', label: 'Center' }, { value: 'end', label: 'End' },
                    ]} />
            </PropertyRow>
            <PropertyRow label='Reverse'><Toggle checked={node.reverse} onChange={v => { node.reverse = v; onChange(); }} /></PropertyRow>
        </PropertyTable>
    );

    if (node instanceof UISpacerNode) return (
        <PropertyTable>
            <PropertyRow label='Flex'><NumberInput min={0} step={0.5} value={node.flex} onChange={v => { node.flex = v; onChange(); }} /></PropertyRow>
        </PropertyTable>
    );

    if (node instanceof UIProgressBarNode) return (
        <PropertyTable>
            <PropertyRow label='Min'><NumberInput value={node.min} onChange={v => { node.min = v; onChange(); }} /></PropertyRow>
            <PropertyRow label='Max'><NumberInput value={node.max} onChange={v => { node.max = v; onChange(); }} /></PropertyRow>
            <PropertyRow label='Value'><NumberInput value={node.value} onChange={v => { node.value = v; onChange(); }} /></PropertyRow>
            <PropertyRow label='Fill color'>
                <ColorInput color={toHex(node.fillTint)}
                    onChange={rgb => { node.fillTint = [rgb[0], rgb[1], rgb[2], node.fillTint[3]]; onChange(); }} />
            </PropertyRow>
            <PropertyRow label='Direction'>
                <Choice value={node.direction} onChange={v => { node.direction = v as any; onChange(); }}
                    options={[
                        { value: 'ltr', label: 'Left to right' }, { value: 'rtl', label: 'Right to left' },
                        { value: 'btt', label: 'Bottom to top' }, { value: 'ttb', label: 'Top to bottom' },
                    ]} />
            </PropertyRow>
            {/* Seconds for the displayed fill to chase `value`. 0 snaps. */}
            <PropertyRow label='Smoothing'><NumberInput min={0} step={0.05} value={node.smoothing} onChange={v => { node.smoothing = v; onChange(); }} /></PropertyRow>
        </PropertyTable>
    );

    if (node instanceof UISliderNode) return (
        <PropertyTable>
            <PropertyRow label='Min'><NumberInput value={node.min} onChange={v => { node.min = v; onChange(); }} /></PropertyRow>
            <PropertyRow label='Max'><NumberInput value={node.max} onChange={v => { node.max = v; onChange(); }} /></PropertyRow>
            <PropertyRow label='Step'><NumberInput min={0} step={0.1} value={node.step} onChange={v => { node.step = v; onChange(); }} /></PropertyRow>
            <PropertyRow label='Value'><NumberInput value={node.value} onChange={v => { node.value = v; onChange(); }} /></PropertyRow>
            <PropertyRow label='Vertical'><Toggle checked={node.vertical} onChange={v => { node.vertical = v; onChange(); }} /></PropertyRow>
            <PropertyRow label='Fill color'>
                <ColorInput color={toHex(node.fillTint)}
                    onChange={rgb => { node.fillTint = [rgb[0], rgb[1], rgb[2], node.fillTint[3]]; onChange(); }} />
            </PropertyRow>
            <PropertyRow label='Handle color'>
                <ColorInput color={toHex(node.handleTint)}
                    onChange={rgb => { node.handleTint = [rgb[0], rgb[1], rgb[2], node.handleTint[3]]; onChange(); }} />
            </PropertyRow>
        </PropertyTable>
    );

    if (node instanceof UIToggleNode) return (
        <PropertyTable>
            <PropertyRow label='Label'><TextInput value={node.label} onChange={v => { node.label = v; onChange(); }} /></PropertyRow>
            <PropertyRow label='Checked'><Toggle checked={node.checked} onChange={v => { node.checked = v; onChange(); }} /></PropertyRow>
            <PropertyRow label='On color'>
                <ColorInput color={toHex(node.onTint)}
                    onChange={rgb => { node.onTint = [rgb[0], rgb[1], rgb[2], node.onTint[3]]; onChange(); }} />
            </PropertyRow>
            <PropertyRow label='Off color'>
                <ColorInput color={toHex(node.offTint)}
                    onChange={rgb => { node.offTint = [rgb[0], rgb[1], rgb[2], node.offTint[3]]; onChange(); }} />
            </PropertyRow>
        </PropertyTable>
    );

    if (node instanceof UITextInputNode) return (
        <PropertyTable>
            <PropertyRow label='Value'><TextInput value={node.value} onChange={v => { node.value = v; onChange(); }} /></PropertyRow>
            <PropertyRow label='Placeholder'><TextInput value={node.placeholder} onChange={v => { node.placeholder = v; onChange(); }} /></PropertyRow>
            <PropertyRow label='Max length'><NumberInput min={0} value={node.maxLength} onChange={v => { node.maxLength = v; onChange(); }} /></PropertyRow>
            <PropertyRow label='Font size'><NumberInput min={1} value={node.fontSize} onChange={v => { node.fontSize = v; onChange(); }} /></PropertyRow>
            <PropertyRow label='Password'><Toggle checked={node.password} onChange={v => { node.password = v; onChange(); }} /></PropertyRow>
            <PropertyRow label='Read only'><Toggle checked={node.readOnly} onChange={v => { node.readOnly = v; onChange(); }} /></PropertyRow>
        </PropertyTable>
    );

    return null;
}

export default function UIEditor({ node }: { node: UINode }) {
    const bump = useNodeVersion(node);

    // A root's rect comes from the viewport or its projection, so the anchor/offset fields do not apply
    // to it — showing them would be offering edits the layout pass ignores.
    const isRoot = node instanceof UIRootNode;

    return (
        <>
            <Collapsable title={isRoot ? 'Canvas' : 'Element'} persistKey='ui-payload'>
                <PayloadFields node={node} onChange={bump} />
            </Collapsable>

            {!isRoot && (
                <Collapsable title='Anchor & Rect' persistKey='ui-rect'>
                    <AnchorPicker node={node} onChange={bump} />
                    <RectFields node={node} onChange={bump} />
                </Collapsable>
            )}

            <Collapsable title='Appearance' persistKey='ui-appearance'>
                <AppearanceFields node={node} onChange={bump} />
            </Collapsable>
        </>
    );
}
