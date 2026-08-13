# 桌面模式壁纸功能更新

## 更新时间
2026-07-12

## 新增功能

### 1. 自动切换功能
为整体循环和随机循环模式添加了三种切换时机：

#### 切换时机选项：
- **手动切换**: 用户手动点击切换，不自动切换
- **定时切换**: 按设定的时间间隔自动切换壁纸
- **启动时切换**: 仅在启动应用时切换一次

#### 定时切换间隔：
- 10分钟
- 30分钟
- 60分钟
- 自定义时长（用户可输入任意分钟数）

### 2. 壁纸切换动画
添加了流畅的壁纸切换动画效果：
- 淡入淡出过渡（0.6秒）
- 轻微的缩放效果（从1.05到1.0）
- 使用 Framer Motion 的 AnimatePresence 实现平滑过渡

### 3. 重置默认按钮
在设置界面底部添加了"重置为默认壁纸"按钮：
- 一键清空所有上传的壁纸
- 重置所有壁纸设置为默认值
- 恢复默认的液态玻璃动态背景

### 4. 液态玻璃风格默认背景
创建了全新的动态背景作为默认壁纸：
- 使用 Canvas 绘制的液态玻璃效果
- 5个不同颜色的渐变球体
- 球体随机移动并在边界反弹
- 模糊和混合模式营造玻璃质感
- 性能优化，使用 requestAnimationFrame

#### 背景特点：
- 深紫色到蓝色的渐变基底
- 动态移动的半透明彩色球体
- 高斯模糊效果
- 玻璃质感叠加层

### 5. 修复随机图片API
将不可用的 Unsplash API 替换为可用的 API：
- **修复前**: 使用 `source.unsplash.com`（已失效）
- **修复后**: 统一使用 `www.dmoe.cc/random.php`（测试可用）

#### API 来源更新：
- Bing 每日壁纸: 保持原有 Bing API
- 自然风景: `www.dmoe.cc/random.php`
- 动漫二次元: `www.dmoe.cc/random.php`
- 城市建筑: `www.dmoe.cc/random.php`
- 游戏随机图片: `www.dmoe.cc/random.php`
- 自定义 API: 支持用户输入自定义链接

## 技术实现

### 修改的文件：

#### 1. `src/services/desktopWallpaperManager.ts`
- 更新 `DesktopWallpaperSwitchMode` 类型：`'manual' | 'interval' | 'on-startup'`
- 修改 `RANDOM_IMAGE_APIS` 配置，使用可用的 API
- 优化 `startAutoSwitch()` 方法，支持定时和启动时切换
- 添加 `resetToDefault()` 方法

#### 2. `src/components/DesktopSettingsModal.tsx`
- 添加切换时机选择 UI（手动/定时/启动时）
- 添加定时切换间隔选择（10/30/60分钟 + 自定义）
- 添加自定义间隔输入框
- 添加"重置为默认壁纸"按钮
- 状态管理：`switchMode`, `intervalMinutes`, `customInterval`, `showCustomInterval`

#### 3. `src/components/DesktopView.tsx`
- 添加 `wallpaperKey` 状态用于触发切换动画
- 使用 `AnimatePresence` 实现壁纸切换动画
- 集成 `LiquidGlassBackground` 组件作为默认背景
- 在壁纸加载时更新 key 以触发动画

#### 4. `src/components/LiquidGlassBackground.tsx` (新建)
- Canvas 绘制的液态玻璃效果
- 5个彩色渐变球体
- 物理运动模拟（边界反弹）
- 径向渐变和模糊效果
- 响应式尺寸调整

## 使用说明

### 设置自动切换：
1. 打开桌面模式设置
2. 进入"自定义壁纸"
3. 上传壁纸并选择"顺序循环"或"随机循环"
4. 在"切换时机"中选择切换模式
5. 如果选择"定时切换"，设置切换间隔

### 重置为默认：
1. 打开桌面模式设置
2. 进入"自定义壁纸"
3. 点击底部的"重置为默认壁纸"按钮
4. 所有设置将恢复为默认值，显示液态玻璃背景

### 使用自定义API：
1. 在随机图片模式下选择"自定义 API"
2. 输入返回随机图片的 API 地址（如 `https://www.dmoe.cc/random.php`）
3. 点击"保存并应用"

## 性能优化

- 使用 `requestAnimationFrame` 实现流畅动画
- Canvas 动画在组件卸载时自动清理
- 定时器在组件卸载时自动停止
- 壁纸切换使用防抖机制

## 兼容性

- 支持现代浏览器（Chrome, Firefox, Edge, Safari）
- 需要支持 Canvas API
- 需要支持 Framer Motion
- 移动端自适应

## 后续优化建议

1. 添加更多动态背景主题选择
2. 支持视频壁纸的自动播放
3. 添加壁纸收藏功能
4. 支持从云端同步壁纸
5. 添加壁纸预览功能
6. 优化大尺寸壁纸的加载性能
