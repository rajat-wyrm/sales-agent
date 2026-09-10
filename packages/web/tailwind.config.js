/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/**/*.{js,ts,jsx,tsx}',
    './src/components/**/*.{js,ts,jsx,tsx}',
    './src/pages/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        sidebar: '210 20% 98%',
        sidebarforeground: '240 5.2% 33.9%',
        sidebarmuted: '240 4.8% 95.9%',
        sidebarborder: '240 5.9% 90%',
        sidebaractive: '225.9 100% 96.7%',
        sidebaractiveforeground: '244.5 57.9% 50.6%',
        hot: '0 84.3% 60%',
        hotsoft: '0 85.7% 97.3%',
        warm: '37.7 92.1% 50.2%',
        warmsoft: '48 100% 96.1%',
        cold: '198.6 88.7% 48.4%',
        coldsoft: '204 100% 97.1%',
      },
      borderRadius: {
        lg: '0.5rem',
        md: '0.375rem',
        sm: '0.25rem',
        smlg: '0.2rem',
      },
    },
  },
  plugins,
}
