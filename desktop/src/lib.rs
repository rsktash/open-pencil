use tauri::{
    menu::{MenuBuilder, MenuItem, MenuItemBuilder, PredefinedMenuItem, Submenu, SubmenuBuilder},
    Emitter, Manager,
};
use tiny_http::{Header, Method, Response, Server, StatusCode};

use font_kit::source::SystemSource;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::HashMap,
    fs,
    io::{BufReader, Cursor, Read},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};

const AUTOMATION_HTTP_PORT: u16 = 7600;
const AUTOMATION_RPC_TIMEOUT: Duration = Duration::from_secs(30);
const AUTOMATION_BRIDGE_WAIT_TIMEOUT: Duration = Duration::from_secs(5);
const AUTOMATION_BRIDGE_WAIT_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Serialize, Clone)]
struct FontFamily {
    family: String,
    styles: Vec<String>,
}

#[derive(Default)]
struct AutomationBridgeState {
    auth_token: Mutex<Option<String>>,
    pending: Mutex<HashMap<String, mpsc::Sender<serde_json::Value>>>,
    next_request_id: AtomicU64,
}

#[derive(Default)]
struct CliProcessState {
    running: Mutex<HashMap<String, u32>>,
}

#[derive(Default)]
struct RecentFilesMenuState {
    submenu: Mutex<Option<Submenu<tauri::Wry>>>,
    items: Mutex<Vec<MenuItem<tauri::Wry>>>,
}

