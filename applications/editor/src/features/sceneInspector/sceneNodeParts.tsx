import { useRef } from 'react'
import { isUINodeType } from 'cleo';
import { useCleoEngine } from '../EngineContext'
import { SkyIcon } from '../nodeInspector/sectionIcons'
import {
  CameraIcon, CameraRigIcon, CharacterAddIcon, ControllerAddIcon, NavMeshIcon, ModelIcon, LightIcon, LightProbeIcon, ExposureVolumeIcon, GiVolumeIcon, VolumetricFogIcon, SkyboxIcon, SkyLightIcon, CloudsIcon, WindIcon, WeatherIcon,
  SpriteIcon, AnimatedSpriteIcon, TilemapIcon, LandscapeIcon, VisibleIcon, HiddenIcon, SoundIcon, DecalIcon, ParticlesIcon, ForceFieldIcon, WaterVolumeIcon, OcclusionVolumeIcon, ClothIcon,
  SequenceIcon, Camera2DIcon, Room2DIcon, ParallaxLayerIcon, CharacterBody2DIcon, Collider2DIcon, ColliderIcon, TriggerIcon,
} from './nodeIcons'
import { Glyph } from './iconBase';
import { UI_ICONS } from './uiIcons';
import { hoveredScriptStore, useHoveredScript } from './hoveredScriptStore';
import type { NodeDescription } from './sceneGraphLayout';

// What a scene-tree row and a Graph view card have in common: the type glyph, the row's own buttons and
// the inline rename field. One implementation, so the two views cannot drift apart.

/** Glyph per node type, as a table rather than a chain of per-type conditionals in the row. */
const TYPE_ICONS: Record<string, () => JSX.Element> = {
  camera: CameraIcon, cameraRig: CameraRigIcon, model: ModelIcon,
  character: CharacterAddIcon, controller: ControllerAddIcon, navMesh: NavMeshIcon,
  sprite: SpriteIcon, animatedSprite: AnimatedSpriteIcon, tilemap: TilemapIcon,
  light: LightIcon, lightProbe: LightProbeIcon, exposureVolume: ExposureVolumeIcon, giVolume: GiVolumeIcon, volumetricFog: VolumetricFogIcon, decal: DecalIcon,
  skybox: SkyboxIcon, volumetricClouds: CloudsIcon, skyAtmosphere: SkyIcon, skyLight: SkyLightIcon, wind: WindIcon, weather: WeatherIcon,
  landscape: LandscapeIcon,
  // One glyph for both modes: the tree shows what a node IS, and ambient vs spatial is a property of it.
  sound: SoundIcon,
  particleSystem: ParticlesIcon, forceField: ForceFieldIcon, cloth: ClothIcon, waterVolume: WaterVolumeIcon, occlusionVolume: OcclusionVolumeIcon,
  sequence: SequenceIcon,
  camera2D: Camera2DIcon, room2D: Room2DIcon, parallaxLayer: ParallaxLayerIcon,
  characterBody2D: CharacterBody2DIcon, body2D: Collider2DIcon,
  collider: ColliderIcon, trigger: TriggerIcon,
};

/** The glyph a node type is drawn with, UI elements included; undefined for a type with none (a plain node). */
export const typeIconFor = (type: string): (() => JSX.Element) | undefined =>
  isUINodeType(type) ? UI_ICONS[type] : TYPE_ICONS[type];

export const PenIcon = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z" />
  </svg>
);

// A code-brackets glyph marking a node that carries a script. `</>` reads as "script/code" at 14px.
export const ScriptIcon = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M8 6 3 12l5 6" />
    <path d="M16 6l5 6-5 6" />
  </svg>
);

/** The Graph view toggle: one card over two, joined, i.e. a hierarchy drawn as a graph. */
export const GraphViewIcon = () => (
  <Glyph>
    <rect x="8.5" y="3" width="7" height="5" rx="1" />
    <rect x="2.5" y="16" width="7" height="5" rx="1" />
    <rect x="14.5" y="16" width="7" height="5" rx="1" />
    <path d="M12 8v4M6 16v-4h12v4" />
  </Glyph>
);

