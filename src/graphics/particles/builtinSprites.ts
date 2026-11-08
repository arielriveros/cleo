import { Texture } from '../texture';
import { builtinSpriteSheet, isBuiltinTextureId } from '../../particles/precipitationSprites';

// The engine's own particle sprites on the GPU (particles/precipitationSprites.ts makes their pixels):
// uploaded the first time an emitter draws with one, kept for the session. Never in the TextureManager,
// so no picker lists them and nothing saves or publishes them; a published player makes its own.

const textures = new Map<string, Texture>();

/** The texture for a built-in sprite id, made on first use; null for any other id. */
export function builtinSpriteTexture(id: string): Texture | null {
    if (!isBuiltinTextureId(id)) return null;
    let texture = textures.get(id);
    if (!texture) {
        const sheet = builtinSpriteSheet(id);
        if (!sheet) return null;
        texture = new Texture({ mipMap: true, wrapping: 'clamp' });
        texture.createFromPixels(sheet.pixels, sheet.width, sheet.height);
        textures.set(id, texture);
    }
    return texture;
}

/** Drop every built-in sprite's texture (a device loss, the renderer's teardown). */
export function releaseBuiltinSprites(): void {
    for (const t of textures.values()) t.delete();
    textures.clear();
}
