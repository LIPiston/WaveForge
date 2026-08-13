import { motion, AnimatePresence } from 'framer-motion'
import { X, Music, Lock, Globe, ImagePlus } from 'lucide-react'
import { useRef, useState } from 'react'
import { preparePlaylistCover } from '../utils/playlistCover'

interface CreatePlaylistModalProps {
  show: boolean
  onClose: () => void
  onSubmit: (name: string, privacy: 'public' | 'private', description?: string, coverDataUrl?: string) => void
  loading?: boolean
}

export default function CreatePlaylistModal({
  show,
  onClose,
  onSubmit,
  loading = false
}: CreatePlaylistModalProps) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [privacy, setPrivacy] = useState<'public' | 'private'>('public')
  const [coverDataUrl, setCoverDataUrl] = useState('')
  const [coverError, setCoverError] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (name.trim()) {
      onSubmit(name.trim(), privacy, description.trim() || undefined, coverDataUrl || undefined)
    }
  }

  const handleCoverChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setCoverError('')
    try {
      setCoverDataUrl(await preparePlaylistCover(file))
    } catch (error) {
      setCoverError(error instanceof Error ? error.message : '封面处理失败')
    }
  }

  const handleClose = () => {
    setName('')
    setDescription('')
    setPrivacy('public')
    setCoverDataUrl('')
    setCoverError('')
    onClose()
  }

  return (
    <AnimatePresence>
      {show && (
        <>
          {/* 背景遮罩 */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={handleClose}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[200]"
          />

          {/* 弹窗 */}
          <motion.div
            initial={{ opacity: 0, scale: 0.9, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9, y: 20 }}
            transition={{ type: 'spring', damping: 25, stiffness: 200 }}
            className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[201] w-full max-w-lg"
          >
            <div 
              className="rounded-2xl overflow-hidden"
              style={{
                background: 'rgba(30, 30, 40, 0.95)',
                backdropFilter: 'blur(40px)',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                boxShadow: '0 20px 60px rgba(0, 0, 0, 0.5)'
              }}
            >
              {/* 头部 */}
              <div className="flex items-center justify-between p-6 border-b border-white/10">
                <div className="flex items-center gap-3">
                  <Music className="w-6 h-6 text-purple-400" />
                  <h2 className="text-xl font-bold text-white">新建歌单</h2>
                </div>
                <motion.button
                  whileHover={{ scale: 1.1, rotate: 90 }}
                  whileTap={{ scale: 0.9 }}
                  onClick={handleClose}
                  className="p-2 hover:bg-white/10 rounded-full transition-colors"
                >
                  <X className="w-5 h-5 text-white/60" />
                </motion.button>
              </div>

              {/* 表单 */}
              <form onSubmit={handleSubmit} className="p-6 space-y-5 max-h-[72vh] overflow-y-auto">
                <div>
                  <label className="block text-sm font-medium text-white/80 mb-2">
                    歌单封面 <span className="text-white/40">(可选)</span>
                  </label>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="group relative w-28 h-28 rounded-xl overflow-hidden bg-white/5 border border-white/10 hover:border-purple-400/60 transition-all"
                  >
                    {coverDataUrl ? (
                      <img src={coverDataUrl} alt="歌单封面预览" className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full flex flex-col items-center justify-center gap-2 text-white/50">
                        <ImagePlus className="w-7 h-7" />
                        <span className="text-xs">选择封面</span>
                      </div>
                    )}
                    {coverDataUrl && (
                      <div className="absolute inset-0 flex items-center justify-center bg-black/45 opacity-0 group-hover:opacity-100 transition-opacity text-sm text-white">
                        替换图片
                      </div>
                    )}
                  </button>
                  <input ref={fileInputRef} type="file" accept="image/*" onChange={handleCoverChange} className="hidden" />
                  {coverError && <p className="mt-2 text-xs text-red-400">{coverError}</p>}
                </div>

                {/* 歌单名称 */}
                <div>
                  <label className="block text-sm font-medium text-white/80 mb-2">
                    歌单名称 <span className="text-red-400">*</span>
                  </label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="给你的歌单起个名字"
                    maxLength={40}
                    autoFocus
                    className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white placeholder-white/30 focus:outline-none focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/50 transition-all"
                  />
                </div>

                {/* 歌单描述 */}
                <div>
                  <label className="block text-sm font-medium text-white/80 mb-2">
                    歌单描述 <span className="text-white/40">(可选)</span>
                  </label>
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="描述一下这个歌单的主题..."
                    maxLength={980}
                    rows={5}
                    className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white placeholder-white/30 focus:outline-none focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/50 transition-all resize-none"
                  />
                </div>

                {/* 隐私设置 */}
                <div>
                  <label className="block text-sm font-medium text-white/80 mb-3">
                    隐私设置
                  </label>
                  <div className="flex gap-3">
                    <button
                      type="button"
                      onClick={() => setPrivacy('public')}
                      className={`flex-1 flex items-center justify-center gap-2 py-3 rounded-xl border transition-all ${
                        privacy === 'public'
                          ? 'bg-purple-500/20 border-purple-500/50 text-purple-400'
                          : 'bg-white/5 border-white/10 text-white/60 hover:bg-white/10'
                      }`}
                    >
                      <Globe className="w-4 h-4" />
                      <span>公开</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setPrivacy('private')}
                      className={`flex-1 flex items-center justify-center gap-2 py-3 rounded-xl border transition-all ${
                        privacy === 'private'
                          ? 'bg-purple-500/20 border-purple-500/50 text-purple-400'
                          : 'bg-white/5 border-white/10 text-white/60 hover:bg-white/10'
                      }`}
                    >
                      <Lock className="w-4 h-4" />
                      <span>私密</span>
                    </button>
                  </div>
                </div>

                {/* 提交按钮 */}
                <div className="flex gap-3 pt-2">
                  <button
                    type="button"
                    onClick={handleClose}
                    className="flex-1 py-3 px-4 bg-white/5 hover:bg-white/10 text-white/80 rounded-xl transition-colors"
                  >
                    取消
                  </button>
                  <button
                    type="submit"
                    disabled={!name.trim() || loading}
                    className={`flex-1 py-3 px-4 rounded-xl font-medium transition-all ${
                      name.trim() && !loading
                        ? 'bg-purple-600 hover:bg-purple-700 text-white'
                        : 'bg-white/10 text-white/30 cursor-not-allowed'
                    }`}
                  >
                    {loading ? '创建中...' : '创建'}
                  </button>
                </div>
              </form>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
