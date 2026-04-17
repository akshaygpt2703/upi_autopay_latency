/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#212427',
        primary: '#4169E1',
        'primary-hover': '#3658c7',
        muted: '#6B7280',
        'soft-bg': '#F7F8FA',
        border: '#E5E7EB',
        success: '#10B981',
        danger: '#EF4444',
        warning: '#F59E0B'
      },
      fontFamily: {
        sans: ['"Plus Jakarta Sans"', 'system-ui', 'sans-serif'],
        body: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace']
      }
    }
  },
  plugins: []
};
