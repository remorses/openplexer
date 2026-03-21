// Cross-platform startup service registration for openplexer daemon.
// Adapted from kimaki's startup-service.ts (vendored from startup-run, MIT).
//
// macOS:   ~/Library/LaunchAgents/com.openplexer.plist  (launchd)
// Linux:   ~/.config/autostart/openplexer.desktop       (XDG autostart)
// Windows: HKCU\Software\Microsoft\Windows\CurrentVersion\Run  (registry)

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { exec as _exec } from 'node:child_process'

const SERVICE_NAME = 'com.openplexer'

function execAsync(command: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    _exec(command, { timeout: 5000 }, (error, stdout, stderr) => {
      if (error) {
        reject(error)
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

function getServiceFilePath(): string {
  switch (process.platform) {
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'LaunchAgents', `${SERVICE_NAME}.plist`)
    case 'linux':
      return path.join(os.homedir(), '.config', 'autostart', 'openplexer.desktop')
    case 'win32':
      return 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\\openplexer'
    default:
      throw new Error(`Unsupported platform: ${process.platform}`)
  }
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function shellEscape(value: string): string {
  if (/^[a-zA-Z0-9._/=-]+$/.test(value)) {
    return value
  }
  return `"${value.replace(/"/g, '\\"')}"`
}

function buildMacOSPlist({ command, args }: { command: string; args: string[] }): string {
  const segments = [command, ...args]
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_NAME}</string>
  <key>ProgramArguments</key>
  <array>
${segments.map((s) => `    <string>${escapeXml(s)}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
</dict>
</plist>
`
}

function buildLinuxDesktop({ command, args }: { command: string; args: string[] }): string {
  const execLine = [command, ...args].map(shellEscape).join(' ')
  return `[Desktop Entry]
Type=Application
Version=1.0
Name=openplexer
Comment=openplexer session sync daemon
Exec=${execLine}
StartupNotify=false
Terminal=false
`
}

export type StartupServiceOptions = {
  command: string
  args: string[]
}

export async function enableStartupService({ command, args }: StartupServiceOptions): Promise<void> {
  const platform = process.platform

  if (platform === 'darwin') {
    const filePath = getServiceFilePath()
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, buildMacOSPlist({ command, args }))
  } else if (platform === 'linux') {
    const filePath = getServiceFilePath()
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, buildLinuxDesktop({ command, args }))
  } else if (platform === 'win32') {
    const execLine = [command, ...args]
      .map((s) => {
        return s.includes(' ') ? `"${s}"` : s
      })
      .join(' ')
    await execAsync(
      `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v openplexer /t REG_SZ /d "${execLine}" /f`,
    )
  } else {
    throw new Error(`Unsupported platform: ${platform}`)
  }
}

export async function disableStartupService(): Promise<void> {
  const platform = process.platform

  if (platform === 'darwin' || platform === 'linux') {
    const filePath = getServiceFilePath()
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
    }
  } else if (platform === 'win32') {
    await execAsync(
      `reg delete "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v openplexer /f`,
    ).catch(() => {})
  } else {
    throw new Error(`Unsupported platform: ${platform}`)
  }
}

export async function isStartupServiceEnabled(): Promise<boolean> {
  const platform = process.platform

  if (platform === 'darwin' || platform === 'linux') {
    return fs.existsSync(getServiceFilePath())
  }

  if (platform === 'win32') {
    const result = await execAsync(
      `reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v openplexer`,
    ).catch(() => {
      return null
    })
    return result !== null
  }

  return false
}

export function getServiceLocationDescription(): string {
  const platform = process.platform
  if (platform === 'darwin') {
    return `launchd: ${getServiceFilePath()}`
  }
  if (platform === 'linux') {
    return `XDG autostart: ${getServiceFilePath()}`
  }
  if (platform === 'win32') {
    return `registry: ${getServiceFilePath()}`
  }
  return `unsupported platform: ${platform}`
}
