import animate from 'tailwindcss-animate';

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // Claude 风格：陶土橙主色
        primary: {
          DEFAULT: '#D97757',
          deep: '#C15F3C',
          soft: '#E8A78C',
        },
        // 暖米白纸面
        surface: {
          900: '#F5F4EF',
          800: '#FFFFFF',
          700: '#EFEDE4',
        },
        ink: {
          DEFAULT: '#1F1E1D',
          muted: '#6B6862',
        },
        // 暖色细分割线
        line: 'rgba(31, 30, 29, 0.10)',
        state: {
          ok: '#6B8E4E',
          warn: '#C08A3E',
          bad: '#BF4D43',
          idle: '#9A968C',
        },
      },
      fontFamily: {
        sans: ['PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'system-ui', 'sans-serif'],
        // 衬线用于标题，贴近 Claude 的书面感
        serif: ['Georgia', 'Times New Roman', 'Songti SC', 'STSong', 'serif'],
        mono: ['SF Mono', 'Menlo', 'Consolas', 'monospace'],
      },
      boxShadow: {
        // 低对比暖阴影，代替深色主题的厚重投影
        glass: '0 1px 2px rgba(31, 30, 29, 0.04), 0 8px 24px rgba(31, 30, 29, 0.06)',
        lift: '0 12px 28px rgba(31, 30, 29, 0.12)',
      },
      keyframes: {
        'pulse-ring': {
          '0%': { opacity: '0.85', transform: 'scale(0.96)' },
          '70%': { opacity: '0', transform: 'scale(1.35)' },
          '100%': { opacity: '0', transform: 'scale(1.35)' },
        },
        'slide-in': {
          from: { transform: 'translateX(24px)', opacity: '0' },
          to: { transform: 'translateX(0)', opacity: '1' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-320px 0' },
          '100%': { backgroundPosition: '320px 0' },
        },
      },
      animation: {
        'pulse-ring': 'pulse-ring 1.8s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'slide-in': 'slide-in 220ms ease-out',
        shimmer: 'shimmer 2.4s linear infinite',
      },
    },
  },
  plugins: [animate],
};
