import { motion } from 'framer-motion'
import { useEffect, useRef, useState, type CSSProperties } from 'react'

interface CrossfadeBackgroundProps {
  coverUrl: string
  transitionFromUrl?: string
  transitionToUrl?: string
  isTransitioning: boolean
  transitionProgress: number
  imageStyle: CSSProperties
}

function isUsableCover(url?: string): url is string {
  return Boolean(url?.trim() && !url.includes('picsum.photos'))
}

export default function CrossfadeBackground({
  coverUrl,
  transitionFromUrl,
  transitionToUrl,
  isTransitioning,
  transitionProgress,
  imageStyle,
}: CrossfadeBackgroundProps) {
  const initialUrl = isUsableCover(coverUrl) ? coverUrl : ''
  const [visibleUrl, setVisibleUrl] = useState(initialUrl)
  const [incomingUrl, setIncomingUrl] = useState('')
  const requestSerialRef = useRef(0)

  // Ordinary/manual track changes also keep the old image until the new one is decoded.
  useEffect(() => {
    if (isTransitioning || !isUsableCover(coverUrl) || coverUrl === visibleUrl || coverUrl === incomingUrl) return

    const serial = ++requestSerialRef.current
    const image = new Image()
    image.onload = () => {
      if (serial === requestSerialRef.current) setIncomingUrl(coverUrl)
    }
    image.src = coverUrl

    return () => {
      image.onload = null
    }
  }, [coverUrl, incomingUrl, isTransitioning, visibleUrl])


  const explicitTransition = Boolean(
    isTransitioning
      && isUsableCover(transitionFromUrl)
      && isUsableCover(transitionToUrl)
  )
  const clampedProgress = Math.max(0, Math.min(1, transitionProgress))

  useEffect(() => {
    if (
      explicitTransition
      && transitionToUrl
      && (coverUrl === transitionToUrl || clampedProgress >= 0.995)
    ) {
      setVisibleUrl(transitionToUrl)
      setIncomingUrl('')
    }
  }, [clampedProgress, coverUrl, explicitTransition, transitionToUrl])

  const layerStyle = (url: string): CSSProperties => ({
    ...imageStyle,
    backgroundImage: `url(${url})`,
  })

  return (
    <div className="absolute inset-0 overflow-hidden">
      {visibleUrl && (
        <div className="absolute inset-0 bg-cover bg-center" style={layerStyle(visibleUrl)} />
      )}

      {explicitTransition
        && transitionFromUrl
        && transitionFromUrl !== visibleUrl
        && (
          <div className="absolute inset-0 bg-cover bg-center" style={layerStyle(transitionFromUrl)} />
        )}

      {explicitTransition && transitionToUrl ? (
        <div
          className="absolute inset-0 bg-cover bg-center"
          style={{
            ...layerStyle(transitionToUrl),
            opacity: clampedProgress,
            transition: `${imageStyle.transition || ''}, opacity 80ms linear`,
          }}
        />
      ) : incomingUrl ? (
        <motion.div
          key={incomingUrl}
          className="absolute inset-0 bg-cover bg-center"
          style={layerStyle(incomingUrl)}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.8, ease: 'easeInOut' }}
          onAnimationComplete={() => {
            setVisibleUrl(incomingUrl)
            setIncomingUrl('')
          }}
        />
      ) : null}
    </div>
  )
}
