// Decoding an image from a URL: what the runtime needs from what used to be the model loader (loader.ts).
// Its own leaf module so a texture, a skybox or a heightmap can load an image without importing the model
// importers (assimp's WASM alone is 5 MB), which are editor tools a published game never runs.

/** Load an image element from a URL or data URI. */
export function loadImage(path: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.src = path;
        image.onload = () => resolve(image);
        image.onerror = (err) => reject(err);
    });
}

/** Decode an image from a URL or data URI into RGBA8 pixels. */
export function imageToArray(path: string): Promise<{ data: Uint8Array, width: number, height: number }> {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.src = path;
        image.onload = () => {
            // Everything in here REJECTS rather than throws: an exception inside an event handler never
            // reaches the promise, so a failed decode (no 2D context, a canvas too large to allocate) used
            // to leave the caller awaiting forever with nothing reported.
            try {
                const data = new Uint8Array(image.width * image.height * 4);
                const canvas = document.createElement('canvas');
                canvas.width = image.width;
                canvas.height = image.height;
                const context = canvas.getContext('2d');
                if (!context) throw new Error('Failed to create canvas context');
                context.drawImage(image, 0, 0);
                const imageData = context.getImageData(0, 0, image.width, image.height);
                data.set(imageData.data);
                resolve({ data, width: image.width, height: image.height });
            } catch (err) {
                reject(err);
            }
        };
        image.onerror = () => reject(new Error('The image could not be decoded'));
    });
}
