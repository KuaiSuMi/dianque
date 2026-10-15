# Apple-Style 资源

`apple-style.css` 和 `liquid-glass.js` 来自本机 Apple-Style skill 的 `web/` 目录，复制时间为 2026-10-15。保留原文件中的来源说明；未打包 SF 字体或 SF Symbols。

本项目对运行时的修改：分段控件的 roving tabindex、方向键/Home/End 焦点移动及键盘/辅助技术点击；取消拖动时恢复原值；开关支持辅助技术点击；React 移除元素后清理玻璃和分段控件的 observer、动画帧与 SVG 滤镜。

工具栏保留模糊材质，关闭 SVG 折射；悬停不再临时提升整组合成层。折射开关在尺寸和主题更新时同样生效，避免重新启用已关闭的效果。

应用只使用工具栏、弹层材质与分段/开关交互。页面和弹层动画由 Motion 实现，金额更新使用 Web Animations API。自定义视觉与媒体查询集中在 `../styles.css`。
