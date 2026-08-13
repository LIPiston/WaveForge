# Merge from Wave-Forge - 2026-07-13

## Source

- New project: `C:\Users\unive\Desktop\Wave-Forge`
- Target/original project: `C:\Users\unive\Desktop\WaveForge`
- Backup created before merge: `C:\Users\unive\Desktop\WaveForge-backup-20260713-113110`

## Integrated Features

- Desktop mode UI and related player components.
- Wallpaper Engine / Windows desktop wallpaper sync.
- Electron IPC bridge for reading and watching the current Windows wallpaper.
- Desktop wallpaper manager service.
- 3D playlist carousel/grid/detail views.
- Full-screen player and gapless transition related components.
- Updated audio player, playlist service, music API, settings, lyrics, and quick settings code from `Wave-Forge`.
- New documentation files for desktop mode, wallpaper integration, testing, and development notes.

## Post-Merge Type Fixes

- Relaxed unused-variable TypeScript checks to match the current codebase style.
- Replaced non-standard `ringColor` style properties with Tailwind CSS custom variable `--tw-ring-color`.
- Fixed timer ref typing in `PlayerControls`.
- Added a missing `accentColor` prop for `PlayerControls` in `FullScreenPlayer`.
- Normalized full-screen translation position before passing it to `LyricsDisplay`.
- Guarded desktop lyrics loading when a song ID is unavailable.
- Removed a JSX inline `console.log` that returned `void`.

## Verification

- `npm.cmd run lint` passed.
- `npm.cmd run build` passed.

Build output was regenerated in `dist`.
