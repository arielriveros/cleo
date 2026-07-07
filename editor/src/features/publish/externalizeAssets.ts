// Turns an embedded game-data object into a lighter one: every `data:image/...` string is pulled out
// to a loose file and replaced with that file's relative path. This works with zero engine/player
// changes because every consumer restores images via `image.src = <string>`, and `image.src` accepts a
// relative URL exactly like a data: URI (see TextureManager.addTextureFromBase64, Scene env-map
// createImage, Skybox.fromBase64). Terrain splat maps are data-backed and excluded from serialization,
// so nothing unsafe is externalized.

export interface ExternalAsset {
  path: string;   // relative path, e.g. "assets/asset_0.png"
  base64: string; // raw base64 payload (no "data:...;base64," prefix)
}

export interface ExternalizeResult {
  data: any;               // the same object, mutated to reference paths
  assets: ExternalAsset[]; // files to write alongside game.json
}

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
};

function parseDataUri(value: string): { mime: string; base64: string } | null {
  // data:<mime>;base64,<payload>
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(value);
  if (!match) return null;
  return { mime: match[1].toLowerCase(), base64: match[2] };
}

// Deep-walk `data`, replacing every base64 image data URI with a relative asset path.
export function externalizeAssets(data: any): ExternalizeResult {
  const assets: ExternalAsset[] = [];
  const seen = new Map<string, string>(); // data URI -> path (dedupe identical images)
  let counter = 0;

  const externalizeString = (value: string): string => {
    const existing = seen.get(value);
    if (existing) return existing;
    const parsed = parseDataUri(value);
    if (!parsed) return value; // not a base64 image data URI (e.g. data:image/svg+xml,...) -> leave as-is
    const ext = MIME_EXT[parsed.mime] || 'bin';
    const path = `assets/asset_${counter++}.${ext}`;
    assets.push({ path, base64: parsed.base64 });
    seen.set(value, path);
    return path;
  };

  const walk = (node: any): void => {
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const v = node[i];
        if (typeof v === 'string' && v.startsWith('data:image/')) node[i] = externalizeString(v);
        else if (v && typeof v === 'object') walk(v);
      }
      return;
    }
    for (const key of Object.keys(node)) {
      const v = node[key];
      if (typeof v === 'string' && v.startsWith('data:image/')) node[key] = externalizeString(v);
      else if (v && typeof v === 'object') walk(v);
    }
  };

  if (data && typeof data === 'object') walk(data);
  return { data, assets };
}
