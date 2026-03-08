import { accessSync, constants } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

function isExecutable(filePath) {
  try {
    accessSync(filePath, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function resolveTauriBin() {
  const fileName = process.platform === 'win32' ? 'tauri.cmd' : 'tauri'
  return path.join(process.cwd(), 'node_modules', '.bin', fileName)
}

function resolveCargoHome() {
  if (process.env.CARGO_HOME) return process.env.CARGO_HOME
  if (process.env.HOME) return path.join(process.env.HOME, '.cargo')
  return null
}

function findExecutableInPath(fileName, envPath) {
  for (const entry of (envPath ?? '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(entry, fileName)
    if (isExecutable(candidate)) return candidate
  }
  return null
}

function isTauriDevCommand(args) {
  return args[0] === 'dev'
}

function buildEnv(args) {
  const env = { ...process.env }
  if (isTauriDevCommand(args)) {
    env.OPENPENCIL_DESKTOP_DEV = '1'
  }
  const cargoHome = resolveCargoHome()
  if (!cargoHome) return env

  const cargoBin = path.join(cargoHome, 'bin')
  const cargoExecutable = path.join(cargoBin, process.platform === 'win32' ? 'cargo.exe' : 'cargo')
  if (!isExecutable(cargoExecutable)) return env

  const pathEntries = (env.PATH ?? '').split(path.delimiter).filter(Boolean)
  if (!pathEntries.includes(cargoBin)) {
    env.PATH = [cargoBin, ...pathEntries].join(path.delimiter)
  }

  return env
}

function printMissingCargoHelp() {
  const cargoHome = resolveCargoHome()
  const cargoBin = cargoHome ? path.join(cargoHome, 'bin') : '~/.cargo/bin'

  console.error('OpenPencil desktop requires the Rust toolchain.')
  console.error(`Cargo was not found on PATH, and ${cargoBin} is not available.`)
  console.error('')
  console.error('Install Rust with rustup, then restart the terminal or app so cargo is on PATH.')
  console.error('On macOS you also need Xcode Command Line Tools: xcode-select --install')
}

const tauriBin = resolveTauriBin()
if (!isExecutable(tauriBin)) {
  console.error(`Tauri CLI binary not found at ${tauriBin}. Run bun install first.`)
  process.exit(1)
}

const tauriArgs = process.argv.slice(2)
const env = buildEnv(tauriArgs)
const cargoExecutable = findExecutableInPath(
  process.platform === 'win32' ? 'cargo.exe' : 'cargo',
  env.PATH
)

if (!cargoExecutable) {
  printMissingCargoHelp()
  process.exit(1)
}

const child = spawn(tauriBin, tauriArgs, {
  stdio: 'inherit',
  env
})

child.on('error', (error) => {
  if (error.code === 'ENOENT') {
    printMissingCargoHelp()
    process.exit(1)
  }

  console.error(error.message)
  process.exit(1)
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }

  process.exit(code ?? 1)
})
