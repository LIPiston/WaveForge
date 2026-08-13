import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import {
  AlertTriangle,
  Cloud,
  CloudMoon,
  CloudSun,
  CloudFog,
  CloudLightning,
  CloudRain,
  Clock3,
  Droplets,
  Eye,
  Gauge,
  MoonStar,
  Navigation,
  Snowflake,
  Sun,
  Sunrise,
  Sunset,
  ThermometerSun,
  Umbrella,
  Wind,
  X,
  RefreshCw,
} from 'lucide-react'
import { getWeatherLabel, getWeatherLocationAddress, getWeatherLocationName, WeatherSnapshot } from '../services/weatherService'
import type { HazardSnapshot } from '../services/hazardService'
import WeatherHazardsPanel, { type WeatherHazardTab } from './WeatherHazardsPanel'
import WeatherMapExperience from './WeatherMapExperience'

interface WeatherDetailsModalProps {
  open: boolean
  weather: WeatherSnapshot | null
  onClose: () => void
  onRefresh: () => void
  loading: boolean
  hazards: HazardSnapshot | null
  hazardLoading: boolean
  hazardError?: string
  initialTab?: WeatherDetailsTab
  onHazardRefresh: () => void
}

export type WeatherDetailsTab = 'weather' | WeatherHazardTab

export function WeatherGlyph({ code, isDay = true, className = 'h-8 w-8' }: { code: number; isDay?: boolean; className?: string }) {
  if (code === 0) return isDay ? <Sun className={className} /> : <MoonStar className={className} />
  if (code <= 2) return isDay ? <CloudSun className={className} /> : <CloudMoon className={className} />
  if (code === 3) return <Cloud className={className} />
  if (code === 45 || code === 48) return <CloudFog className={className} />
  if (code >= 95) return <CloudLightning className={className} />
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return <Snowflake className={className} />
  return <CloudRain className={className} />
}

export type WeatherSceneKind = 'clear' | 'partly-cloudy' | 'cloudy' | 'fog' | 'drizzle' | 'rain' | 'heavy-rain' | 'thunder' | 'snow'

export interface WeatherVisualTheme {
  kind: WeatherSceneKind
  isDay: boolean
  background: string
  cardBackground: string
  accent: string
  cloudOpacity: number
}

