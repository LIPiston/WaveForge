/**
 * 均衡器页 —— 复用现有 EqPanel 逻辑，主题经 toLegacyTheme 适配
 */

import { EqPanel as BaseEqPanel } from '../eqPanel'
import { toLegacyTheme } from '../hse-theme'
import type { HSETheme } from '../hse-theme'
import type { V3UiBridge } from '../bridge'
import type { V3ParamsController } from '../hooks'

interface EqPageProps {
  bridge: V3UiBridge
  controller: V3ParamsController
  theme: HSETheme
  onOpenEffect: (key: string) => void
}

export default function EqPage({ controller, theme }: EqPageProps) {
  return (
    <div>
      <BaseEqPanel controller={controller} theme={toLegacyTheme(theme)} />
    </div>
  )
}
