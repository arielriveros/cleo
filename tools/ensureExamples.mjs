// Dev and build guard for the example gallery (applications/editor/public/examples/, built from examples/ by
// tools/examples/gallery.mjs). Rebuilds only the examples whose folder changed; never downloads anything. An
// example whose data has not been fetched is left out with a hint, and the dev start goes on: a missing gallery
// must not stop anyone from working. A release build sets CLEO_EXAMPLES_REQUIRED=1, which makes it an error.
import { buildGallery } from './examples/gallery.mjs';

try {
    const r = await buildGallery({ log: (m) => console.log(`[examples]${m}`) });
    if (r.built.length) console.log(`[examples] built ${r.built.join(', ')}`);
    if (r.missing.length) console.log(`[examples] no data for ${r.missing.join(', ')} (left out of the gallery): npm run examples:fetch`);
} catch (e) {
    console.error(`[examples] ${e.message}`);
    if (process.env.CLEO_EXAMPLES_REQUIRED === '1') process.exit(1);
}
