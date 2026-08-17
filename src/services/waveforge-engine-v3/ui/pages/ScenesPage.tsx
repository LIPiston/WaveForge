/**
 * 音效场景页 —— 场景预设 + 效果卡片
 */

import { useState } from 'react'
import { Sparkles, Save, RotateCcw, Trash2, Volume2, Gauge } from 'lucide-react'
import { GlassCard, Toggle, RangeStyle } from '../components/Primitives'
import type { HSETheme } from '../hse-theme'
import type { V3UiBridge } from '../bridge'
import type { V3ParamsController } from '../hooks'
import {
  EFFECT_META, effectEnabled, patchEffectEnabled,
} from '../effectsPanel'
import type { EffectUiKey } from '../effectsPanel'
import { createDefaultParams } from '../../src/types'

interface ScenesPageProps {
  bridge: V3UiBridge
  controller: V3ParamsController
  theme: HSETheme
  onOpenEffect: (key: string) => void
}

const GRID_KEYS: EffectUiKey[] = ['reverb', 'surround3d', 'bassEnhancer', 'compressor', 'nightMode', 'deesser', 'ieq', 'limiter', 'pitch', 'stereoWidth']
const ROW_KEYS: EffectUiKey[] = ['loudnessCompensation', 'loudnessNormalization']

