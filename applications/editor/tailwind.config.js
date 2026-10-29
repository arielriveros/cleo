/** @type {import('tailwindcss').Config} */

// Map a CSS custom property (space-separated RGB channels) to a Tailwind color
// that honours opacity modifiers, e.g. `bg-surface/95` -> rgb(var(--surface) / 0.95).
const rgbVar = (name) => `rgb(var(${name}) / <alpha-value>)`;

module.exports = {
  content: [
    "./index.html",
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
          fg: rgbVar('--danger-fg'),
        },
        success: {
          DEFAULT: rgbVar('--success'),
          hover: rgbVar('--success-hover'),
          fg: rgbVar('--success-fg'),
        },
        warning: rgbVar('--warning'),
        scrim: rgbVar('--scrim'),
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
      // The editor's type scale as utilities (`text-ui-sm`), so a size is a ROLE rather than a pixel
      // count — `text-[11px]` scattered through the panels is what let sizes drift. Must stay in step
      // with the font-size group in components/ui/cn.ts, or tailwind-merge reads `text-ui-sm` as a colour
      // and silently drops it next to `text-muted`.
      fontSize: {
        'ui-2xs': 'var(--text-ui-2xs)',
        'ui-xs': 'var(--text-ui-xs)',
        'ui-sm': 'var(--text-ui-sm)',
        // A line height on the two sizes that replace Tailwind's text-xs / text-sm, so swapping one for the
        // other moves nothing; the smaller ones replace bare text-[Npx] values, which carry none.
        'ui': ['var(--text-ui)', '1rem'],
        'ui-lg': ['var(--text-ui-lg)', '1.25rem'],
      },
      boxShadow: {
        'panel': '0 1px 1px rgba(0,0,0,0.15), 0 6px 12px rgba(0,0,0,0.25)'
      }
    },
  },
  plugins: [],
};
