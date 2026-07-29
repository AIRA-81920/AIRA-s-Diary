// TailwindCSS 配置文件
// 功能：配置扫描路径、扩展"深空智识"美学系统的字体/色板/动画
// 实现方式：content 指定扫描范围，theme.extend 追加项目专属设计 token
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      // 字体系统：衬线展示字 + 现代无衬线
      fontFamily: {
        display: ['"Cormorant Garamond"', 'Georgia', 'serif'],
        sans: ['Manrope', 'ui-sans-serif', 'system-ui', 'sans-serif']
      },
      // 色板：深空蓝黑 + 青色主强调 + 琥珀次强调
      colors: {
        // 主题感知色（RGB 三元组变量，dark=白 / light=墨色，见 index.css :root）
        ink: 'rgb(var(--ink) / <alpha-value>)',
        veil: 'rgb(var(--veil) / <alpha-value>)',
        line: 'rgb(var(--line) / <alpha-value>)',
        // 深空蓝黑系（背景与卡片层级）
        intellect: {
          50: '#1a1f2e',
          100: '#151926',
          200: '#11141f',
          300: '#0d1019',
          400: '#0a0e1a',
          500: '#080b15',
          600: '#060810',
          700: '#04060c',
          800: '#020407',
          900: '#010205'
        },
        // 青色主强调（AI 元素、CTA）
        accent: {
          50: '#ecfeff',
          100: '#cffafe',
          200: '#a5f3fc',
          300: '#67e8f9',
          400: '#22d3ee',
          500: '#06b6d4', // 主色
          600: '#0891b2',
          700: '#0e7490',
          800: '#155e75',
          900: '#164e63'
        },
        // 琥珀次强调（PRD 字段、成功状态）
        gold: {
          50: '#fffbeb',
          100: '#fef3c7',
          200: '#fde68a',
          300: '#fcd34d',
          400: '#fbbf24',
          500: '#f59e0b', // 主色
          600: '#d97706',
          700: '#b45309',
          800: '#92400e',
          900: '#78350f'
        }
      },
      // 动画 keyframes
      keyframes: {
        fadeInUp: {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' }
        },
        pulseSoft: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.6' }
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' }
        },
        glowPulse: {
          '0%, 100%': { boxShadow: '0 0 20px rgba(6, 182, 212, 0.15)' },
          '50%': { boxShadow: '0 0 30px rgba(6, 182, 212, 0.3)' }
        }
      },
      animation: {
        'fade-in-up': 'fadeInUp 0.4s cubic-bezier(0.16, 1, 0.3, 1) both',
        'pulse-soft': 'pulseSoft 2s ease-in-out infinite',
        shimmer: 'shimmer 2.5s linear infinite',
        'glow-pulse': 'glowPulse 3s ease-in-out infinite'
      },
      // 背景图片辅助
      backgroundImage: {
        'gradient-radial': 'radial-gradient(var(--tw-gradient-stops))'
      }
    }
  },
  plugins: []
}