/** Disclosure arrow: one rotating chevron rather than two glyphs. */
export const Chevron = ({ open }: { open: boolean }) => (
  <svg viewBox="0 0 24 24" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="3.2"
       strokeLinecap="round" strokeLinejoin="round"
       className={`transition-transform duration-100 ${open ? 'rotate-90' : ''}`}>
    <path d="m9 6 6 6-6 6" />
  </svg>
);

/**
 * A node's own controls: edit its script, edit its template, show/hide it. They fade in with the row (the
 * eye stays up while the node is hidden), so a deep hierarchy reads as names first and buttons second.
 * The host must carry Tailwind's `group` class for the hover fade.
 */
export function NodeControls({ data }: { data: NodeDescription }) {
  // The inspected scene: the running simulation while Simulating, the edited scene otherwise.
  const { inspectedScene: editorScene, isPlayMode, enterTemplateEditor, enterScriptEditor } = useCleoEngine();
  const hoveredScript = useHoveredScript();
  // A template-instance row shows no script glyph: its script is authored in the template, reached through
  // the edit-template button. Elsewhere the glyph is highlighted while its script is the one hovered anywhere.
  const showScript = !!data.scriptId && !data.templateId;
  const scriptHot = !!data.scriptId && data.scriptId === hoveredScript;

  const toggleVisibility = (event: React.MouseEvent) => {
    event.stopPropagation();
    if (isPlayMode) return; // Don't allow visibility changes during play mode
    const target = editorScene?.getNodeById(data.id);
    if (target) target.visible = !target.visible;
  };

  return (
    <div className='flex flex-row items-center shrink-0 gap-1 pl-1'>
      { showScript &&
        <button
          title='Edit script'
          onClick={(e) => { e.stopPropagation(); enterScriptEditor(data.scriptId); }}
          onMouseEnter={() => hoveredScriptStore.set(data.scriptId ?? null)}
          onMouseLeave={() => hoveredScriptStore.set(null)}
          className={`inline-flex items-center justify-center w-4 h-4 transition-colors ${
            scriptHot ? 'text-highlight' : 'text-muted hover:text-highlight'}`}>
          <ScriptIcon />
        </button>
      }
      { data.templateId &&
        <button
          title='Edit template'
          onClick={(e) => { e.stopPropagation(); enterTemplateEditor(data.templateId); }}
          className='inline-flex items-center justify-center w-4 h-4 text-muted hover:text-highlight transition-colors'>
          <PenIcon />
        </button>
      }
      {/* A button rather than the <img onClick> this used to be: it is a control, so it should be
          focusable and activate on Enter like the script and template buttons beside it. */}
      <button
        type='button'
        onClick={toggleVisibility}
        title={data.visible ? 'Hide' : 'Show'}
        className={`inline-flex items-center justify-center w-4 h-4 transition-opacity ${
          data.visible ? 'opacity-0 group-hover:opacity-60 hover:!opacity-100 focus-visible:opacity-100' : 'opacity-70 hover:opacity-100'}`}>
        {data.visible ? <VisibleIcon /> : <HiddenIcon />}
      </button>
    </div>
  );
}

export interface RenameFieldProps {
  initial: string;
  onSubmit: (name: string) => void;
  /** `byKey`: Escape, as opposed to focus leaving for somewhere else (which must not be taken back). */
  onCancel: (byKey: boolean) => void;
  className?: string;
}

/** The inline rename field. Enter commits through onSubmit; Escape and blur abandon the edit. */
export function RenameField({ initial, onSubmit, onCancel, className = '' }: RenameFieldProps) {
  const input = useRef<HTMLInputElement | null>(null);
  return (
    <input
      ref={input}
      autoFocus
      defaultValue={initial}
      onFocus={(e) => e.currentTarget.select()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onBlur={() => onCancel(false)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') onCancel(true);
        if (e.key === 'Enter') onSubmit(input.current?.value ?? '');
      }}
      className={`type-value bg-scrim/40 text-fg rounded px-1 outline-none ring-1 ring-primary/60 w-full min-w-0 ${className}`} />
  );
}
