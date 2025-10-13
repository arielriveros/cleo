/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/**/*.{js,ts,jsx,tsx,html}",
    "./public/**/*.{html,js}"
  ],
  theme: {
    extend: {
      colors: {
        editor: {
          bg: '#0f1117',
          panel: '#1b1e27',
          accent: '#2d2d77',
          muted: '#9aa4b2',
          primary: '#326acc',
        }
      },
      boxShadow: {
        'panel': '0 1px 1px rgba(0,0,0,0.15), 0 6px 12px rgba(0,0,0,0.25)'
      }
    },
  },
  plugins: [],
};
