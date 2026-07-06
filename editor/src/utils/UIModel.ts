// Simple UI elements system for editor-managed HTML/CSS overlays
// These elements live outside the 3D scene and render as regular DOM

export type UIElementType = 'container' | 'text' | 'image' | 'button';

export type UIStyle = {
  position?: 'absolute' | 'relative' | 'fixed';
  left?: number; // px
  top?: number; // px
  width?: number; // px
  height?: number; // px
  padding?: number; // px
  margin?: number; // px
  backgroundColor?: string;
  color?: string;
  fontSize?: number; // px
  fontFamily?: string;
  fontWeight?: number | 'bold' | 'normal';
  textAlign?: 'left' | 'center' | 'right';
  borderRadius?: number; // px
  border?: string; // e.g. '1px solid #fff'
  zIndex?: number;
  display?: 'block' | 'inline-block' | 'flex';
  justifyContent?: 'flex-start' | 'center' | 'flex-end' | 'space-between' | 'space-around';
  alignItems?: 'flex-start' | 'center' | 'flex-end';
  gap?: number; // px
  // Allow arbitrary CSS properties as string/number pairs as an escape hatch
  [key: string]: any;
};

export type UIBase = {
  id: string;
  type: UIElementType;
  name?: string;
  style?: UIStyle;
  // Optional script run in play mode: may define onStart(el, ctx), onUpdate(el, ctx, delta, time),
  // and (for buttons) onClick(el, ctx). See the UI runtime for the available context.
  script?: string;
};

export type UIContainer = UIBase & {
  type: 'container';
  children: UIElement[];
};

export type UIText = UIBase & {
  type: 'text';
  content: string;
};

export type UIImage = UIBase & {
  type: 'image';
  src: string; // URL or base64
  alt?: string;
};

export type UIButton = UIBase & {
  type: 'button';
  label: string;
};

export type UIElement = UIContainer | UIText | UIImage | UIButton;

export type UIState = {
  elements: UIElement[]; // top-level elements (usually absolute positioned)
  version: 1;
};

// Serialize UI state into plain JSON
export function serializeUI(state: UIState): any {
  // Already plain-data; return a deep copy to avoid accidental mutation
  return JSON.parse(JSON.stringify({ ui: { version: state.version, elements: state.elements } }));
}

// Parse UI from arbitrary JSON (with basic validation and defaults)
export function parseUI(input: any): UIState {
  const ui = input?.ui ?? input; // support both wrapped and direct
  const version = (ui?.version ?? 1) as 1;
  const elements = Array.isArray(ui?.elements) ? ui.elements : [];

  // Basic sanitizer to ensure required fields exist
  const sanitize = (el: any): UIElement | null => {
    if (!el || typeof el !== 'object') return null;
    const base: UIBase = {
      id: String(el.id ?? cryptoRandomId()),
      type: el.type,
      name: el.name ? String(el.name) : undefined,
      style: typeof el.style === 'object' && el.style ? { ...el.style } : undefined,
      script: el.script ? String(el.script) : undefined,
    };

    switch (el.type as UIElementType) {
      case 'container':
        return {
          ...base,
          type: 'container',
          children: Array.isArray(el.children) ? el.children.map(sanitize).filter(Boolean) as UIElement[] : [],
        };
      case 'text':
        return { ...base, type: 'text', content: String(el.content ?? '') };
      case 'image':
        return { ...base, type: 'image', src: String(el.src ?? ''), alt: el.alt ? String(el.alt) : undefined };
      case 'button':
        return { ...base, type: 'button', label: String(el.label ?? 'Button') };
      default:
        return null;
    }
  };

  return {
    version,
    elements: elements.map(sanitize).filter(Boolean) as UIElement[],
  };
}

// Utility to generate stable-ish random ids without relying on external libs
export function cryptoRandomId(): string {
  if (typeof crypto !== 'undefined' && 'getRandomValues' in crypto) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  // Fallback
  return 'ui_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}
