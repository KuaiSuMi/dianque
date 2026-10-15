# 图标来源

icon-32.png、icon-192.png、icon-512.png 于 2026-10-16 使用内置 imagegen 生成，再以高质量双三次插值缩放导出。图形为浅绿底上的两根斜向暖白点棒：立直棒带朱红单点，本场棒带八枚深绿点；无文字，背景不透明，供浏览器、手机主屏幕与 PWA 使用。背景按用户指定的 #C0FFD2 生成。

生成提示词：

```text
Use case: precise-object-edit. Change ONLY the background of this app icon to the user's specified color: hexadecimal #C0FFD2, exact sRGB RGB(192,255,210). Fill the entire background with this one uniform pale fresh green color, all the way to all four square canvas edges. No gradient, no texture, no noise, no shading, no gray cast. Preserve the two warm ivory diagonal scoring sticks completely, including their positions, angle, proportions, parallel spacing, stagger, rounded ends, the one red pip and the exactly eight dark green pips. Do not change stick colors. Flat crisp 2D icon. No text, outlines, shadows, extra elements or composition changes. The only intended difference from the supplied image is the background color #C0FFD2.
```

界面图标来自 package.json 中锁定的 lucide-react 包；七段数字由 src/main.jsx 中的 SVG 按实时点数绘制。
