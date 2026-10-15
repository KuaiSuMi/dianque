# 图标来源

icon-32.png、icon-192.png、icon-512.png 于 2026-10-16 使用内置 imagegen 生成，再以高质量双三次插值缩放导出。图形为玉绿底、暖白麻将牌与朱红单点，无文字；背景不透明，供浏览器、手机主屏幕与 PWA 使用。

生成提示词：

```text
Use case: logo-brand. Asset type: production square app icon for 点雀 (Dianque), a Japanese riichi mahjong scorekeeping PWA. Generate one finished 1024x1024 icon, not a presentation mockup. Edge-to-edge opaque deep jade green background (#216b51 family) with a very subtle soft light gradient. Center one beautifully crafted warm ivory mahjong tile, almost front facing with slight three dimensional depth and a restrained green lower edge. Gently rounded tile corners, soft ceramic/resin surface, sophisticated tactile detail, crisp silhouette. Tile face has exactly one bold vermilion red circular pip recessed slightly into its center, a tiny soft highlight making it feel tangible. No other symbols. Composition is calm and strongly recognizable at 32 pixels: tile occupies roughly 48 percent of canvas width and 60 percent of height, optically centered with its entire silhouette inside the central 76 percent diameter circular safe area for maskable app icons. Subtle contact shadow, clean controlled lighting from upper left, contemporary restrained premium native mobile app aesthetic, no visual clutter. No characters, no letters, no words, no numbers, no watermark, no frame, no extra tiles or sticks. Full square background all the way to the four corners; do not round the outer canvas corners; do not put the icon inside another square.
```

界面图标来自 package.json 中锁定的 lucide-react 包；七段数字由 src/main.jsx 中的 SVG 按实时点数绘制。
