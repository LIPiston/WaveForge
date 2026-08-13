# WaveForge 兑换码机制

## 设计原则

- 设备识别码首次使用时由 `crypto.randomUUID()` 随机生成，不读取主板、硬盘、网卡、CPU 序列号，也不上传任何硬件信息。
- Windows 下仅在当前用户的 `HKCU\Software\WaveForge` 写入 `DeviceId`。
- 已兑换授权保存在 Electron 自己的 `userData/device-license.json`。
- 兑换码使用 Ed25519 非对称签名。主程序只带公钥，独立开发者工具才能读取私钥。
- 兑换码与设备识别码的 SHA-256 摘要绑定，可选到期时间和功能标识。

## 独立生成器

兑换码生成器不存放在 WaveForge 项目中，开发环境中的位置为：

`D:\opencode\WaveForge-License-Studio`

这个目录不会进入 WaveForge 的构建或安装包。主项目内仅保留：

- `desktop/license-public-key.cjs`：用于验证兑换码的公钥。
- `desktop/device-license.cjs`：设备码和授权验证逻辑。

私钥保存于：

`%APPDATA%\WaveForge License Studio\license-private-key.pem`

该私钥不在 WaveForge 项目目录内。

## 后续接入功能

当前“功能标识”是一套通用授权层。业务代码可调用 `window.electron.deviceLicense.getState()`，检查 `grants` 中是否存在对应 `feature`，再决定是否展示或启用具体功能。

## 密钥轮换

只能在独立生成器目录内轮换密钥。轮换后旧兑换码无法被使用新公钥的版本验证，正式发布后不要随意轮换。
