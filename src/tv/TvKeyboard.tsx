/**
 * TV 软键盘：Android TV 一般没有系统输入法，文本输入（搜索、QQ cookie 粘贴等）
 * 需要遥控器可操作的屏幕键盘。
 *
 * 机制：
 *  - tv-mode 下任意 input/textarea/contenteditable 获得焦点时自动弹出；
 *  - 键盘是一个 data-tv-scope 聚焦域，D-pad 由 tvCore 的空间导航在网格内移动；
 *  - 按 OK 输出字符到目标输入框（通过原生 value setter + input 事件，React 能感知）；
 *  - BACK / 完成键关闭键盘并把焦点交还页面。
 */
import { useEffect, useRef, useState } from 'react'
import { useTvMode, useRemoteCursorMode, setKeyboardActive, useTvBack, startTv } from './tvCore'
import { requestRemoteTextInput } from './remoteBridge'

// 标准 QWERTY 布局（按真实键盘行排列），数字/符号页同理
const KEY_ROWS: Record<Page, string[]> = {
  lower: ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'],
  upper: ['QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM'],
  symbols: ['1234567890', '-=[]\\;\',./', '!@#$%^&*()_+', '{}|:"<>?`~'],
}
const SPACE = ' '

function isEditable(el: Element | null): boolean {
  if (!el) return false
  const t = el.tagName
  return t === 'INPUT' || t === 'TEXTAREA' || (el as HTMLElement).isContentEditable
}

type Page = 'lower' | 'upper' | 'symbols'

