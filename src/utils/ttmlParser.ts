/**
 * TTML (Timed Text Markup Language) 解析器
 * 用于解析 AMLL TTML DB 的逐字歌词格式
 */

export interface TTMLWord {
  text: string
  startTime: number
  endTime: number
}

export interface TTMLLine {
  words: TTMLWord[]
  startTime: number
  endTime: number
  translation?: string
  roman?: string
}

export interface TTMLLyric {
  lines: TTMLLine[]
}

/**
 * 解析时间字符串（格式：HH:MM:SS.mmm 或 MM:SS.mmm）
 */
function parseTime(timeStr: string): number {
  const normalized = timeStr.trim()
  if (normalized.endsWith('ms')) return Number.parseFloat(normalized) || 0
  if (normalized.endsWith('s')) return (Number.parseFloat(normalized) || 0) * 1000

  const parts = normalized.split(':')
  let seconds = 0
  
  if (parts.length === 3) {
    // HH:MM:SS.mmm
    seconds = parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2])
  } else if (parts.length === 2) {
    // MM:SS.mmm
    seconds = parseInt(parts[0]) * 60 + parseFloat(parts[1])
  } else {
    seconds = parseFloat(timeStr)
  }
  
  return seconds * 1000 // 转换为毫秒
}

/**
 * 解析TTML XML文本
 */
export function parseTTML(ttmlText: string): TTMLLyric {
  const parser = new DOMParser()
  const xmlDoc = parser.parseFromString(ttmlText, 'text/xml')
  if (xmlDoc.getElementsByTagName('parsererror').length > 0) {
    throw new Error('AMLL TTML XML 解析失败')
  }

  const lines: TTMLLine[] = []

  // 获取所有 <p> 元素（每个代表一行歌词）
  const paragraphs = Array.from(xmlDoc.getElementsByTagNameNS('*', 'p'))

  paragraphs.forEach(p => {
    const begin = p.getAttribute('begin')
    const end = p.getAttribute('end')
    
    if (!begin || !end) return
    
    const lineStartTime = parseTime(begin)
    const lineEndTime = parseTime(end)
    
    const words: TTMLWord[] = []
    let translation = ''
    let roman = ''
    let primaryText = ''
    
    // 只解析当前行的直接子节点。背景人声 span 内还会嵌套 span，若递归
    // querySelectorAll 会把主歌词、背景歌词和辅助文本重复拼接。
    Array.from(p.childNodes).forEach(node => {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent || ''
        primaryText += text
        if (text && words.length > 0) {
          const previousEnd = words[words.length - 1].endTime
          words.push({ text, startTime: previousEnd, endTime: previousEnd })
        }
        return
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return

      const span = node as Element
      if (span.localName !== 'span') return
      const role = span.getAttributeNS('http://www.w3.org/ns/ttml#metadata', 'role')
        || span.getAttribute('ttm:role')

      if (role === 'x-translation') {
        // 翻译文本
        translation = span.textContent || ''
      } else if (role === 'x-roman') {
        // 罗马音
        roman = span.textContent || ''
      } else if (role !== 'x-bg') {
        // 普通歌词词语
        const wordBegin = span.getAttribute('begin')
        const wordEnd = span.getAttribute('end')
        const text = span.textContent || ''
        primaryText += text
        
        if (wordBegin && wordEnd && text) {
          words.push({
            text,
            startTime: parseTime(wordBegin),
            endTime: parseTime(wordEnd)
          })
        } else if (text && words.length > 0) {
          words[words.length - 1].text += text
        }
      }
    })
    
    // 如果没有逐字时间轴，尝试获取整行文本
    if (words.length === 0) {
      if (primaryText.trim()) {
        words.push({
          text: primaryText.trim(),
          startTime: lineStartTime,
          endTime: lineEndTime
        })
      }
    }
    
    if (words.length > 0) {
      lines.push({
        words,
        startTime: lineStartTime,
        endTime: lineEndTime,
        translation: translation || undefined,
        roman: roman || undefined
      })
    }
  })
  
  return { lines }
}

/**
 * 将TTML格式转换为LRC格式
 */
export function ttmlToLRC(ttml: TTMLLyric): string {
  const lrcLines: string[] = []
  
  ttml.lines.forEach(line => {
    const minutes = Math.floor(line.startTime / 60000)
    const seconds = Math.floor((line.startTime % 60000) / 1000)
    const milliseconds = Math.floor((line.startTime % 1000) / 10)
    
    const timestamp = `[${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(milliseconds).padStart(2, '0')}]`
    const text = line.words.map(w => w.text).join('')
    
    lrcLines.push(`${timestamp}${text}`)
  })
  
  return lrcLines.join('\n')
}

/**
 * 将TTML格式转换为翻译LRC格式
 */
export function ttmlToTranslationLRC(ttml: TTMLLyric): string {
  const lrcLines: string[] = []
  
  ttml.lines.forEach(line => {
    if (!line.translation) return
    
    const minutes = Math.floor(line.startTime / 60000)
    const seconds = Math.floor((line.startTime % 60000) / 1000)
    const milliseconds = Math.floor((line.startTime % 1000) / 10)
    
    const timestamp = `[${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(milliseconds).padStart(2, '0')}]`
    
    lrcLines.push(`${timestamp}${line.translation}`)
  })
  
  return lrcLines.join('\n')
}

/**
 * 将TTML格式转换为YRC逐字格式（类似网易云YRC）
 */
export function ttmlToYRC(ttml: TTMLLyric): string {
  const yrcLines: string[] = []
  
  ttml.lines.forEach(line => {
    const minutes = Math.floor(line.startTime / 60000)
    const seconds = Math.floor((line.startTime % 60000) / 1000)
    const milliseconds = Math.floor(line.startTime % 1000)
    
    const timestamp = `[${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(milliseconds).padStart(3, '0')}]`
    
    // 构建逐字时间轴
    const wordTimings = line.words.map(word => {
      const duration = word.endTime - word.startTime
      return `(${word.startTime},${duration})${word.text}`
    }).join('')
    
    yrcLines.push(`${timestamp}${wordTimings}`)
  })
  
  return yrcLines.join('\n')
}
