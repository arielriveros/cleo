/** @type {import('tailwindcss').Config} */

// The Cleo design system comes from the app-kit preset, so Creator and the Editor look like one product.
module.exports = {
  presets: [require('../app-kit/tailwind.preset')],
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx,html}",
    "../app-kit/src/**/*.{ts,tsx}",
  ],
};