type SharedAutomationBridgeState = Arc<AutomationBridgeState>;
type SharedCliProcessState = Arc<CliProcessState>;
type SharedRecentFilesMenuState = Arc<RecentFilesMenuState>;

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CliAttachmentInput {
    name: String,
    media_type: String,
    bytes: Vec<u8>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RunAgentCliRequest {
    request_id: String,
    mode: String,
    backend: String,
    model: String,
    session_id: String,
    resume_session: bool,
    prompt: String,
    attachments: Vec<CliAttachmentInput>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecentFileMenuEntry {
    label: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CliToolLogEntry {
    name: String,
    args: serde_json::Value,
    ok: bool,
    result: Option<serde_json::Value>,
    error: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AgentCliEvent {
    request_id: String,
    kind: String,
    text: Option<String>,
    tool_log: Option<CliToolLogEntry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RunAgentCliResponse {
    stdout: String,
    stderr: String,
    exit_code: i32,
    tool_logs: Vec<CliToolLogEntry>,
}

#[derive(Deserialize)]
struct AutomationRpcBody {
    command: String,
    #[serde(default)]
    args: serde_json::Value,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AutomationRequestEvent {
    id: String,
    command: String,
    args: serde_json::Value,
}

struct CliWorkdir {
    dir: std::path::PathBuf,
    tool_log_path: std::path::PathBuf,
}

enum CliOutputChunk {
    Stdout(String),
    Stderr(String),
}

static FONT_CACHE: OnceLock<Vec<FontFamily>> = OnceLock::new();

fn enumerate_system_fonts() -> Vec<FontFamily> {
    let source = SystemSource::new();
    let mut families: Vec<FontFamily> = Vec::new();

    if let Ok(family_names) = source.all_families() {
        for name in &family_names {
            if let Ok(handle) = source.select_family_by_name(name) {
                let styles: Vec<String> = handle
                    .fonts()
                    .iter()
                    .filter_map(|f| {
                        f.load().ok().map(|font| {
                            let props = font.properties();
                            let mut style = match props.weight.0 as i32 {
                                0..=150 => "Thin",
                                151..=250 => "ExtraLight",
                                251..=350 => "Light",
                                351..=450 => "Regular",
                                451..=550 => "Medium",
                                551..=650 => "SemiBold",
                                651..=750 => "Bold",
                                751..=850 => "ExtraBold",
                                _ => "Black",
                            }
                            .to_string();
                            if props.style == font_kit::properties::Style::Italic {
                                style.push_str(" Italic");
                            }
                            style
                        })
                    })
                    .collect();

                if !styles.is_empty() {
                    families.push(FontFamily {
                        family: name.clone(),
                        styles,
                    });
                }
            }
        }
    }

    families.sort_by(|a, b| a.family.cmp(&b.family));
    families
}

#[tauri::command]
async fn list_system_fonts() -> Vec<FontFamily> {
    if let Some(cached) = FONT_CACHE.get() {
        return cached.clone();
    }

    let families = tauri::async_runtime::spawn_blocking(enumerate_system_fonts)
        .await
        .unwrap_or_default();
    let _ = FONT_CACHE.set(families.clone());
    families
}

fn load_system_font_blocking(family: String, style: String) -> Result<Vec<u8>, String> {
    let source = SystemSource::new();
    let family_handle = source
        .select_family_by_name(&family)
        .map_err(|e| format!("Font family not found: {e}"))?;

    let is_italic = style.contains("Italic");
    let weight_str = style.replace(" Italic", "");
    let weight = match weight_str.as_str() {
        "Thin" => font_kit::properties::Weight::THIN,
        "ExtraLight" => font_kit::properties::Weight::EXTRA_LIGHT,
        "Light" => font_kit::properties::Weight::LIGHT,
        "Regular" | "" => font_kit::properties::Weight::NORMAL,
        "Medium" => font_kit::properties::Weight::MEDIUM,
        "SemiBold" => font_kit::properties::Weight::SEMIBOLD,
        "Bold" => font_kit::properties::Weight::BOLD,
        "ExtraBold" => font_kit::properties::Weight::EXTRA_BOLD,
        "Black" => font_kit::properties::Weight::BLACK,
        _ => font_kit::properties::Weight::NORMAL,
    };
    let style_prop = if is_italic {
        font_kit::properties::Style::Italic
    } else {
        font_kit::properties::Style::Normal
    };

    for handle in family_handle.fonts() {
        if let Ok(font) = handle.load() {
            let props = font.properties();
            let w_diff = (props.weight.0 - weight.0).abs();
            if w_diff < 50.0 && props.style == style_prop {
                if let Some(data) = font.copy_font_data() {
                    return Ok((*data).clone());
                }
            }
        }
    }

    // Fallback: return first font in family
    if let Some(handle) = family_handle.fonts().first() {
        if let Ok(font) = handle.load() {
            if let Some(data) = font.copy_font_data() {
                return Ok((*data).clone());
            }
        }
    }

    Err(format!("Could not load font {family} {style}"))
}

#[tauri::command]
async fn load_system_font(family: String, style: String) -> Result<Vec<u8>, String> {
    tauri::async_runtime::spawn_blocking(move || load_system_font_blocking(family, style))
        .await
        .map_err(|e| format!("Font load task failed: {e}"))?
}

#[tauri::command]
fn build_fig_file(
    schema_deflated: Vec<u8>,
    kiwi_data: Vec<u8>,
    thumbnail_png: Vec<u8>,
    meta_json: String,
    images: HashMap<String, Vec<u8>>,
) -> Result<Vec<u8>, String> {
    use std::io::{Cursor, Write};

    // Zstd-compress kiwi data with content size in frame header
    let mut encoder = zstd::Encoder::new(Vec::new(), 3).map_err(|e| e.to_string())?;
    encoder
        .include_contentsize(true)
        .map_err(|e| e.to_string())?;
    encoder
        .set_pledged_src_size(Some(kiwi_data.len() as u64))
        .map_err(|e| e.to_string())?;
    encoder.write_all(&kiwi_data).map_err(|e| e.to_string())?;
    let zstd_data = encoder.finish().map_err(|e| e.to_string())?;

    // Build fig-kiwi container
    let version: u32 = 106;
    let fig_kiwi_len = 8 + 4 + 4 + schema_deflated.len() + 4 + zstd_data.len();
    let mut fig_kiwi = Vec::with_capacity(fig_kiwi_len);
    fig_kiwi.extend_from_slice(b"fig-kiwi");
    fig_kiwi.extend_from_slice(&version.to_le_bytes());
    fig_kiwi.extend_from_slice(&(schema_deflated.len() as u32).to_le_bytes());
    fig_kiwi.extend_from_slice(&schema_deflated);
    fig_kiwi.extend_from_slice(&(zstd_data.len() as u32).to_le_bytes());
    fig_kiwi.extend_from_slice(&zstd_data);

    // Deflate-compress the schema for verification it's already deflated
    // (schema_deflated is already deflated, we just pass it through)

    // Build ZIP with canvas.fig + thumbnail.png + meta.json + image blobs (all STORED)
    let buf = Cursor::new(Vec::new());
    let mut zip = zip::ZipWriter::new(buf);
    let options =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);

    zip.start_file("canvas.fig", options)
        .map_err(|e| e.to_string())?;
    zip.write_all(&fig_kiwi).map_err(|e| e.to_string())?;

    zip.start_file("thumbnail.png", options)
        .map_err(|e| e.to_string())?;
    zip.write_all(&thumbnail_png).map_err(|e| e.to_string())?;

    zip.start_file("meta.json", options)
        .map_err(|e| e.to_string())?;
    zip.write_all(meta_json.as_bytes())
        .map_err(|e| e.to_string())?;

    for (hash, bytes) in images {
        zip.start_file(format!("images/{hash}"), options)
            .map_err(|e| e.to_string())?;
        zip.write_all(&bytes).map_err(|e| e.to_string())?;
    }

    let result = zip.finish().map_err(|e| e.to_string())?;
    Ok(result.into_inner())
}

fn json_response(status: u16, body: serde_json::Value) -> Response<Cursor<Vec<u8>>> {
    let data = serde_json::to_vec(&body)
        .unwrap_or_else(|_| b"{\"ok\":false,\"error\":\"Failed to serialize response\"}".to_vec());
    let mut response = Response::from_data(data).with_status_code(StatusCode(status));
    if let Ok(header) = Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]) {
        response.add_header(header);
    }
    response
}

fn reject_pending_requests(bridge_state: &SharedAutomationBridgeState, reason: &str) {
    let pending = {
        let mut pending = bridge_state.pending.lock().unwrap_or_else(|e| e.into_inner());
        pending.drain().collect::<Vec<_>>()
    };

    for (_, sender) in pending {
        let _ = sender.send(json!({ "ok": false, "error": reason }));
    }
}

fn next_automation_request_id(bridge_state: &SharedAutomationBridgeState) -> String {
    let next = bridge_state.next_request_id.fetch_add(1, Ordering::Relaxed);
    format!("rpc-{}-{next}", std::process::id())
}

fn wait_for_automation_token(
    bridge_state: &SharedAutomationBridgeState,
    timeout: Duration,
) -> Option<String> {
    let deadline = Instant::now() + timeout;

    loop {
        let token = bridge_state
            .auth_token
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        if token.is_some() {
            return token;
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(AUTOMATION_BRIDGE_WAIT_INTERVAL);
    }
}

fn handle_automation_http_request<R: tauri::Runtime>(
    mut request: tiny_http::Request,
    app: &tauri::AppHandle<R>,
    bridge_state: &SharedAutomationBridgeState,
) {
    if request.method() == &Method::Get && request.url() == "/health" {
        let token = bridge_state
            .auth_token
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let payload = match token {
            Some(token) => json!({ "status": "ok", "token": token }),
            None => json!({ "status": "no_app" }),
        };
        let _ = request.respond(json_response(200, payload));
        return;
    }

    if request.method() != &Method::Post || request.url() != "/rpc" {
        let _ = request.respond(json_response(
            404,
            json!({ "ok": false, "error": "Not found" }),
        ));
        return;
    }

    let expected_token = bridge_state
        .auth_token
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let Some(expected_token) = expected_token else {
        let _ = request.respond(json_response(
            503,
            json!({ "ok": false, "error": "OpenPencil app is not connected. Is a document open?" }),
        ));
        return;
    };

    let provided_token = request
        .headers()
        .iter()
        .find(|header| header.field.equiv("Authorization"))
        .and_then(|header| header.value.as_str().strip_prefix("Bearer "))
        .map(str::to_string);

    if provided_token.as_deref() != Some(expected_token.as_str()) {
        let _ = request.respond(json_response(
            401,
            json!({ "ok": false, "error": "Unauthorized" }),
        ));
        return;
    }

    let mut raw_body = String::new();
    if let Err(error) = request.as_reader().read_to_string(&mut raw_body) {
        let _ = request.respond(json_response(
            400,
            json!({ "ok": false, "error": format!("Failed to read request body: {error}") }),
        ));
        return;
    }

    let body: AutomationRpcBody = match serde_json::from_str(&raw_body) {
        Ok(body) => body,
        Err(_) => {
            let _ = request.respond(json_response(
                400,
                json!({ "ok": false, "error": "Invalid request body" }),
            ));
            return;
        }
    };

    let Some(window) = app.get_webview_window("main") else {
        let _ = request.respond(json_response(
            503,
            json!({ "ok": false, "error": "OpenPencil app is not connected. Is a document open?" }),
        ));
        return;
    };

    let request_id = next_automation_request_id(bridge_state);
    let (sender, receiver) = mpsc::channel();
    bridge_state
        .pending
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(request_id.clone(), sender);

    if let Err(error) = window.emit(
        "automation-request",
        AutomationRequestEvent {
            id: request_id.clone(),
            command: body.command,
            args: body.args,
        },
    ) {
        bridge_state
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&request_id);
        let _ = request.respond(json_response(
            503,
            json!({ "ok": false, "error": format!("Failed to reach the editor: {error}") }),
        ));
        return;
    }

    match receiver.recv_timeout(AUTOMATION_RPC_TIMEOUT) {
        Ok(payload) => {
            let status = if payload
                .get("ok")
                .and_then(serde_json::Value::as_bool)
                .is_some_and(|ok| !ok)
            {
                502
            } else {
                200
            };
            let _ = request.respond(json_response(status, payload));
        }
        Err(mpsc::RecvTimeoutError::Timeout) => {
            bridge_state
                .pending
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&request_id);
            let _ = request.respond(json_response(
                504,
                json!({ "ok": false, "error": "RPC timeout (30s)" }),
            ));
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            bridge_state
                .pending
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&request_id);
            let _ = request.respond(json_response(
                502,
                json!({ "ok": false, "error": "Automation bridge disconnected" }),
            ));
        }
    }
}

fn start_automation_bridge<R: tauri::Runtime + 'static>(
    app: tauri::AppHandle<R>,
    bridge_state: SharedAutomationBridgeState,
) {
    std::thread::Builder::new()
        .name("openpencil-automation-bridge".to_string())
        .spawn(move || {
            let server = match Server::http(format!("127.0.0.1:{AUTOMATION_HTTP_PORT}")) {
                Ok(server) => server,
                Err(error) => {
                    eprintln!("[automation] Failed to start desktop bridge: {error}");
                    return;
                }
            };

            println!("[automation] HTTP  http://127.0.0.1:{AUTOMATION_HTTP_PORT}");

            for request in server.incoming_requests() {
                handle_automation_http_request(request, &app, &bridge_state);
            }
        })
        .expect("failed to spawn automation bridge thread");
}

