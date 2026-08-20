/** @type {import('tailwindcss').Config} */

// Map a CSS custom property (space-separated RGB channels) to a Tailwind color
// that honours opacity modifiers, e.g. `bg-surface/95` -> rgb(var(--surface) / 0.95).
const rgbVar = (name) => `rgb(var(${name}) / <alpha-value>)`;

module.exports = {
  content: [
    "./src/**/*.{js,ts,jsx,tsx,html}",
    "./public/**/*.{html,js}"
  ],
  theme: {
    extend: {
      colors: {
        bg: rgbVar('--bg'),
        surface: {
          DEFAULT: rgbVar('--surface'),
          sunken: rgbVar('--surface-sunken'),
          raised: rgbVar('--surface-raised'),
        },
        control: {
          DEFAULT: rgbVar('--control'),
          hover: rgbVar('--control-hover'),
        },
        border: {
          DEFAULT: rgbVar('--border'),
          subtle: rgbVar('--border-subtle'),
        },
        menubar: rgbVar('--menubar'),
        primary: {
          DEFAULT: rgbVar('--primary'),
          hover: rgbVar('--primary-hover'),
          active: rgbVar('--primary-active'),
        },
        selected: rgbVar('--selected'),
        highlight: rgbVar('--highlight'),
        fg: rgbVar('--text'),
        muted: rgbVar('--text-muted'),
        dim: rgbVar('--text-dim'),
        danger: {
          DEFAULT: rgbVar('--danger'),
          hover: rgbVar('--danger-hover'),
          surface: rgbVar('--danger-surface'),
          'surface-hover': rgbVar('--danger-surface-hover'),
          border: rgbVar('--danger-border'),
        },
        success: {
          DEFAULT: rgbVar('--success'),
          hover: rgbVar('--success-hover'),
        },
        warning: rgbVar('--warning'),
        node: {
          ui: rgbVar('--node-ui'),
        },
        axis: {
          x: rgbVar('--axis-x'),
          y: rgbVar('--axis-y'),
          z: rgbVar('--axis-z'),
        },
      },
      fontFamily: {
        mono: 'var(--font-mono)',
      },
      boxShadow: {
        'panel': '0 1px 1px rgba(0,0,0,0.15), 0 6px 12px rgba(0,0,0,0.25)'
      }
    },
  },
  plugins: [],
};
