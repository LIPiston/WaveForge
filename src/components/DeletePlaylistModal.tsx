import { motion, AnimatePresence } from 'framer-motion'
import { AlertTriangle, Trash2, X } from 'lucide-react'

interface DeletePlaylistModalProps {
  show: boolean
  onClose: () => void
  onConfirm: () => void
  playlistName: string
  loading?: boolean
}

export default function DeletePlaylistModal({
  show,
  onClose,
  onConfirm,
  playlistName,
  loading = false
}: DeletePlaylistModalProps) {
  return (
    <AnimatePresence>
      {show && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[200]"
          />

          <motion.div
            initial={{ opacity: 0, scale: 0.9, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9, y: 20 }}
            transition={{ type: 'spring', damping: 25, stiffness: 200 }}
            className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[201] w-full max-w-sm"
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
              <div className="p-6">
                <div className="flex items-start gap-4">
                  <div className="w-12 h-12 rounded-full bg-red-500/20 flex items-center justify-center flex-shrink-0">
                    <AlertTriangle className="w-6 h-6 text-red-400" />
                  </div>
                  <div>
                    <h3 className="text-lg font-bold text-white mb-2">删除歌单</h3>
                    <p className="text-white/60 text-sm">
                      确定要删除歌单「<span className="text-white">{playlistName}</span>」吗？
                    </p>
                    <p className="text-white/40 text-xs mt-2">
                      此操作不可撤销，歌单内的歌曲将被移除。
                    </p>
                  </div>
                </div>
              </div>

              <div className="flex gap-3 p-4 border-t border-white/10">
                <button
                  type="button"
                  onClick={onClose}
                  disabled={loading}
                  className="flex-1 py-2.5 px-4 bg-white/5 hover:bg-white/10 text-white/80 rounded-xl transition-colors flex items-center justify-center gap-2"
                >
                  <X className="w-4 h-4" />
                  取消
                </button>
                <button
                  type="button"
                  onClick={onConfirm}
                  disabled={loading}
                  className={`flex-1 py-2.5 px-4 rounded-xl font-medium transition-all flex items-center justify-center gap-2 ${
                    loading
                      ? 'bg-red-500/30 text-white/30 cursor-not-allowed'
                      : 'bg-red-600 hover:bg-red-700 text-white'
                  }`}
                >
                  <Trash2 className="w-4 h-4" />
                  {loading ? '删除中...' : '删除'}
                </button>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
