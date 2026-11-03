/** @type {import('tailwindcss').Config} */

// The design tokens, type scale and colours live in the app-kit preset, shared with Cleo Creator.
module.exports = {
  presets: [require('../app-kit/tailwind.preset')],
  // Never public/: it holds the built player (public/player/game*.js, ~80 MB of minified bundles), whose
  // classes all come from src/ anyway (the player itself has no CSS). Tailwind's extractor over those lines
  // took five minutes of the dev server's main thread on every start, holding theme.css and every request
  // behind it.
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx,html}",
    "../app-kit/src/**/*.{ts,tsx}",
  ],
};