export function getWeatherVisualTheme(code: number, isDay: boolean): WeatherVisualTheme {
  let kind: WeatherSceneKind = 'clear'
  if (code >= 95) kind = 'thunder'
  else if (code === 65 || code === 67 || code === 82) kind = 'heavy-rain'
  else if (code === 53 || code === 55 || code === 63 || code === 66 || code === 81) kind = 'rain'
  else if (code === 51 || code === 56 || code === 57 || code === 61 || code === 80) kind = 'drizzle'
  else if ((code >= 71 && code <= 77) || code === 85 || code === 86) kind = 'snow'
  else if (code === 45 || code === 48) kind = 'fog'
  else if (code === 3) kind = 'cloudy'
  else if (code === 1 || code === 2) kind = 'partly-cloudy'

  const dayThemes: Record<WeatherSceneKind, Omit<WeatherVisualTheme, 'kind' | 'isDay'>> = {
    clear: { background: 'linear-gradient(180deg, #177bd5 0%, #50afe9 48%, #b8e1f8 100%)', cardBackground: 'linear-gradient(145deg, rgba(38,150,229,0.82), rgba(118,190,229,0.56))', accent: '#fde68a', cloudOpacity: 0.08 },
    'partly-cloudy': { background: 'linear-gradient(180deg, #388ac7 0%, #75add0 48%, #c6d7df 100%)', cardBackground: 'linear-gradient(145deg, rgba(74,139,185,0.82), rgba(148,169,181,0.58))', accent: '#fef3c7', cloudOpacity: 0.48 },
    cloudy: { background: 'linear-gradient(180deg, #557287 0%, #8399a7 54%, #bcc5ca 100%)', cardBackground: 'linear-gradient(145deg, rgba(71,96,116,0.86), rgba(132,145,153,0.62))', accent: '#e2e8f0', cloudOpacity: 0.72 },
    fog: { background: 'linear-gradient(180deg, #667887 0%, #9aa8b0 48%, #d6d9d8 100%)', cardBackground: 'linear-gradient(145deg, rgba(92,111,124,0.82), rgba(171,177,178,0.58))', accent: '#f1f5f9', cloudOpacity: 0.6 },
    drizzle: { background: 'linear-gradient(180deg, #315f7c 0%, #5c8195 52%, #9eb2bb 100%)', cardBackground: 'linear-gradient(145deg, rgba(39,91,122,0.88), rgba(95,126,140,0.66))', accent: '#a5f3fc', cloudOpacity: 0.72 },
    rain: { background: 'linear-gradient(180deg, #173e61 0%, #365b75 52%, #768f9c 100%)', cardBackground: 'linear-gradient(145deg, rgba(24,64,94,0.92), rgba(65,93,107,0.72))', accent: '#7dd3fc', cloudOpacity: 0.82 },
    'heavy-rain': { background: 'linear-gradient(180deg, #112c45 0%, #243f55 48%, #506573 100%)', cardBackground: 'linear-gradient(145deg, rgba(14,43,67,0.94), rgba(47,68,81,0.78))', accent: '#38bdf8', cloudOpacity: 0.92 },
    thunder: { background: 'linear-gradient(180deg, #15152d 0%, #30324c 48%, #50596a 100%)', cardBackground: 'linear-gradient(145deg, rgba(25,24,53,0.96), rgba(62,62,82,0.78))', accent: '#c4b5fd', cloudOpacity: 0.95 },
    snow: { background: 'linear-gradient(180deg, #668da6 0%, #9eb8c7 48%, #e2edf1 100%)', cardBackground: 'linear-gradient(145deg, rgba(89,126,148,0.84), rgba(189,208,216,0.62))', accent: '#ffffff', cloudOpacity: 0.7 },
  }
  const nightThemes: Record<WeatherSceneKind, Omit<WeatherVisualTheme, 'kind' | 'isDay'>> = {
    clear: { background: 'linear-gradient(180deg, #061329 0%, #102c55 52%, #29456f 100%)', cardBackground: 'linear-gradient(145deg, rgba(10,34,70,0.92), rgba(42,66,102,0.68))', accent: '#e0e7ff', cloudOpacity: 0.06 },
    'partly-cloudy': { background: 'linear-gradient(180deg, #0a1932 0%, #273b59 52%, #546779 100%)', cardBackground: 'linear-gradient(145deg, rgba(16,39,70,0.92), rgba(70,83,105,0.68))', accent: '#e2e8f0', cloudOpacity: 0.48 },
    cloudy: { background: 'linear-gradient(180deg, #111a2a 0%, #303b4d 54%, #596371 100%)', cardBackground: 'linear-gradient(145deg, rgba(22,31,48,0.94), rgba(72,80,94,0.72))', accent: '#cbd5e1', cloudOpacity: 0.76 },
    fog: { background: 'linear-gradient(180deg, #1c2735 0%, #4b5965 50%, #77828a 100%)', cardBackground: 'linear-gradient(145deg, rgba(29,41,55,0.92), rgba(93,105,115,0.7))', accent: '#e2e8f0', cloudOpacity: 0.68 },
    drizzle: { background: 'linear-gradient(180deg, #081c32 0%, #203b50 52%, #4d6471 100%)', cardBackground: 'linear-gradient(145deg, rgba(9,30,52,0.96), rgba(47,69,82,0.76))', accent: '#7dd3fc', cloudOpacity: 0.8 },
    rain: { background: 'linear-gradient(180deg, #071629 0%, #173047 52%, #3f5362 100%)', cardBackground: 'linear-gradient(145deg, rgba(6,23,43,0.97), rgba(36,57,72,0.8))', accent: '#38bdf8', cloudOpacity: 0.9 },
    'heavy-rain': { background: 'linear-gradient(180deg, #050f1e 0%, #102536 52%, #32434f 100%)', cardBackground: 'linear-gradient(145deg, rgba(4,16,31,0.98), rgba(28,47,60,0.84))', accent: '#0ea5e9', cloudOpacity: 0.96 },
    thunder: { background: 'linear-gradient(180deg, #080817 0%, #1d1831 48%, #39384b 100%)', cardBackground: 'linear-gradient(145deg, rgba(10,8,27,0.98), rgba(48,40,69,0.84))', accent: '#a78bfa', cloudOpacity: 0.98 },
    snow: { background: 'linear-gradient(180deg, #17263c 0%, #3d536c 50%, #71879b 100%)', cardBackground: 'linear-gradient(145deg, rgba(24,41,64,0.94), rgba(78,99,119,0.72))', accent: '#f8fafc', cloudOpacity: 0.76 },
  }
  return { kind, isDay, ...(isDay ? dayThemes[kind] : nightThemes[kind]) }
}