fn show_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn sanitize_attachment_name(name: &str) -> String {
    let sanitized: String = name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '.' || ch == '_' || ch == '-' {
                ch
            } else {
                '_'
            }
        })
        .collect();

    if sanitized.is_empty() {
        "attachment.bin".to_string()
    } else {
        sanitized
    }
}

fn sanitize_session_id(session_id: &str) -> String {
    let sanitized: String = session_id
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect();

    if sanitized.is_empty() {
        "default-session".to_string()
    } else {
        sanitized
    }
}

fn resolve_agent_cli_session_dir(backend: &str, session_id: &str) -> std::path::PathBuf {
    std::env::temp_dir()
        .join("openpencil-agent-sessions")
        .join(backend)
        .join(sanitize_session_id(session_id))
}

fn write_agent_cli_helper(dir: &std::path::Path) -> Result<std::path::PathBuf, String> {
    let helper_path = dir.join("openpencil-tool.mjs");
    let script = r#"import { appendFileSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const [, , toolName, rawArgs = '{}'] = process.argv
const bridgeUrl = process.env.OPENPENCIL_AUTOMATION_URL
const bridgeToken = process.env.OPENPENCIL_AUTOMATION_TOKEN
const logPath = process.env.OPENPENCIL_TOOL_LOG ?? '.openpencil-tool-log.ndjson'
const workspaceRoot = process.env.OPENPENCIL_WORKSPACE_ROOT
const requireFromWorkspace = workspaceRoot
  ? createRequire(path.join(workspaceRoot, 'package.json'))
  : createRequire(import.meta.url)

function log(entry) {
  try {
    appendFileSync(logPath, `${JSON.stringify(entry)}\n`, 'utf8')
  } catch {
    // best effort only
  }
}

function fail(message, args = null) {
  log({ name: toolName ?? 'unknown', args, ok: false, result: null, error: message })
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

if (!toolName) {
  fail('Usage: node openpencil-tool.mjs <tool_name> [json_args]')
}

if (!bridgeUrl || !bridgeToken) {
  fail('OpenPencil automation bridge is not available in this session.')
}

const BRIDGE_RETRY_LIMIT = 20
const BRIDGE_RETRY_DELAY_MS = 250

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function createElement(type, props, ...children) {
  const flatChildren = children.flat()
  return {
    type,
    props: {
      ...(props ?? {}),
      children:
        flatChildren.length === 1
          ? flatChildren
          : flatChildren.length > 0
            ? flatChildren
            : undefined
    }
  }
}

function isTreeNode(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    'type' in value &&
    typeof value.type === 'string' &&
    'props' in value &&
    'children' in value &&
    Array.isArray(value.children)
  )
}

function isReactElement(value) {
  return value !== null && typeof value === 'object' && 'type' in value && 'props' in value
}

function resolveToTree(element, depth = 0) {
  if (depth > 100) throw new Error('Component resolution depth exceeded')
  if (element == null) return null
  if (isTreeNode(element)) return element
  if (!isReactElement(element)) return null

  if (typeof element.type === 'function') {
    return resolveToTree(element.type(element.props), depth + 1)
  }

  if (typeof element.type === 'string') {
    const children = []
    const rawChildren = element.props.children
    if (rawChildren != null) {
      const childArray = Array.isArray(rawChildren) ? rawChildren : [rawChildren]
      for (const child of childArray.flat()) {
        if (child == null) continue
        if (typeof child === 'string' || typeof child === 'number') {
          children.push(String(child))
        } else {
          const resolved = resolveToTree(child, depth + 1)
          if (resolved) children.push(resolved)
        }
      }
    }

    const { children: _children, ...props } = element.props
    return { type: element.type, props, children }
  }

  return null
}

function buildTreeFromJsx(jsxString) {
  let esbuild
  try {
    esbuild = requireFromWorkspace('esbuild')
  } catch {
    throw new Error(
      'The render tool requires esbuild to be installed in the OpenPencil workspace. Run bun install first.'
    )
  }

  const code = `
    const h = React.createElement
    const Frame = 'frame', Text = 'text', Rectangle = 'rectangle', Ellipse = 'ellipse'
    const Line = 'line', Star = 'star', Polygon = 'polygon', Vector = 'vector'
    const Group = 'group', Section = 'section', View = 'frame', Rect = 'rectangle'
    return function Component() { return ${jsxString.trim()} }
  `

  const result = esbuild.transformSync(code, {
    loader: 'tsx',
    jsx: 'transform',
    jsxFactory: 'h'
  })

  const Component = new Function('React', result.code)({ createElement })
  const tree = resolveToTree(createElement(Component, null))
  if (!tree) {
    throw new Error('JSX must return a valid OpenPencil element tree')
  }
  return tree
}

let parsedArgs
try {
  parsedArgs = JSON.parse(rawArgs)
} catch (error) {
  fail(`Invalid JSON args: ${error instanceof Error ? error.message : String(error)}`, rawArgs)
}

let payloadArgs = parsedArgs
if (
  toolName === 'render' &&
  parsedArgs &&
  typeof parsedArgs === 'object' &&
  typeof parsedArgs.jsx === 'string'
) {
  try {
    payloadArgs = { ...parsedArgs, tree: buildTreeFromJsx(parsedArgs.jsx) }
    delete payloadArgs.jsx
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error), parsedArgs)
  }
}