export default function TvKeyboard() {
  const tvMode = useTvMode()
  const remoteCursorMode = useRemoteCursorMode()
  const [target, setTarget] = useState<HTMLInputElement | HTMLTextAreaElement | null>(null)
  const [page, setPage] = useState<Page>('lower')
  const targetRef = useRef<typeof target>(null)
  const keyboardRef = useRef<HTMLDivElement>(null)
  const remoteCursorModeRef = useRef(remoteCursorMode)
  remoteCursorModeRef.current = remoteCursorMode
  targetRef.current = target

  useEffect(() => {
    if (!tvMode) return
    // React 首帧渲染完成后，让 tvCore 重新收拢焦点到可见候选。
    startTv()
    const onFocusIn = () => {
      const ae = document.activeElement
      if (isEditable(ae)) {
        if (remoteCursorModeRef.current) {
          // 远程遥控器连接中：不弹 TV 软键盘，改用手机端输入框（用户自己的键盘）
          setKeyboardActive(false)
          requestRemoteTextInput()
          return
        }
        setTarget(ae as HTMLInputElement | HTMLTextAreaElement)
        setPage('lower')
        setKeyboardActive(true)
      } else if (ae && !keyboardRef.current?.contains(ae)) {
        // 焦点离开可编辑区域（键盘内部元素除外）→ 关闭
        setTarget(null)
        setKeyboardActive(false)
      }
    }
    document.addEventListener('focusin', onFocusIn)
    return () => {
      document.removeEventListener('focusin', onFocusIn)
      setKeyboardActive(false)
    }
  }, [tvMode])

  // BACK：优先关闭软键盘
  useTvBack(() => {
    if (targetRef.current) {
      close()
      return true
    }
    return false
  })

  const close = () => {
    setTarget(null)
    setKeyboardActive(false)
    try {
      targetRef.current?.blur()
    } catch {
      // ignore
    }
  }

  if (!tvMode || !target) return null

  const insert = (text: string) => {
    const t = target
    if (!t) return
    const proto =
      t instanceof HTMLTextAreaElement
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    if (!setter) return
    const start = t.selectionStart ?? t.value.length
    const end = t.selectionEnd ?? t.value.length
    const next = t.value.slice(0, start) + text + t.value.slice(end)
    setter.call(t, next)
    t.dispatchEvent(new Event('input', { bubbles: true }))
    try {
      t.setSelectionRange(start + text.length, start + text.length)
    } catch {
      // ignore
    }
  }

  const deleteChar = () => {
    const t = target
    if (!t) return
    const proto =
      t instanceof HTMLTextAreaElement
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    if (!setter) return
    const start = t.selectionStart ?? t.value.length
    const end = t.selectionEnd ?? t.value.length
    if (start === end && start > 0) {
      const next = t.value.slice(0, start - 1) + t.value.slice(end)
      setter.call(t, next)
      t.dispatchEvent(new Event('input', { bubbles: true }))
      try {
        t.setSelectionRange(start - 1, start - 1)
      } catch {
        // ignore
      }
    } else if (start !== end) {
      const next = t.value.slice(0, start) + t.value.slice(end)
      setter.call(t, next)
      t.dispatchEvent(new Event('input', { bubbles: true }))
      try {
        t.setSelectionRange(start, start)
      } catch {
        // ignore
      }
    }
  }

  // 遥控器删除键（KEYCODE_DEL=67 / Backspace=8）→ 删除字符；Esc=27 → 关闭键盘
  const deleteCharRef = useRef(deleteChar)
  deleteCharRef.current = deleteChar
  const closeRef = useRef(close)
  closeRef.current = close
  useEffect(() => {
    if (!tvMode || !target) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.keyCode === 8 || e.keyCode === 67) {
        e.preventDefault()
        e.stopPropagation()
        deleteCharRef.current()
      } else if (e.keyCode === 27) {
        closeRef.current()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [tvMode, target])

  const Key = ({ label, onClick, wide = false }: { label: string; onClick: () => void; wide?: boolean }) => (
    <button
      data-tv-focus
      tabIndex={-1}
      onClick={onClick}
      className={`tv-key ${wide ? 'tv-key-wide' : ''}`}
      style={{
        minWidth: wide ? 110 : 62,
        height: 58,
        margin: 4,
        borderRadius: 10,
        border: '1px solid rgba(255,255,255,0.22)',
        background: 'rgba(255,255,255,0.12)',
        color: '#fff',
        fontSize: 20,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {label}
    </button>
  )

  return (
    <div
      ref={keyboardRef}
      data-tv-scope
      className="tv-keyboard"
      style={{
        position: 'fixed',
        left: '50%',
        transform: 'translateX(-50%)',
        bottom: 24,
        zIndex: 2147483001,
        maxWidth: 'min(96vw, 1200px)',
        background: 'rgba(12,16,24,0.94)',
        border: '1px solid rgba(255,255,255,0.16)',
        borderRadius: 18,
        padding: '12px 16px 14px',
        boxShadow: '0 18px 60px rgba(0,0,0,0.6)',
        textAlign: 'center',
      }}
    >
      {/* 键盘头部：说明 + 关闭按钮 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 6,
        }}
      >
        <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: 12 }}>遥控器键盘</span>
        <button
          data-tv-focus
          tabIndex={-1}
          onClick={close}
          style={{
            background: 'rgba(255,255,255,0.12)',
            color: '#fff',
            border: '1px solid rgba(255,255,255,0.25)',
            borderRadius: 8,
            padding: '6px 14px',
            fontSize: 13,
          }}
        >
          ✕ 关闭
        </button>
      </div>

      {/* 当前输入预览 */}
      <div
        style={{
          color: 'rgba(255,255,255,0.85)',
          fontSize: 15,
          minHeight: 26,
          marginBottom: 8,
          padding: '4px 12px',
          background: 'rgba(0,0,0,0.4)',
          borderRadius: 8,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          textAlign: 'left',
        }}
      >
        {target.value || '\u00A0'}
      </div>

      {/* 字符网格（QWERTY 行排列） */}
      <div style={{ maxWidth: 1060, margin: '0 auto' }}>
        {KEY_ROWS[page].map((row, ri) => (
          <div key={ri} style={{ display: 'flex', justifyContent: 'center' }}>
            {row.split('').map((c) => (
              <Key key={c} label={c} onClick={() => insert(c)} />
            ))}
          </div>
        ))}

        {/* 控制行 */}
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: 6 }}>
          <Key
            label={page === 'lower' ? 'ABC' : page === 'upper' ? '123' : 'abc'}
            onClick={() => setPage(page === 'lower' ? 'upper' : page === 'upper' ? 'symbols' : 'lower')}
          />
          <Key label="空格" wide onClick={() => insert(SPACE)} />
          <Key label="⌫ 删除" wide onClick={deleteChar} />
          <Key label="完成" wide onClick={close} />
        </div>
      </div>
    </div>
  )
}