export default function ScenesPage({ bridge, controller, theme, onOpenEffect }: ScenesPageProps) {
  const { params, patch, replace } = controller
  const [sceneName, setSceneName] = useState('')
  const [scenes, setScenes] = useState(() => bridge.getScenes())

  const refreshScenes = () => setScenes(bridge.getScenes())

  const handleApplyScene = (id: string) => {
    bridge.applyScene(id)
    replace(bridge.getParams())
    refreshScenes()
  }

  const handleSaveScene = () => {
    const name = sceneName.trim() || `我的场景 ${bridge.getScenes().filter((s) => !s.builtin).length + 1}`
    if (bridge.saveMyScene(name)) {
      refreshScenes()
      setSceneName('')
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: `已保存场景「${name}」`, type: 'info' } }))
    } else {
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '我的场景已达上限（8 个）', type: 'error' } }))
    }
  }

  const handleDeleteScene = (id: string) => {
    bridge.deleteMyScene(id)
    refreshScenes()
  }

  const handleResetAll = () => {
    replace(createDefaultParams(bridge.getSampleRate()))
    window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '已恢复默认（原声监听）', type: 'info' } }))
  }

  const activeSceneName = params.customized ? '自定义' : (params.sceneId ? scenes.find((s) => s.id === params.sceneId)?.name ?? '无' : '无')

  const renderEffectCard = (key: EffectUiKey) => {
    const meta = EFFECT_META[key]
    const enabled = effectEnabled(params, key)
    const Icon = meta.icon
    return (
      <div
        key={key}
        role="button"
        tabIndex={0}
        onClick={() => onOpenEffect(key)}
        onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) onOpenEffect(key) }}
        className="relative cursor-pointer rounded-xl p-3 flex flex-col items-center gap-2 transition-all hover:brightness-110"
        style={{
          background: enabled ? `${theme.accentDim}` : theme.cardBg,
          border: `1px solid ${enabled ? theme.accentColor : theme.cardBorder}`,
          boxShadow: enabled ? `0 0 14px ${theme.accentGlow}` : theme.cardGlow,
        }}
      >
        <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: `${theme.accentColor}22` }}>
          <Icon className="w-4.5 h-4.5" style={{ color: theme.accentColor }} />
        </div>
        <div className={`text-xs font-medium ${theme.textPrimary} text-center leading-tight`}>{meta.name}</div>
        <div className={`${theme.textTertiary} text-[10px] text-center leading-tight -mt-1`}>{meta.desc}</div>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); patchEffectEnabled(patch, params, key, !enabled) }}
          className="w-full py-1.5 rounded-lg text-[11px] font-medium transition-colors"
          style={enabled
            ? { backgroundColor: theme.accentColor, color: '#fff' }
            : { backgroundColor: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.6)' }}
        >
          {enabled ? '已启用' : '使用'}
        </button>
      </div>
    )
  }

  const renderRowCard = (key: EffectUiKey) => {
    const meta = EFFECT_META[key]
    const enabled = effectEnabled(params, key)
    const Icon = meta.icon
    return (
      <GlassCard key={key} theme={theme}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Icon className="w-4 h-4" style={{ color: theme.accentColor }} />
            <div>
              <div className={`${theme.textPrimary} text-sm font-medium`}>{meta.name}</div>
              <div className={`${theme.textTertiary} text-[10px]`}>{meta.desc}</div>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0 ml-3">
            <Toggle checked={enabled} onChange={(v) => patchEffectEnabled(patch, params, key, v)} theme={theme} />
            <button
              type="button"
              onClick={() => onOpenEffect(key)}
              className="px-2.5 py-1 rounded-lg text-[11px] text-white/70 transition-all hover:brightness-110"
              style={{ background: 'rgba(255,255,255,0.06)', border: `1px solid ${theme.cardBorder}` }}
            >
              配置
            </button>
          </div>
        </div>
      </GlassCard>
    )
  }

  return (
    <div className="space-y-4">
      <RangeStyle theme={theme} />

      {/* 场景方案 */}
      <GlassCard theme={theme}>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4" style={{ color: theme.accentColor }} />
            <span className={`${theme.textPrimary} text-sm font-medium`}>场景方案</span>
          </div>
          <span className="text-xs" style={{ color: theme.accentColor }}>当前：{activeSceneName}{params.customized ? '（已调整）' : ''}</span>
        </div>

        <div className="flex items-center gap-2 mb-3">
          <input
            value={sceneName}
            onChange={(e) => setSceneName(e.target.value)}
            placeholder="场景名称"
            className="px-3 py-1.5 rounded-lg text-xs outline-none text-white bg-white/5 border border-white/10 w-32"
          />
          <button
            type="button"
            onClick={handleResetAll}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs text-white/60 bg-white/5 border border-white/10 hover:bg-white/10 transition-colors"
          >
            <RotateCcw className="w-3 h-3" /> 恢复默认
          </button>
          <button
            type="button"
            onClick={handleSaveScene}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs text-white transition-all hover:brightness-110"
            style={{ backgroundColor: theme.accentColor }}
          >
            <Save className="w-3 h-3" /> 保存为场景
          </button>
        </div>

        <div className="flex gap-2 overflow-x-auto pb-1" style={{ scrollbarWidth: 'thin' }}>
          {scenes.map((scene) => {
            const active = !params.customized && params.sceneId === scene.id
            return (
              <button
                key={scene.id}
                type="button"
                onClick={() => handleApplyScene(scene.id)}
                className="relative rounded-xl px-3 py-2 text-left shrink-0 transition-all hover:brightness-110"
                style={{
                  background: active ? `${theme.accentDim}` : 'rgba(255,255,255,0.04)',
                  border: `1px solid ${active ? theme.accentColor : 'rgba(255,255,255,0.08)'}`,
                  minWidth: 100,
                }}
              >
                <div className={`text-xs font-medium ${active ? '' : theme.textPrimary}`} style={active ? { color: theme.accentColor } : undefined}>
                  {!scene.builtin && '★ '}{scene.name}
                </div>
                {scene.description && (
                  <div className={`text-[10px] mt-0.5 leading-snug line-clamp-2 ${theme.textTertiary}`}>{scene.description}</div>
                )}
                {!scene.builtin && (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); handleDeleteScene(scene.id) }}
                    className="absolute -top-1.5 -right-1.5 p-1 rounded-full bg-black/70 shadow-md"
                  >
                    <Trash2 className="w-3 h-3 text-white/50" />
                  </button>
                )}
              </button>
            )
          })}
        </div>
      </GlassCard>

      {/* 效果卡片 */}
      <GlassCard theme={theme}>
        <div className={`${theme.textPrimary} text-sm font-medium mb-3`}>音效（可叠加，点卡片配置）</div>
        <div className="grid grid-cols-5 gap-2.5">
          {GRID_KEYS.map(renderEffectCard)}
        </div>
      </GlassCard>

      {/* 响度相关 */}
      <div className={`${theme.textPrimary} text-sm font-medium flex items-center gap-2 mb-2`}>
        <Volume2 className="w-4 h-4" style={{ color: theme.accentColor }} /> 响度相关
      </div>
      {ROW_KEYS.map(renderRowCard)}
    </div>
  )
}