export function WeatherAtmosphere({ theme, compact = false }: { theme: WeatherVisualTheme; compact?: boolean }) {
  const rainCount = compact ? 12 : theme.kind === 'heavy-rain' || theme.kind === 'thunder' ? 52 : 32
  const showsRain = ['drizzle', 'rain', 'heavy-rain', 'thunder'].includes(theme.kind)
  const showsClouds = theme.cloudOpacity > 0.2
  const showsSnow = theme.kind === 'snow'

  return (
    <div aria-hidden="true" className={`pointer-events-none absolute inset-0 overflow-hidden weather-atmosphere weather-atmosphere-${theme.kind}`} style={{ background: compact ? theme.cardBackground : theme.background }}>
      {!theme.isDay && (
        <>
          {!compact && <div className="absolute -left-[12%] top-[8%] h-[44%] w-[118%] -rotate-[11deg] bg-[radial-gradient(ellipse,rgba(184,204,255,0.12),rgba(115,139,191,0.04)_42%,transparent_72%)] blur-3xl" />}
          {Array.from({ length: compact ? 18 : 78 }, (_, index) => {
            const size = index % 13 === 0 ? 3.4 : index % 5 === 0 ? 2.2 : 1 + (index % 3) * 0.45
            const starColor = index % 9 === 0 ? '#fff1c7' : index % 7 === 0 ? '#c7ddff' : '#ffffff'
            return (
              <i
                key={`star-${index}`}
                className="absolute rounded-full weather-star"
                style={{
                  left: `${1 + ((index * 37 + index * index * 3) % 98)}%`,
                  top: `${2 + ((index * 23 + index * index * 5) % 78)}%`,
                  width: `${compact ? Math.min(2.4, size) : size}px`,
                  height: `${compact ? Math.min(2.4, size) : size}px`,
                  backgroundColor: starColor,
                  boxShadow: index % 11 === 0 ? `0 0 ${compact ? 5 : 10}px ${starColor}` : `0 0 3px ${starColor}99`,
                  animationDelay: `${-(index % 17) * 0.27}s`,
                  animationDuration: `${2.4 + (index % 7) * 0.42}s`,
                }}
              />
            )
          })}
        </>
      )}

      {(theme.kind === 'clear' || theme.kind === 'partly-cloudy') && (
        <div
          className="absolute rounded-full weather-celestial"
          style={{
            right: compact ? '10%' : '8vw',
            top: compact ? '12%' : '6vh',
            width: compact ? '74px' : 'min(32vw, 420px)',
            height: compact ? '74px' : 'min(32vw, 420px)',
          }}
        >
          <div className={`absolute inset-0 rounded-full ${theme.isDay ? 'weather-sun-corona' : 'weather-moon-glow'}`} />
          <div
            className={`absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full ${theme.isDay ? 'weather-sun-disc' : 'weather-moon-disc'}`}
            style={{
              width: compact ? (theme.isDay ? '34px' : '39px') : (theme.isDay ? '38%' : '43%'),
              height: compact ? (theme.isDay ? '34px' : '39px') : (theme.isDay ? '38%' : '43%'),
            }}
          >
            <i className={`absolute inset-[7%] rounded-full ${theme.isDay ? 'weather-sun-surface' : 'weather-moon-surface'}`} />
          </div>
        </div>
      )}

      {showsClouds && Array.from({ length: compact ? 3 : 8 }, (_, index) => (
        <i
          key={`cloud-${index}`}
          className={`absolute weather-cloud weather-cloud-layer-${index % 3}`}
          style={{
            left: `${-18 + ((index * 29) % 112)}%`,
            top: `${4 + ((index * 17) % 54)}%`,
            width: compact ? `${110 + index * 20}px` : `${260 + (index % 3) * 130}px`,
            height: compact ? `${42 + index * 5}px` : `${84 + (index % 3) * 32}px`,
            opacity: theme.cloudOpacity * (0.45 + (index % 3) * 0.18),
            animationDelay: `${-index * 2.1}s`,
            animationDuration: `${18 + (index % 4) * 5}s`,
          }}
        />
      ))}

      {showsRain && Array.from({ length: rainCount }, (_, index) => (
        <i
          key={`rain-${index}`}
          className={`absolute weather-rain-drop ${index % 4 === 0 ? 'weather-rain-drop-near' : 'weather-rain-drop-far'}`}
          style={{
            left: `${(index * 47) % 101}%`,
            top: `${-18 - ((index * 13) % 70)}px`,
            height: theme.kind === 'drizzle' ? '14px' : theme.kind === 'heavy-rain' || theme.kind === 'thunder' ? '42px' : '26px',
            opacity: theme.kind === 'drizzle' ? 0.26 : 0.48 + (index % 4) * 0.1,
            animationDelay: `${-(index % 13) * 0.13}s`,
            animationDuration: `${theme.kind === 'heavy-rain' || theme.kind === 'thunder' ? 0.55 : 0.82 + (index % 5) * 0.08}s`,
          }}
        />
      ))}

      {showsRain && <div className="absolute inset-x-0 bottom-0 h-[34%] weather-rain-haze" />}
      {showsRain && !compact && Array.from({ length: 18 }, (_, index) => <i key={`splash-${index}`} className="absolute bottom-[2%] h-[5px] w-[18px] rounded-[50%] border border-cyan-100/35 weather-rain-splash" style={{ left: `${(index * 67) % 98}%`, animationDelay: `-${(index % 9) * .16}s` }} />)}

      {showsSnow && Array.from({ length: compact ? 14 : 42 }, (_, index) => (
        <i
          key={`snow-${index}`}
          className={`absolute rounded-full bg-white weather-snowflake weather-snowflake-${index % 3}`}
          style={{
            left: `${(index * 41) % 101}%`,
            top: `${-12 - ((index * 19) % 90)}px`,
            width: `${3 + (index % 4) * 2}px`,
            height: `${3 + (index % 4) * 2}px`,
            opacity: 0.42 + (index % 4) * 0.12,
            animationDelay: `${-(index % 11) * 0.4}s`,
            animationDuration: `${5 + (index % 5)}s`,
          }}
        />
      ))}

      {theme.kind === 'fog' && Array.from({ length: compact ? 3 : 7 }, (_, index) => (
        <i key={`fog-${index}`} className="absolute left-[-15%] w-[130%] rounded-full bg-white/16 blur-2xl weather-fog-band" style={{ top: `${16 + index * 12}%`, height: compact ? '22px' : '54px', animationDelay: `${-index * 1.6}s` }} />
      ))}

      {theme.kind === 'thunder' && <><div className="absolute -left-[12%] top-[-18%] h-[66%] w-[78%] rounded-full bg-violet-200/20 blur-3xl weather-storm-glow" /><div className="absolute inset-0 bg-violet-100 weather-lightning" /><div className="absolute left-[18%] top-[20%] h-[46%] w-[2px] origin-top rotate-[17deg] bg-gradient-to-b from-white via-violet-100 to-transparent opacity-0 weather-lightning-bolt" /></>}
      <div className="absolute inset-0 bg-gradient-to-b from-white/[0.025] via-transparent to-slate-950/28" />
    </div>
  )
}

