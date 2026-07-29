// PostCSS 配置文件
// 功能：注册 TailwindCSS 与 Autoprefixer 两个 PostCSS 插件
// 实现方式：导出插件数组，Tailwind 负责生成原子化 CSS，Autoprefixer 自动添加浏览器前缀
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {}
  }
}
