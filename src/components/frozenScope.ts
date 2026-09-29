/**
 * 冻结作用域：由「保持挂载但当前不可见」的容器提供（探索页各平台面板、被播放页覆盖的整页）。
 *
 * 背景：探索页为了保住滚动位置与已加载内容，平台面板只切 `hidden` 不卸载；
 * 面板里的封面 `<img>` 会一直持有已解码位图。实测「多点几个平台」后
 * 三个隐藏面板里躺着 569 张已解码封面，整个渲染进程涨到 3.8GB，
 * 机器进入内存压力后全局卡顿。
 *
 * 语义：true = 该子树当前不可见，消费方应释放大块媒体资源（已解码位图、HLS 管线），
 * 但**保留 DOM 与布局**。解冻时按原 src 重新取——封面源是缓存键/内存缓存里的
 * blob URL，不产生新的网络请求。
 *
 * 只允许包裹「确实不可见」的子树：面板 display:none、整页 visibility:hidden。
 */
import { createContext } from 'react'

export const FrozenScope = createContext(false)