const formatTime = (value: string) => value ? value.slice(11, 16) : '--:--'
const formatHour = (value: string, index: number) => index === 0 ? '现在' : `${value.slice(11, 13)}时`
const isHourDaylight = (time: string, weather: WeatherSnapshot) => {
  const date = time.slice(0, 10)
  const day = weather.daily.find(item => item.date === date)
  if (!day?.sunrise || !day?.sunset) return weather.current.isDay
  return time >= day.sunrise && time < day.sunset
}
const formatWeekday = (value: string, index: number) => {
  if (index === 0) return '今天'
  const date = new Date(`${value}T12:00:00`)
  return new Intl.DateTimeFormat('zh-CN', { weekday: 'short' }).format(date)
}

const getUvLabel = (value: number) => value < 3 ? '低' : value < 6 ? '中等' : value < 8 ? '较高' : value < 11 ? '很高' : '极高'
const getWindDirection = (degree: number) => {
  const directions = ['北', '东北', '东', '东南', '南', '西南', '西', '西北']
  return directions[Math.round(degree / 45) % 8]
}

export default function WeatherDetailsModal({ open, weather, onClose, onRefresh, loading, hazards, hazardLoading, hazardError = '', initialTab = 'weather', onHazardRefresh }: WeatherDetailsModalProps) {
  const [activeTab, setActiveTab] = useState<WeatherDetailsTab>(initialTab)
  const [weatherMapOpen, setWeatherMapOpen] = useState(false)

  useEffect(() => {
    if (open) setActiveTab(initialTab)
    else setWeatherMapOpen(false)
  }, [initialTab, open])

  useEffect(() => {
    if (!open) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (weatherMapOpen) setWeatherMapOpen(false)
        else onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose, weatherMapOpen])

  if (typeof document === 'undefined') return null
  const weatherTheme = getWeatherVisualTheme(weather?.current.weatherCode ?? 2, weather?.current.isDay ?? true)

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[400] overflow-hidden bg-slate-950 text-white"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <WeatherAtmosphere theme={weatherTheme} />
          <motion.div
            initial={{ y: 18, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 14, opacity: 0 }}
            transition={{ duration: 0.34, ease: [0.22, 1, 0.36, 1] }}
            className="absolute inset-0 overflow-y-auto custom-scrollbar"
          >
            <div className="relative mx-auto min-h-full w-full max-w-[1120px] px-7 py-8 md:px-12 md:py-10">
              <div className="flex items-start justify-between gap-6">
                <div>
                  <div className="text-sm font-medium tracking-[0.18em] text-white/60">
                    {weather?.location.source === 'ip' ? '我的位置 · 自动定位' : '自定义位置'}
                  </div>
                  <h2 className="mt-2 text-4xl font-semibold tracking-tight">{weather ? getWeatherLocationName(weather.location) : '天气'}</h2>
                  {weather && (
                    <p className="mt-1 text-sm text-white/55">
                      {getWeatherLocationAddress(weather.location)}
                    </p>
                  )}
                  {weather && (
                    <div className="mt-3 flex items-center gap-1.5 text-xs text-white/45">
                      <Clock3 className="h-3.5 w-3.5" />
                      {loading
                        ? '正在更新天气…'
                        : `更新于 ${new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(weather.updatedAt)}`}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {weather && (
                    <button
                      type="button"
                      onClick={onRefresh}
                      disabled={loading}
                      title="刷新天气"
                      aria-label="刷新天气"
                      className="flex h-11 w-11 items-center justify-center rounded-full border border-white/15 bg-white/10 transition-colors hover:bg-white/20 disabled:opacity-50"
                    >
                      <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={onClose}
                    title="关闭天气详情"
                    aria-label="关闭天气详情"
                    className="flex h-11 w-11 items-center justify-center rounded-full border border-white/15 bg-white/10 transition-colors hover:bg-white/20"
                  >
                    <X className="h-5 w-5" />
                  </button>
                </div>
              </div>

              <div className="mt-7 flex w-fit items-center gap-1 rounded-full border border-white/12 bg-black/15 p-1.5 backdrop-blur-xl">
                {([
                  ['weather', '天气'],
                  ['typhoon', '台风'],
                  ['earthquake', '地震'],
                ] as const).map(([tab, label]) => (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => setActiveTab(tab)}
                    className="rounded-full px-5 py-2.5 text-sm font-medium transition-colors"
                    style={{
                      color: activeTab === tab ? '#fff' : 'rgba(255,255,255,.56)',
                      background: activeTab === tab ? 'rgba(255,255,255,.16)' : 'transparent',
                      boxShadow: activeTab === tab ? 'inset 0 0 0 1px rgba(255,255,255,.12)' : 'none',
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {activeTab !== 'weather' ? (
                <WeatherHazardsPanel
                  tab={activeTab}
                  weather={weather}
                  hazards={hazards}
                  loading={hazardLoading}
                  error={hazardError}
                  onRefresh={onHazardRefresh}
                />
              ) : !weather ? (
                <div className="flex min-h-[420px] flex-col items-center justify-center text-center">
                  <Cloud className="mb-5 h-16 w-16 text-white/45" />
                  <div className="text-xl font-medium">暂时无法获取天气</div>
                  <button
                    type="button"
                    onClick={onRefresh}
                    disabled={loading}
                    className="mt-5 rounded-full bg-white/15 px-5 py-2.5 text-sm font-medium transition-colors hover:bg-white/25 disabled:opacity-50"
                  >
                    {loading ? '正在刷新…' : '重新获取'}
                  </button>
                </div>
              ) : (
                <>
                  <div className="mt-8 flex items-end justify-between gap-8 rounded-[30px] border border-white/10 bg-black/10 px-6 py-7">
                    <div>
                      <div className="text-[7.5rem] font-extralight leading-[0.82] tracking-[-0.08em] tabular-nums">
                        {Math.round(weather.current.temperature)}°
                      </div>
                      <div className="mt-6 text-2xl font-medium text-white/78">{getWeatherLabel(weather.current.weatherCode)}</div>
                      <div className="mt-2 text-base text-white/55">
                        最高 {Math.round(weather.daily[0]?.temperatureMax ?? weather.current.temperature)}° · 最低 {Math.round(weather.daily[0]?.temperatureMin ?? weather.current.temperature)}°
                      </div>
                      <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 text-sm text-white/55">
                        <span>体感 {Math.round(weather.current.apparentTemperature)}°</span>
                        <span>湿度 {Math.round(weather.current.humidity)}%</span>
                        <span>风速 {Math.round(weather.current.windSpeed)} km/h</span>
                      </div>
                    </div>
                    <WeatherGlyph code={weather.current.weatherCode} isDay={weather.current.isDay} className="h-28 w-28 text-white/90 drop-shadow-2xl" />
                  </div>

                  {weather.alerts.length > 0 && (
                    <div className="mt-8 space-y-3">
                      {weather.alerts.map(alert => (
                        <div
                          key={alert.id}
                          className="rounded-3xl border px-5 py-4"
                          style={{
                            borderColor: alert.level === 'extreme' ? 'rgba(251,113,133,0.55)' : 'rgba(251,191,36,0.45)',
                            background: alert.level === 'extreme' ? 'rgba(159,18,57,0.28)' : 'rgba(146,64,14,0.24)',
                          }}
                        >
                          <div className="flex items-start gap-3">
                            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-300" />
                            <div>
                              <div className="font-semibold">{alert.title}</div>
                              <p className="mt-1 text-sm leading-6 text-white/68">{alert.message}</p>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  <section className="weather-glass-panel mt-8 rounded-[30px] border border-white/10 p-5">
                    <div className="mb-4 flex items-center justify-between gap-3"><span className="text-sm font-medium text-white/55">未来 24 小时</span><span className="text-xs text-white/30">从现在到 24 小时后</span></div>
                    <div className="flex gap-3 overflow-x-auto pb-2 custom-scrollbar">
                      {weather.hourly.slice(0, 25).map((hour, index) => (
                        <div key={hour.time} className="flex min-w-[74px] flex-col items-center border-r border-white/10 px-3 py-4 last:border-r-0">
                          <span className="text-sm font-medium text-white/70">{formatHour(hour.time, index)}</span>
                          <WeatherGlyph code={hour.weatherCode} isDay={isHourDaylight(hour.time, weather)} className="my-4 h-7 w-7 text-white/85" />
                          <span className="text-lg font-semibold tabular-nums">{Math.round(hour.temperature)}°</span>
                          <span className="mt-2 text-xs font-medium text-cyan-200/75">{hour.precipitationProbability > 0 ? `${Math.round(hour.precipitationProbability)}%` : ' '}</span>
                        </div>
                      ))}
                    </div>
                  </section>

                  <section className="weather-glass-panel mt-5 rounded-[30px] border border-white/10 p-5">
                    <div className="mb-3 text-sm font-medium text-white/55">10 日天气预报</div>
                    <div className="divide-y divide-white/10">
                      {weather.daily.map((day, index) => {
                        const range = Math.max(1, day.temperatureMax - day.temperatureMin)
                        const overallMin = Math.min(...weather.daily.map(item => item.temperatureMin))
                        const overallMax = Math.max(...weather.daily.map(item => item.temperatureMax))
                        const overallRange = Math.max(1, overallMax - overallMin)
                        const left = ((day.temperatureMin - overallMin) / overallRange) * 100
                        const width = Math.max(12, (range / overallRange) * 100)
                        return (
                          <div key={day.date} className="grid grid-cols-[72px_52px_48px_1fr_48px] items-center gap-3 py-3.5">
                            <span className="font-medium">{formatWeekday(day.date, index)}</span>
                            <div className="flex flex-col items-center">
                              <WeatherGlyph code={day.weatherCode} className="h-6 w-6 text-white/85" />
                              {day.precipitationProbability > 0 && <span className="mt-1 text-[10px] text-cyan-200">{Math.round(day.precipitationProbability)}%</span>}
                            </div>
                            <span className="text-right tabular-nums text-white/45">{Math.round(day.temperatureMin)}°</span>
                            <div className="relative h-1.5 rounded-full bg-black/15">
                              <div
                                className="absolute h-full rounded-full bg-gradient-to-r from-cyan-300 via-amber-300 to-orange-400"
                                style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%` }}
                              />
                            </div>
                            <span className="tabular-nums">{Math.round(day.temperatureMax)}°</span>
                          </div>
                        )
                      })}
                    </div>
                  </section>

                  <WeatherMapExperience
                    weather={weather}
                    open={weatherMapOpen}
                    onOpen={() => setWeatherMapOpen(true)}
                    onClose={() => setWeatherMapOpen(false)}
                  />

                  <div className="mt-5 grid grid-cols-2 gap-4 md:grid-cols-3">
                    {[
                      { icon: ThermometerSun, label: '体感温度', value: `${Math.round(weather.current.apparentTemperature)}°`, detail: `实际温度 ${Math.round(weather.current.temperature)}°` },
                      { icon: Wind, label: '风', value: `${Math.round(weather.current.windSpeed)} km/h`, detail: `${getWindDirection(weather.current.windDirection)}风 · 阵风 ${Math.round(weather.current.windGusts)}` },
                      { icon: Droplets, label: '湿度', value: `${Math.round(weather.current.humidity)}%`, detail: '当前相对湿度' },
                      { icon: Eye, label: '能见度', value: `${Math.max(0.1, weather.current.visibility / 1000).toFixed(1)} km`, detail: weather.current.visibility >= 10000 ? '视野良好' : '注意低能见度' },
                      { icon: Gauge, label: '气压', value: `${Math.round(weather.current.pressure)} hPa`, detail: '地面气压' },
                      { icon: Umbrella, label: '降水', value: `${weather.current.precipitation.toFixed(1)} mm`, detail: `今日概率 ${Math.round(weather.daily[0]?.precipitationProbability || 0)}%` },
                      { icon: Sun, label: '紫外线', value: `${Math.round(weather.daily[0]?.uvIndexMax || 0)} · ${getUvLabel(weather.daily[0]?.uvIndexMax || 0)}`, detail: '今日最高指数' },
                      { icon: Sunrise, label: '日出', value: formatTime(weather.daily[0]?.sunrise || ''), detail: `日落 ${formatTime(weather.daily[0]?.sunset || '')}` },
                      { icon: Navigation, label: '位置', value: getWeatherLocationName(weather.location), detail: getWeatherLocationAddress(weather.location) },
                    ].map(item => {
                      const Icon = item.icon
                      return (
                        <div key={item.label} className="weather-glass-panel min-h-[150px] rounded-[26px] border border-white/10 p-5">
                          <div className="flex items-center gap-2 text-sm font-medium text-white/48"><Icon className="h-4 w-4" />{item.label}</div>
                          <div className="mt-5 break-words text-2xl font-medium tracking-tight">{item.value}</div>
                          <div className="mt-2 text-sm leading-5 text-white/48">{item.detail}</div>
                        </div>
                      )
                    })}
                  </div>

                  <div className="mt-6 flex items-center justify-between border-t border-white/10 pt-5 text-xs text-white/35">
                    <span>数据来源：Open-Meteo · 风险提醒由预报数据生成</span>
                    <button type="button" onClick={onRefresh} disabled={loading} className="rounded-full bg-white/10 px-4 py-2 text-white/65 hover:bg-white/15 disabled:opacity-50">
                      {loading ? '刷新中…' : '刷新天气'}
                    </button>
                  </div>
                </>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  )
}


