// 通知窗的轻量入口（内存优化 P2）：完整 SPA 的活堆是隐藏窗口 renderer 的
// 内存大头，通知窗只需要卡片渲染一个组件。
// 主题由 NoticeOverlay 自举（get_theme_config 初始值 + 主窗推送的运行时跟随），
// 入口零额外逻辑。
import { createApp } from 'vue'
import '../style.css'
import NoticeOverlay from '../components/NoticeOverlay.vue'

createApp(NoticeOverlay).mount('#app')
