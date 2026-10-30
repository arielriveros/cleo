/** @type {import('tailwindcss').Config} */

// The design tokens, type scale and colours live in the app-kit preset, shared with Cleo Creator.
module.exports = {
  presets: [require('../app-kit/tailwind.preset')],
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx,html}",
    "./public/**/*.{html,js}",
    "../app-kit/src/**/*.{ts,tsx}",
  ],
};