function parseResponseBody(rawBody) {
  try {
    return rawBody ? JSON.parse(rawBody) : null
  } catch {
    return null
  }
}

function isRetryableBridgeResponse(response, bodyObject) {
  return (
    response.status === 503 &&
    bodyObject &&
    typeof bodyObject === 'object' &&
    typeof bodyObject.error === 'string' &&
    bodyObject.error.includes('OpenPencil app is not connected')
  )
}

async function callBridge(command, args) {
  let lastError = null

  for (let attempt = 0; attempt < BRIDGE_RETRY_LIMIT; attempt += 1) {
    try {
      const response = await fetch(`${bridgeUrl}/rpc`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bridgeToken}`
        },
        body: JSON.stringify({
          command,
          args
        })
      })
      const rawBody = await response.text()
      const body = parseResponseBody(rawBody)
      const bodyObject = body && typeof body === 'object' ? body : null

      if (!isRetryableBridgeResponse(response, bodyObject) || attempt === BRIDGE_RETRY_LIMIT - 1) {
        return { response, rawBody, bodyObject }
      }
    } catch (error) {
      lastError = error
      if (attempt === BRIDGE_RETRY_LIMIT - 1) {
        throw error
      }
    }

    await sleep(BRIDGE_RETRY_DELAY_MS)
  }

  throw lastError ?? new Error('Failed to reach the OpenPencil automation bridge')
}

let bridgeResponse
try {
  bridgeResponse = await callBridge('tool', { name: toolName, args: payloadArgs })
} catch (error) {
  fail(
    `Failed to reach the OpenPencil automation bridge: ${error instanceof Error ? error.message : String(error)}`,
    parsedArgs
  )
}

const { response, rawBody, bodyObject } = bridgeResponse
const ok = Boolean(response.ok && bodyObject && bodyObject.ok !== false)
const entry = {
  name: toolName,
  args: parsedArgs,
  ok,
  result: bodyObject && 'result' in bodyObject ? bodyObject.result : null,
  error: !ok
    ? bodyObject && typeof bodyObject.error === 'string'
      ? bodyObject.error
      : rawBody || `HTTP ${response.status}`
    : null
}

log(entry)

if (!ok) {
  process.stderr.write(`${entry.error ?? 'OpenPencil tool call failed'}\n`)
  process.exit(1)
}

process.stdout.write(JSON.stringify(entry.result ?? null, null, 2))
"#;

    fs::write(&helper_path, script).map_err(|e| format!("Failed to write CLI helper: {e}"))?;
    Ok(helper_path)
}

fn build_agent_cli_workdir(
    backend: &str,
    session_id: &str,
    prompt: &str,
    attachments: &[CliAttachmentInput],
) -> Result<CliWorkdir, String> {
    let dir = resolve_agent_cli_session_dir(backend, session_id);
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create temp directory: {e}"))?;

    let attachments_dir = dir.join("attachments");
    if attachments_dir.exists() {
        fs::remove_dir_all(&attachments_dir)
            .map_err(|e| format!("Failed to reset attachments directory: {e}"))?;
    }
    fs::create_dir_all(&attachments_dir)
        .map_err(|e| format!("Failed to create attachments directory: {e}"))?;

    fs::write(dir.join("REQUEST.md"), prompt)
        .map_err(|e| format!("Failed to write CLI prompt file: {e}"))?;

    let mut manifest = String::from("# OpenPencil Attachments\n\n");
    if attachments.is_empty() {
        manifest.push_str("No attachments.\n");
    } else {
        for attachment in attachments {
            let file_name = sanitize_attachment_name(&attachment.name);
            let path = attachments_dir.join(&file_name);
            fs::write(&path, &attachment.bytes)
                .map_err(|e| format!("Failed to stage attachment \"{}\": {e}", attachment.name))?;
            manifest.push_str(&format!(
                "- attachments/{} ({}, {} bytes)\n",
                file_name,
                attachment.media_type,
                attachment.bytes.len()
            ));
        }
    }

    fs::write(dir.join("ATTACHMENTS.md"), manifest)
        .map_err(|e| format!("Failed to write attachment manifest: {e}"))?;

    write_agent_cli_helper(&dir)?;
    let tool_log_path = dir.join(".openpencil-tool-log.ndjson");
    fs::write(&tool_log_path, "").map_err(|e| format!("Failed to reset CLI tool log: {e}"))?;

    Ok(CliWorkdir { dir, tool_log_path })
}

fn read_cli_tool_logs(path: &std::path::Path) -> Vec<CliToolLogEntry> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(_) => return Vec::new(),
    };

    raw.lines()
        .filter_map(|line| serde_json::from_str::<CliToolLogEntry>(line).ok())
        .collect()
}

fn emit_agent_cli_event<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    request_id: &str,
    kind: &str,
    text: Option<String>,
    tool_log: Option<CliToolLogEntry>,
) {
    let _ = app.emit(
        "agent-cli-event",
        AgentCliEvent {
            request_id: request_id.to_string(),
            kind: kind.to_string(),
            text,
            tool_log,
        },
    );
}

fn emit_agent_cli_text<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    request_id: &str,
    kind: &str,
    text: String,
) {
    if text.is_empty() {
        return;
    }
    emit_agent_cli_event(app, request_id, kind, Some(text), None);
}

fn emit_agent_cli_tool_log<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    request_id: &str,
    tool_log: CliToolLogEntry,
) {
    emit_agent_cli_event(app, request_id, "tool-log", None, Some(tool_log));
}

fn spawn_cli_output_reader<R: Read + Send + 'static>(
    reader: R,
    is_stdout: bool,
    sender: mpsc::Sender<CliOutputChunk>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(reader);
        let mut buffer = [0_u8; 2048];

        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => {
                    let text = String::from_utf8_lossy(&buffer[..read]).to_string();
                    let chunk = if is_stdout {
                        CliOutputChunk::Stdout(text)
                    } else {
                        CliOutputChunk::Stderr(text)
                    };

                    if sender.send(chunk).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    })
}

fn drain_cli_output_chunks<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    request_id: &str,
    receiver: &mpsc::Receiver<CliOutputChunk>,
    stdout: &mut String,
    stderr: &mut String,
) {
    loop {
        match receiver.try_recv() {
            Ok(CliOutputChunk::Stdout(text)) => {
                stdout.push_str(&text);
                emit_agent_cli_text(app, request_id, "stdout", text);
            }
            Ok(CliOutputChunk::Stderr(text)) => {
                stderr.push_str(&text);
                emit_agent_cli_text(app, request_id, "stderr", text);
            }
            Err(mpsc::TryRecvError::Empty | mpsc::TryRecvError::Disconnected) => break,
        }
    }
}

fn emit_pending_tool_logs<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    request_id: &str,
    path: &std::path::Path,
    emitted_count: &mut usize,
) -> Vec<CliToolLogEntry> {
    let tool_logs = read_cli_tool_logs(path);
    for entry in tool_logs.iter().skip(*emitted_count) {
        emit_agent_cli_tool_log(app, request_id, entry.clone());
    }
    *emitted_count = tool_logs.len();
    tool_logs
}

fn build_agent_cli_command(
    backend: &str,
    model: &str,
    mode: &str,
    resume_session: bool,
    automation_token: Option<&str>,
) -> Result<Command, String> {
    let workspace_root = std::env::var("OPENPENCIL_WORKSPACE_ROOT").unwrap_or_else(|_| {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .to_string_lossy()
            .to_string()
    });
    let prompt = match mode {
        "direct" => "Read REQUEST.md in the current working directory and follow it exactly. Use the provided helper script when you need to inspect or modify the canvas. Output only the final user-facing response in markdown.",
        _ => "Read REQUEST.md in the current working directory and follow it exactly. Output only the requested JSON.",
    };

    let mut command = match backend {
        "claude-code" => {
            let executable =
                std::env::var("OPENPENCIL_CLAUDE_PATH").unwrap_or_else(|_| "claude".to_string());
            let mut cmd = Command::new(executable);
            cmd.arg("-p");
            if mode == "direct" {
                if resume_session {
                    cmd.arg("-c");
                }
                cmd.arg("--allowedTools")
                    .arg("Bash,Read")
                    .arg("--permission-mode")
                    .arg("acceptEdits")
                    .arg("--verbose")
                    .arg("--output-format")
                    .arg("stream-json")
                    .arg("--include-partial-messages");
            }
            cmd.arg("--model").arg(model).arg(prompt);
            cmd
        }
        "codex-cli" => {
            let executable =
                std::env::var("OPENPENCIL_CODEX_PATH").unwrap_or_else(|_| "codex".to_string());
            let mut cmd = Command::new(executable);
            cmd.arg("exec");
            if resume_session {
                cmd.arg("resume").arg("--last");
            }
            cmd.arg("--skip-git-repo-check")
                .arg("--dangerously-bypass-approvals-and-sandbox")
                .arg("--json");
            if !resume_session {
                cmd.arg("--progress-cursor");
            }
            cmd.arg("--model").arg(model).arg(prompt);
            cmd
        }
        _ => return Err(format!("Unsupported local CLI backend: {backend}")),
    };

    command.env("NO_COLOR", "1");
    if let Some(token) = automation_token {
        command.env(
            "OPENPENCIL_AUTOMATION_URL",
            format!("http://127.0.0.1:{AUTOMATION_HTTP_PORT}"),
        );
        command.env("OPENPENCIL_AUTOMATION_TOKEN", token);
    }
    command.env("OPENPENCIL_WORKSPACE_ROOT", workspace_root);
    Ok(command)
}

fn terminate_process(pid: u32) -> Result<bool, String> {
    #[cfg(unix)]
    {
        let result = unsafe { libc::kill(pid as i32, libc::SIGTERM) };
        if result == 0 {
            return Ok(true);
        }
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            return Ok(false);
        }
        return Err(format!("Failed to terminate process {pid}: {error}"));
    }

    #[cfg(windows)]
    {
        let status = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status()
            .map_err(|e| format!("Failed to terminate process {pid}: {e}"))?;
        return Ok(status.success());
    }

    #[allow(unreachable_code)]
    Ok(false)
}

fn map_cli_spawn_error(backend: &str, error: std::io::Error) -> String {
    if error.kind() != std::io::ErrorKind::NotFound {
        return format!("Failed to start local CLI backend: {error}");
    }

    match backend {
        "claude-code" => {
            "Claude Code CLI was not found. Install `claude` or set OPENPENCIL_CLAUDE_PATH."
                .to_string()
        }
        "codex-cli" => {
            "Codex CLI was not found. Install `codex` or set OPENPENCIL_CODEX_PATH.".to_string()
        }
        _ => format!("Failed to start local CLI backend: {error}"),
    }
}

fn run_agent_cli_blocking<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    request: RunAgentCliRequest,
    cli_state: SharedCliProcessState,
    bridge_state: SharedAutomationBridgeState,
) -> Result<RunAgentCliResponse, String> {
    let workdir = build_agent_cli_workdir(
        &request.backend,
        &request.session_id,
        &request.prompt,
        &request.attachments,
    )?;
    let automation_token = if request.mode == "direct" {
        wait_for_automation_token(&bridge_state, AUTOMATION_BRIDGE_WAIT_TIMEOUT)
    } else {
        bridge_state
            .auth_token
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    };

    let mut command = match build_agent_cli_command(
        &request.backend,
        &request.model,
        &request.mode,
        request.resume_session,
        automation_token.as_deref(),
    ) {
        Ok(command) => command,
        Err(error) => return Err(error),
    };
    command
        .current_dir(&workdir.dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("OPENPENCIL_TOOL_LOG", &workdir.tool_log_path);

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => return Err(map_cli_spawn_error(&request.backend, error)),
    };
    let stdout_reader = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            let _ = child.kill();
            return Err("Local CLI backend did not provide stdout".to_string());
        }
    };
    let stderr_reader = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            let _ = child.kill();
            return Err("Local CLI backend did not provide stderr".to_string());
        }
    };
    let pid = child.id();
    cli_state
        .running
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(request.request_id.clone(), pid);

    let (output_sender, output_receiver) = mpsc::channel();
    let stdout_thread = spawn_cli_output_reader(stdout_reader, true, output_sender.clone());
    let stderr_thread = spawn_cli_output_reader(stderr_reader, false, output_sender);
    let mut stdout = String::new();
    let mut stderr = String::new();
    let mut emitted_tool_logs = 0;

    let exit_status = loop {
        drain_cli_output_chunks(
            &app,
            &request.request_id,
            &output_receiver,
            &mut stdout,
            &mut stderr,
        );
        let _ = emit_pending_tool_logs(
            &app,
            &request.request_id,
            &workdir.tool_log_path,
            &mut emitted_tool_logs,
        );

        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => std::thread::sleep(Duration::from_millis(40)),
            Err(error) => {
                cli_state
                    .running
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(&request.request_id);
                return Err(format!("Failed while waiting for local CLI backend: {error}"));
            }
        }
    };

    let _ = stdout_thread.join();
    let _ = stderr_thread.join();
    drain_cli_output_chunks(
        &app,
        &request.request_id,
        &output_receiver,
        &mut stdout,
        &mut stderr,
    );

    cli_state
        .running
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&request.request_id);

    let tool_logs = emit_pending_tool_logs(
        &app,
        &request.request_id,
        &workdir.tool_log_path,
        &mut emitted_tool_logs,
    );

    Ok(RunAgentCliResponse {
        stdout,
        stderr,
        exit_code: exit_status.code().unwrap_or(-1),
        tool_logs,
    })
}

#[tauri::command]
fn register_automation_bridge(
    token: String,
    bridge_state: tauri::State<'_, SharedAutomationBridgeState>,
) {
    reject_pending_requests(bridge_state.inner(), "Browser reconnected");
    *bridge_state
        .auth_token
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = Some(token);
}

#[tauri::command]
fn unregister_automation_bridge(bridge_state: tauri::State<'_, SharedAutomationBridgeState>) {
    *bridge_state
        .auth_token
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = None;
    reject_pending_requests(bridge_state.inner(), "Browser disconnected");
}

#[tauri::command]
fn automation_bridge_respond(
    id: String,
    response: serde_json::Value,
    bridge_state: tauri::State<'_, SharedAutomationBridgeState>,
) {
    let sender = bridge_state
        .pending
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&id);
    if let Some(sender) = sender {
        let _ = sender.send(response);
    }
}

#[tauri::command]
fn cancel_agent_cli(
    request_id: String,
    cli_state: tauri::State<'_, SharedCliProcessState>,
) -> Result<bool, String> {
    let pid = cli_state
        .running
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&request_id)
        .copied();
    let Some(pid) = pid else {
        return Ok(false);
    };

    terminate_process(pid)
}

#[tauri::command]
fn clear_agent_cli_session(backend: String, session_id: String) -> Result<(), String> {
    let session_dir = resolve_agent_cli_session_dir(&backend, &session_id);
    if !session_dir.exists() {
        return Ok(());
    }

    fs::remove_dir_all(&session_dir)
        .map_err(|e| format!("Failed to remove CLI session directory: {e}"))
}

#[tauri::command]
fn set_recent_files_menu(
    app: tauri::AppHandle,
    recent_menu_state: tauri::State<'_, SharedRecentFilesMenuState>,
    items: Vec<RecentFileMenuEntry>,
) -> Result<(), String> {
    let submenu = recent_menu_state
        .submenu
        .lock()
        .map_err(|_| "Failed to lock recent files submenu state".to_string())?
        .clone();

    let Some(submenu) = submenu else {
        return Ok(());
    };

    let mut current_items = recent_menu_state
        .items
        .lock()
        .map_err(|_| "Failed to lock recent files menu items".to_string())?;

    for item in current_items.drain(..) {
        submenu.remove(&item).map_err(|e| e.to_string())?;
    }

    if items.is_empty() {
        submenu.set_enabled(false).map_err(|e| e.to_string())?;
        return Ok(());
    }

    for (index, item) in items.into_iter().enumerate() {
        let menu_item = MenuItemBuilder::new(item.label)
            .id(format!("open-recent-{index}"))
            .build(&app)
            .map_err(|e| e.to_string())?;
        submenu.append(&menu_item).map_err(|e| e.to_string())?;
        current_items.push(menu_item);
    }

    submenu.set_enabled(true).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn run_agent_cli(
    app: tauri::AppHandle,
    request: RunAgentCliRequest,
    cli_state: tauri::State<'_, SharedCliProcessState>,
    bridge_state: tauri::State<'_, SharedAutomationBridgeState>,
) -> Result<RunAgentCliResponse, String> {
    let app = app.clone();
    let cli_state = cli_state.inner().clone();
    let bridge_state = bridge_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        run_agent_cli_blocking(app, request, cli_state, bridge_state)
    })
        .await
        .map_err(|e| format!("Agent CLI task failed: {e}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Arc::new(AutomationBridgeState::default()))
        .manage(Arc::new(CliProcessState::default()))
        .manage(Arc::new(RecentFilesMenuState::default()))
        .invoke_handler(tauri::generate_handler![
            build_fig_file,
            list_system_fonts,
            load_system_font,
            register_automation_bridge,
            unregister_automation_bridge,
            automation_bridge_respond,
            run_agent_cli,
            cancel_agent_cli,
            clear_agent_cli_session,
            set_recent_files_menu
        ])
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .on_menu_event(|app, event| {
            #[cfg(debug_assertions)]
            if event.id().0.as_str() == "dev-tools" {
                if let Some(window) = app.get_webview_window("main") {
                    if window.is_devtools_open() {
                        window.close_devtools();
                    } else {
                        window.open_devtools();
                    }
                }
                return;
            }
            let _ = app.emit("menu-event", event.id().0.as_str());
        })
        .setup(|app| {
            let bridge_state = app.state::<SharedAutomationBridgeState>().inner().clone();
            start_automation_bridge(app.handle().clone(), bridge_state);

            #[cfg(target_os = "macos")]
            let app_menu = SubmenuBuilder::new(app, "OpenPencil")
                .item(&PredefinedMenuItem::about(
                    app,
                    Some("About OpenPencil"),
                    None,
                )?)
                .separator()
                .item(&PredefinedMenuItem::services(app, None)?)
                .separator()
                .item(&PredefinedMenuItem::hide(app, None)?)
                .item(&PredefinedMenuItem::hide_others(app, None)?)
                .item(&PredefinedMenuItem::show_all(app, None)?)
                .separator()
                .item(&PredefinedMenuItem::quit(app, None)?)
                .build()?;

            let recent_menu = SubmenuBuilder::new(app, "Open Recent")
                .id("open-recent-menu")
                .enabled(false)
                .build()?;
            {
                let recent_menu_state = app.state::<SharedRecentFilesMenuState>();
                *recent_menu_state
                    .submenu
                    .lock()
                    .expect("recent files submenu state poisoned") = Some(recent_menu.clone());
            }

            #[allow(unused_mut)]
            let mut file_menu_builder = SubmenuBuilder::new(app, "File")
                .item(
                    &MenuItemBuilder::new("New")
                        .id("new")
                        .accelerator("CmdOrCtrl+N")
                        .build(app)?,
                )
                .item(
                    &MenuItemBuilder::new("Open…")
                        .id("open")
                        .accelerator("CmdOrCtrl+O")
                        .build(app)?,
                )
                .item(&recent_menu)
                .separator()
                .item(
                    &MenuItemBuilder::new("Save")
                        .id("save")
                        .accelerator("CmdOrCtrl+S")
                        .build(app)?,
                )
                .item(
                    &MenuItemBuilder::new("Save As…")
                        .id("save-as")
                        .accelerator("CmdOrCtrl+Shift+S")
                        .build(app)?,
                )
                .separator()
                .item(
                    &MenuItemBuilder::new("Export…")
                        .id("export")
                        .accelerator("CmdOrCtrl+Shift+E")
                        .build(app)?,
                )
                .separator()
                .item(
                    &MenuItemBuilder::new("Close Tab")
                        .id("close")
                        .accelerator("CmdOrCtrl+W")
                        .build(app)?,
                );
            #[cfg(not(target_os = "macos"))]
            {
                file_menu_builder = file_menu_builder
                    .separator()
                    .item(&PredefinedMenuItem::quit(app, None)?);
            }
            let file_menu = file_menu_builder.build()?;

            let edit_menu = SubmenuBuilder::new(app, "Edit")
                .item(&PredefinedMenuItem::undo(app, None)?)
                .item(&PredefinedMenuItem::redo(app, None)?)
                .separator()
                .item(&PredefinedMenuItem::cut(app, None)?)
                .item(&PredefinedMenuItem::copy(app, None)?)
                .item(&PredefinedMenuItem::paste(app, None)?)
                .item(
                    &MenuItemBuilder::new("Paste in Place")
                        .id("paste-in-place")
                        .accelerator("CmdOrCtrl+Shift+V")
                        .build(app)?,
                )
                .item(&PredefinedMenuItem::select_all(app, None)?)
                .separator()
                .item(
                    &MenuItemBuilder::new("Duplicate")
                        .id("duplicate")
                        .accelerator("CmdOrCtrl+D")
                        .build(app)?,
                )
                .item(
                    &MenuItemBuilder::new("Delete")
                        .id("delete")
                        .accelerator("Backspace")
                        .build(app)?,
                )
                .build()?;

            let view_menu = SubmenuBuilder::new(app, "View")
                .item(
                    &MenuItemBuilder::new("Zoom In")
                        .id("zoom-in")
                        .accelerator("CmdOrCtrl+=")
                        .build(app)?,
                )
                .item(
                    &MenuItemBuilder::new("Zoom Out")
                        .id("zoom-out")
                        .accelerator("CmdOrCtrl+-")
                        .build(app)?,
                )
                .item(
                    &MenuItemBuilder::new("Zoom to Fit")
                        .id("zoom-fit")
                        .accelerator("CmdOrCtrl+1")
                        .build(app)?,
                )
                .item(
                    &MenuItemBuilder::new("Zoom to 100%")
                        .id("zoom-100")
                        .accelerator("CmdOrCtrl+0")
                        .build(app)?,
                )
                .separator()
                .item(
                    &MenuItemBuilder::new("Toggle Rulers")
                        .id("toggle-rulers")
                        .accelerator("Shift+R")
                        .build(app)?,
                )
                .item(
                    &MenuItemBuilder::new("Toggle Grid")
                        .id("toggle-grid")
                        .accelerator("CmdOrCtrl+'")
                        .build(app)?,
                )
                .separator()
                .item(
                    &MenuItemBuilder::new("Toggle UI")
                        .id("toggle-ui")
                        .accelerator("CmdOrCtrl+\\")
                        .build(app)?,
                )
                .item(&PredefinedMenuItem::fullscreen(app, None)?)
                .separator()
                .item(
                    &MenuItemBuilder::new("Developer Tools")
                        .id("dev-tools")
                        .accelerator("CmdOrCtrl+Alt+I")
                        .build(app)?,
                )
                .build()?;

            let object_menu = SubmenuBuilder::new(app, "Object")
                .item(
                    &MenuItemBuilder::new("Group Selection")
                        .id("group")
                        .accelerator("CmdOrCtrl+G")
                        .build(app)?,
                )
                .item(
                    &MenuItemBuilder::new("Ungroup Selection")
                        .id("ungroup")
                        .accelerator("CmdOrCtrl+Shift+G")
                        .build(app)?,
                )
                .item(
                    &MenuItemBuilder::new("Frame Selection")
                        .id("frame-selection")
                        .accelerator("CmdOrCtrl+Alt+G")
                        .build(app)?,
                )
                .separator()
                .item(
                    &MenuItemBuilder::new("Bring to Front")
                        .id("bring-front")
                        .accelerator("CmdOrCtrl+]")
                        .build(app)?,
                )
                .item(
                    &MenuItemBuilder::new("Send to Back")
                        .id("send-back")
                        .accelerator("CmdOrCtrl+[")
                        .build(app)?,
                )
                .separator()
                .item(
                    &MenuItemBuilder::new("Flip Horizontal")
                        .id("flip-h")
                        .accelerator("Shift+H")
                        .build(app)?,
                )
                .item(
                    &MenuItemBuilder::new("Flip Vertical")
                        .id("flip-v")
                        .accelerator("Shift+V")
                        .build(app)?,
                )
                .build()?;

            let window_menu = SubmenuBuilder::new(app, "Window")
                .item(&PredefinedMenuItem::minimize(app, None)?)
                .item(&PredefinedMenuItem::maximize(app, None)?)
                .separator()
                .item(&PredefinedMenuItem::close_window(app, None)?)
                .build()?;

            #[allow(unused_mut)]
            let mut help_menu_builder = SubmenuBuilder::new(app, "Help").item(
                &MenuItemBuilder::new("Keyboard Shortcuts")
                    .id("shortcuts")
                    .accelerator("CmdOrCtrl+/")
                    .build(app)?,
            );
            #[cfg(not(target_os = "macos"))]
            {
                help_menu_builder = help_menu_builder
                    .separator()
                    .item(&PredefinedMenuItem::about(
                        app,
                        Some("About OpenPencil"),
                        None,
                    )?);
            }
            let help_menu = help_menu_builder.build()?;

            let mut builder = MenuBuilder::new(app);
            #[cfg(target_os = "macos")]
            {
                builder = builder.item(&app_menu);
            }
            let menu = builder
                .items(&[
                    &file_menu,
                    &edit_menu,
                    &view_menu,
                    &object_menu,
                    &window_menu,
                    &help_menu,
                ])
                .build()?;

            app.set_menu(menu)?;

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen {
                has_visible_windows,
                ..
            } = event
            {
                if !has_visible_windows {
                    show_main_window(app);
                }
            }
        });
}
