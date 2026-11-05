// 悬浮球窗口的轻量入口（内存优化 P2）：完整 SPA 的活堆是隐藏窗口 renderer 的
// 内存大头，球只需要环形菜单一个组件。
// 主题由 FloatingBallWindow 自举（get_theme_config 初始值 + 主窗 useTheme 的
// 'floating-ball-theme' 运行时推送），入口零额外逻辑。
import { createApp } from 'vue'
import '../style.css'
import FloatingBallWindow from '../components/FloatingBallWindow.vue'

createApp(FloatingBallWindow).mount('#app')
