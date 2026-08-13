import { motion, AnimatePresence } from 'framer-motion'
import { X, Edit3, Lock, Globe, ImagePlus } from 'lucide-react'
import { useState, useEffect, useRef } from 'react'
import { preparePlaylistCover } from '../utils/playlistCover'

interface EditPlaylistModalProps {
  show: boolean
  onClose: () => void
  onSubmit: (data: { name: string; desc?: string; privacy?: string; coverDataUrl?: string }) => void
  playlist: any
  loading?: boolean
}

export default function EditPlaylistModal({
  show,
  onClose,
  onSubmit,
  playlist,
  loading = false
}: EditPlaylistModalProps) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [privacy, setPrivacy] = useState<'public' | 'private'>('public')
  const [coverPreview, setCoverPreview] = useState('')
  const [coverDataUrl, setCoverDataUrl] = useState('')
  const [coverError, setCoverError] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (playlist && show) {
      setName(playlist.name || '')
      setDescription(playlist.description || playlist.desc || '')
      setPrivacy(playlist.privacy === 10 ? 'private' : 'public')
      setCoverPreview(playlist.coverImgUrl || '')
      setCoverDataUrl('')
      setCoverError('')
    }
  }, [playlist, show])

  const handleCoverChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setCoverError('')
    try {
      const prepared = await preparePlaylistCover(file)
      setCoverDataUrl(prepared)
      setCoverPreview(prepared)
    } catch (error) {
      setCoverError(error instanceof Error ? error.message : '封面处理失败')
    }
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (name.trim()) {
      onSubmit({
        name: name.trim(),
        desc: description.trim(),
        privacy: privacy === 'private' ? '10' : '0',
        coverDataUrl: coverDataUrl || undefined
      })
    }
  }

  const handleClose = () => {
    onClose()
  }

  return (
    <AnimatePresence>
      {show && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={handleClose}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[200]"
          />

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
              <div className="flex items-center justify-between p-6 border-b border-white/10">
                <div className="flex items-center gap-3">
                  <Edit3 className="w-6 h-6 text-blue-400" />
                  <h2 className="text-xl font-bold text-white">编辑歌单</h2>
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

              <form onSubmit={handleSubmit} className="p-6 space-y-5 max-h-[72vh] overflow-y-auto">
                <div>
                  <label className="block text-sm font-medium text-white/80 mb-2">歌单封面</label>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="group relative w-28 h-28 rounded-xl overflow-hidden bg-white/5 border border-white/10 hover:border-blue-400/60 transition-all"
                  >
                    {coverPreview ? (
                      <img src={coverPreview} alt="歌单封面预览" className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full flex flex-col items-center justify-center gap-2 text-white/50">
                        <ImagePlus className="w-7 h-7" />
                        <span className="text-xs">选择封面</span>
                      </div>
                    )}
                    <div className="absolute inset-0 flex items-center justify-center bg-black/45 opacity-0 group-hover:opacity-100 transition-opacity text-sm text-white">
                      替换图片
                    </div>
                  </button>
                  <input ref={fileInputRef} type="file" accept="image/*" onChange={handleCoverChange} className="hidden" />
                  {coverError && <p className="mt-2 text-xs text-red-400">{coverError}</p>}
                </div>

                <div>
                  <label className="block text-sm font-medium text-white/80 mb-2">
                    歌单名称 <span className="text-red-400">*</span>
                  </label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="歌单名称"
                    maxLength={40}
                    autoFocus
                    className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white placeholder-white/30 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-all"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-white/80 mb-2">
                    歌单描述
                  </label>
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="描述一下这个歌单..."
                    maxLength={980}
                    rows={5}
                    className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white placeholder-white/30 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-all resize-none"
                  />
                </div>

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
                          ? 'bg-blue-500/20 border-blue-500/50 text-blue-400'
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
                          ? 'bg-blue-500/20 border-blue-500/50 text-blue-400'
                          : 'bg-white/5 border-white/10 text-white/60 hover:bg-white/10'
                      }`}
                    >
                      <Lock className="w-4 h-4" />
                      <span>私密</span>
                    </button>
                  </div>
                </div>

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
                        ? 'bg-blue-600 hover:bg-blue-700 text-white'
                        : 'bg-white/10 text-white/30 cursor-not-allowed'
                    }`}
                  >
                    {loading ? '保存中...' : '保存'}
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
