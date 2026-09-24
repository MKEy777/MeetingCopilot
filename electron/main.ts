/**
 * MeetingCopilot main process: overlay window, stealth, hotkeys,
 * settings, IPC hub, ASR worker host. PLAN.en.md §5.
 */
import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  safeStorage,
  screen,
  session,
  shell,
  type OpenDialogOptions,
} from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { release } from 'os';
import { join } from 'path';
import {
  captureKindForPlatform,
  whisperExecutionProvidersForPlatform,
} from '../shared/platform';
import { APP_DISPLAY_NAME, LEGACY_USER_DATA_DIR_NAME } from '../shared/appIdentity';
import { AsrHost } from './asrHost';
import {
  LocalPythonProbe,
  buildDiagnosticsReport,
  recentDiagnosticErrors,
  recordDiagnosticError,
} from './diagnostics';
import { openExternalUrl } from './externalLinks';
import { FunasrSidecar, parseLocalWsPort, pythonCandidates, resolvePython } from './funasrSidecar';
import { resolveTestApiKey, runProviderTest, withoutCandidateKey } from './providerTest';
import { getResourceRoot } from './resourcePaths';
import { SettingsStore, plainCipher, type SecretCipher } from './settings';
import { SETUP_READY_MARKER, createSetupWindow } from './setupWindow';
import { AppTray, trayIconPath } from './tray';
import { isRendererCommand, type TrayCommand, type TrayMenuState } from '../shared/trayMenu';
import { KnowledgeStore } from './knowledge';
import { SessionStore } from './sessions';
import { describeNativeWindowMessage } from './uiDebug';
import { MousePassthroughHost } from './mousePassthrough';
import { pointInWindow } from '../shared/passthroughMouse';
import { DOC_EXTENSIONS, extractDocText } from './docparse';
import { basename } from 'path';
import { chatOnce, chatStream, type ChatResult } from './llm/adapter';
import { visionChat } from './llm/vision';
import {
  buildAnswerMessages,
  buildMemoUpdateMessages,
  buildPrewarmMessages,
  buildStablePrefix,
  buildTranslateMessages,
  buildVisionMessages,
  clampMemo,
} from './llm/prompts';
import type { AppInfo, PublicSettings, UiLang } from '../shared/protocol';
import {
  IPC,
  type AsrEvent,
  type LlmAskPayload,
  type LlmEvent,
  type OnboardingCompletePayload,
  type OnboardingProgressPatch,
  type ProviderTestRequest,
  type ProviderTestResult,
  type SettingsPatch,
  type UiInputDebugEvent,
} from '../shared/protocol';
import { mainStrings } from './uiStrings';

const MODEL_ID = 'onnx-community/whisper-large-v3-turbo-ONNX';

/** tray 「检查更新」 (Phase 4). A real updater is Phase 5; until then the honest
 * answer is the releases page, opened through the same allowlist as every other
 * documentation link. */
const RELEASES_URL = 'https://github.com/JWM0203/MeetingCopilot/releases/latest';

/** Capture the primary display as a complete image for screenshot Q&A. The
 * caller chooses the primary source explicitly so multi-monitor setups do not
 * depend on the order returned by desktopCapturer. */
async function capturePrimaryScreenDataUrl(): Promise<string> {
  const display = screen.getPrimaryDisplay();
  const scale = display.scaleFactor;
  const maxWidth = 1920;
  const nativeWidth = display.size.width * scale;
  const resize = Math.min(1, maxWidth / Math.max(1, nativeWidth));
  const thumbnailSize = {
    width: Math.max(1, Math.round(nativeWidth * resize)),
    height: Math.max(1, Math.round(display.size.height * scale * resize)),
  };
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize });
  const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
  if (!source) throw new Error('no screen source available');
  return source.thumbnail.toDataURL();
}

app.setName(APP_DISPLAY_NAME);

// E2E/demo hook: run against an isolated profile — must precede the
// single-instance lock so a test instance never collides with a real one
if (process.env.MC_USERDATA) {
  app.setPath('userData', process.env.MC_USERDATA);
} else {
  // Keep the existing profile after changing the display name. This preserves
  // API keys, imported materials and sessions created by older builds.
  app.setPath('userData', join(app.getPath('appData'), LEGACY_USER_DATA_DIR_NAME));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  bootstrap();
}

function bootstrap(): void {
  let win: BrowserWindow | null = null;
  /** first-run wizard window; mutually exclusive with `win` until completion */
  let setupWin: BrowserWindow | null = null;
  /** the wizard was reopened from a running main window (设置 → 重新运行配置
   * 向导 / the upgrade notice). Re-run mode never quits the app. */
  let setupRerun = false;
  let settings: SettingsStore;
  let knowledge: KnowledgeStore;
  let sessionStore: SessionStore;
  let osLang: UiLang = 'zh';
  /** set by before-quit so window handlers stop prompting mid-shutdown */
  let quitting = false;
  /** an ASR-affecting settings patch arrived while the wizard owned the flow */
  let pendingAsrRestart = false;
  /** renderer capture lifecycle; the tray menu and the diagnostics report read it */
  let capturing = false;
  const asr = new AsrHost();
  const sidecar = new FunasrSidecar();
  const tray = new AppTray();
  const mousePassthroughHost = new MousePassthroughHost();
  let mousePassthrough = false;
  let passthroughCursorInside = false;
  let passthroughDownDelivery: Promise<unknown> = Promise.resolve();
  let passthroughWindowDrag: { x: number; y: number } | null = null;
  let passthroughLockedSize: { width: number; height: number } | null = null;
  let passthroughRestoringSize = false;

  function logPassthroughWindow(event: string, details: Record<string, unknown> = {}): void {
    if (!win || win.isDestroyed()) return;
    console.log('[mouse-passthrough] window', JSON.stringify({
      at: new Date().toISOString(), event, enabled: mousePassthrough,
      bounds: win.getBounds(), resizable: win.isResizable(),
      dragging: passthroughWindowDrag !== null, ...details,
    }));
  }

  /** main-process strings in the current UI language */
  const T = () => mainStrings(settings.data.ui.lang, osLang);

  /** getPublic() + real knowledge char count (KB lives outside settings.json) */
  function publicSettings(): PublicSettings {
    const pub = settings.getPublic();
    pub.knowledge = { chars: knowledge.chars };
    return pub;
  }

  function buildAsrOptions() {
    const a = settings.data.asr;
    const backend = a.backend ?? 'local';
    // each backend has its own config slot so switching never clobbers the others
    let cloud: { baseUrl: string; model: string; apiKey: string } | undefined;
    if (backend === 'local-realtime') {
      // fixed localhost sidecar (auto-spawned); only the model is a choice
      cloud = {
        baseUrl: 'ws://127.0.0.1:10097',
        model: a.localRealtime?.model ?? 'fun-asr-nano',
        apiKey: '',
      };
    } else if (backend === 'cloud-realtime') {
      const rtKey = settings.getRealtimeAsrApiKey() ?? '';
      if (a.realtime?.baseUrl && a.realtime?.model && rtKey) {
        cloud = { baseUrl: a.realtime.baseUrl, model: a.realtime.model, apiKey: rtKey };
      }
    } else if (a.cloud?.baseUrl && a.cloud?.model && settings.getCloudAsrApiKey()) {
      cloud = { baseUrl: a.cloud.baseUrl, model: a.cloud.model, apiKey: settings.getCloudAsrApiKey()! };
    }
    return {
      // the worker treats both realtime flavors identically (same WS engine)
      backend: (backend === 'local-realtime' ? 'cloud-realtime' : backend) as
        | 'local'
        | 'cloud'
        | 'cloud-realtime',
      modelsDir: a.modelsDir ?? join(app.getPath('userData'), 'models'),
      modelId: MODEL_ID,
      ep: whisperExecutionProvidersForPlatform(process.platform),
      language: a.language,
      cloud,
    };
  }

  /** start the ASR worker; a local ws:// realtime backend auto-spawns the
   * python sidecar first (selecting the preset is all the user does) */
  async function startAsr(): Promise<void> {
    const opts = buildAsrOptions();
    const port = opts.backend === 'cloud-realtime' ? parseLocalWsPort(opts.cloud?.baseUrl) : null;
    if (port) {
      try {
        // NOT app.getAppPath(): packaged that resolves inside app.asar, which
        // python cannot read and the OS cannot use as a spawn cwd
        await sidecar.ensureRunning(port, getResourceRoot(), opts.cloud?.model);
        console.log(`[sidecar] local ASR ready on :${port}`);
      } catch (e) {
        const message = T().sidecarFail((e as Error).message);
        console.error(`[sidecar] ${message}`);
        recordDiagnosticError('sidecar', (e as Error).message);
        win?.webContents.send(IPC.asrEvent, { kind: 'error', message, fatal: true });
        return;
      }
    } else {
      await sidecar.stop(); // switched away from local — reclaim its RAM/VRAM
    }
    asr.start(opts);
  }

  const safeCipher: SecretCipher = {
    available: () => safeStorage.isEncryptionAvailable(),
    secure: true,
    encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
    decrypt: (b64) => safeStorage.decryptString(Buffer.from(b64, 'base64')),
  };

  function cipher(): SecretCipher {
    if (safeCipher.available()) return safeCipher;
    console.warn('[security] OS secret storage unavailable; API keys will only be obfuscated');
    return plainCipher;
  }

  // ---- window visibility + system tray ----------------------------------
  // Quit/hide matrix (Phase 4):
  //   hide  (show/hide hotkey / 「—」 / tray toggle) -> window stays alive, app keeps
  //         running, tray is the way back; NEVER quits.
  //   quit  (quit hotkey / titlebar ✕ / tray 退出 / OS shutdown) -> app.quit() -> before-quit
  //         reaps the ASR utilityProcess, the python sidecar and the tray.
  //   first-run wizard closed without completing -> app.quit() (Phase 2), since
  //         nothing is configured and no main window exists yet.
  //   re-run wizard closed -> main window keeps running; window-all-closed does
  //         not fire because the overlay is still open (possibly hidden).

  function showWindow(): void {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.showInactive();
  }

  function disableMousePassthrough(failed = false): void {
    const wasEnabled = mousePassthrough;
    if (wasEnabled) logPassthroughWindow('disable', { failed, lockedSize: passthroughLockedSize });
    mousePassthrough = false;
    passthroughCursorInside = false;
    passthroughWindowDrag = null;
    passthroughLockedSize = null;
    mousePassthroughHost.stop();
    if (wasEnabled && win && !win.isDestroyed()) {
      win.setIgnoreMouseEvents(false);
      win.setResizable(true);
      win.webContents.send(IPC.mousePassthroughState, { enabled: false, failed });
    }
  }

  async function setMousePassthrough(on: boolean): Promise<boolean> {
    if (!on) {
      disableMousePassthrough();
      return false;
    }
    if (mousePassthrough) return true;
    if (process.platform !== 'win32' || !win || win.isDestroyed()) return false;

    await mousePassthroughHost.start((event) => {
      const target = win;
      if (!mousePassthrough || !target || target.isDestroyed() || !target.isVisible()) return;
      const point = screen.screenToDipPoint({ x: event.x, y: event.y });
      if (event.type === 'move' && passthroughWindowDrag) {
        const before = target.getBounds();
        const size = passthroughLockedSize ?? before;
        target.setBounds({
          x: Math.round(point.x - passthroughWindowDrag.x),
          y: Math.round(point.y - passthroughWindowDrag.y),
          width: size.width,
          height: size.height,
        }, false);
        const after = target.getBounds();
        if (after.width !== before.width || after.height !== before.height) {
          logPassthroughWindow('drag-position-size-changed', { point, before, after });
        }
      }
      if (event.type === 'up' && passthroughWindowDrag) {
        logPassthroughWindow('drag-end', { point });
        passthroughWindowDrag = null;
      }
      const bounds = target.getBounds();
      const inside = pointInWindow(point, bounds);
      if (event.type === 'wheel' && !inside) return;
      if (event.type === 'move') {
        if (!inside && !passthroughCursorInside) return;
        passthroughCursorInside = inside;
      }
      const localEvent = {
        ...event,
        x: point.x - bounds.x,
        y: point.y - bounds.y,
      };
      if (event.type === 'down' || event.type === 'up') {
        logPassthroughWindow(`mouse-${event.type}`, { point, inside, localEvent });
      }
      const deliver = () => target.webContents.executeJavaScript(
        `(() => { const handler = window.__mcHandlePassthroughMouse; if (typeof handler !== 'function') return false; handler(${JSON.stringify(localEvent)}); return true; })()`,
        event.type === 'up',
      ).then((handled) => {
        logPassthroughWindow(`mouse-${event.type}-delivered`, { handled, point });
      });
      if (event.type === 'down') {
        // Keep down/up ordered even when the two native messages arrive faster
        // than Chromium can run the first injected handler.
        passthroughDownDelivery = deliver().catch((error) =>
          console.warn('[mouse-passthrough] press delivery failed:', (error as Error).message));
      } else if (event.type === 'up') {
        // Preserve Chromium's user-gesture context for controls that open
        // browser permission prompts, file pickers, or display capture.
        void passthroughDownDelivery.then(deliver)
          .catch((error) => console.warn('[mouse-passthrough] click delivery failed:', (error as Error).message));
      } else {
        target.webContents.send(IPC.mousePassthroughEvent, localEvent);
      }
    }, () => {
      disableMousePassthrough(true);
    });
    if (!win || win.isDestroyed()) {
      mousePassthroughHost.stop();
      return false;
    }
    mousePassthrough = true;
    try {
      // Lock the window size while mouse input passes through it. The global
      // mouse path still lets the user move it by dragging the title bar.
      win.setResizable(false);
      win.setIgnoreMouseEvents(true, { forward: true });
      const { width, height } = win.getBounds();
      passthroughLockedSize = { width, height };
      logPassthroughWindow('enabled', { lockedSize: passthroughLockedSize });
    } catch (error) {
      disableMousePassthrough();
      throw error;
    }
    win.webContents.send(IPC.mousePassthroughState, { enabled: true });
    return true;
  }

  function logUiWindowState(event: string): void {
    if (!win || win.isDestroyed()) return;
    console.log('[ui-debug] window', JSON.stringify({
      at: new Date().toISOString(),
      event,
      focusable: win.isFocusable(),
      focused: win.isFocused(),
      visible: win.isVisible(),
    }));
  }

  function toggleWindow(): void {
    if (!win) return;
    if (win.isVisible()) win.hide();
    else showWindow();
  }

  function trayState(): TrayMenuState {
    return { windowVisible: !!win?.isVisible(), capturing };
  }

  /** rebuild the tray menu — call after anything the menu shows has changed */
  function refreshTray(): void {
    tray.refresh();
  }

  function handleTrayCommand(command: TrayCommand): void {
    if (command === 'quit') {
      app.quit();
      return;
    }
    if (command === 'toggle-window') {
      toggleWindow();
      return;
    }
    if (command === 'check-updates') {
      void openExternalUrl(RELEASES_URL);
      return;
    }
    if (isRendererCommand(command)) {
      // capture, sessions and the panels live in the renderer; a hidden window
      // would swallow the result, so make it visible first
      showWindow();
      win?.webContents.send(IPC.trayCommand, { command });
    }
  }

  function ensureTray(): void {
    if (tray.exists) return;
    tray.create({
      iconPath: trayIconPath(getResourceRoot()),
      labels: () => T().tray,
      state: trayState,
      onCommand: handleTrayCommand,
      onClick: toggleWindow,
      onDoubleClick: showWindow,
    });
  }

  /** one-shot balloon the first time the window disappears (spec §A) */
  function noticeWindowHidden(): void {
    if (!tray.exists || settings.data.ui.trayNoticeShown) return;
    settings.applyPatch({ ui: { trayNoticeShown: true } });
    const t = T();
    tray.notifyHidden(t.trayNoticeTitle, t.trayNoticeBody);
    console.log('[tray] hide notice shown once');
  }

  /**
   * 开机自动启动. Deliberately inert in development: `setLoginItemSettings`
   * would register the electron.exe dev launcher (and on Linux Electron does
   * not implement it at all), so the stored intent is kept and applied by the
   * installed build instead.
   */
  function applyAutoLaunch(enabled: boolean): void {
    if (process.platform === 'linux') return;
    if (!app.isPackaged) {
      console.log(`[autolaunch] ${enabled ? 'on' : 'off'} stored; not applied in a dev build`);
      return;
    }
    try {
      app.setLoginItemSettings({ openAtLogin: enabled });
    } catch (e) {
      console.warn('[autolaunch] could not be applied:', (e as Error).message);
    }
  }

  /** the OS is the source of truth; reconcile it with the stored intent once */
  function syncAutoLaunch(): void {
    if (process.platform === 'linux' || !app.isPackaged) return;
    const wanted = !!settings.data.ui.autoLaunch;
    try {
      if (app.getLoginItemSettings().openAtLogin !== wanted) applyAutoLaunch(wanted);
    } catch (e) {
      console.warn('[autolaunch] could not be read:', (e as Error).message);
    }
  }

  function registerHotkeys(): void {
    globalShortcut.unregisterAll();
    const toggle = settings.data.ui.hotkeyToggle;
    const shot = settings.data.ui.hotkeyShot;
    const quit = settings.data.ui.hotkeyQuit;
    try {
      if (toggle) {
        const ok = globalShortcut.register(toggle, () => toggleWindow());
        if (!ok) console.warn(`[main] hotkey ${toggle} registration failed (in use?)`);
      }
      if (shot) {
        const ok = globalShortcut.register(shot, () => win?.webContents.send(IPC.shotHotkey));
        if (!ok) console.warn(`[main] shot hotkey ${shot} registration failed (in use?)`);
      }
      if (quit) {
        const ok = globalShortcut.register(quit, () => app.quit());
        if (!ok) console.warn(`[main] quit hotkey ${quit} registration failed (in use?)`);
      }
    } catch (e) {
      console.warn('[main] hotkey register error:', (e as Error).message);
    }
  }

  function createWindow(): void {
    win = new BrowserWindow({
      width: 940,
      height: 560,
      minWidth: 640,
      minHeight: 380,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      show: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      resizable: true,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    // The copilot is an overlay during a presentation. Keep the presentation
    // window as the OS foreground window even when the overlay is clicked.
    // Renderer text controls temporarily opt back into focus through IPC.
    win.setFocusable(false);
    win.on('will-resize', (event, newBounds) => {
      if (!mousePassthrough) return;
      logPassthroughWindow('will-resize', { newBounds, lockedSize: passthroughLockedSize });
      event.preventDefault();
    });
    win.on('resize', () => {
      if (!mousePassthrough || !passthroughLockedSize || passthroughRestoringSize) return;
      const bounds = win?.getBounds();
      if (!bounds) return;
      logPassthroughWindow('resized', { lockedSize: passthroughLockedSize });
      if (bounds.width === passthroughLockedSize.width && bounds.height === passthroughLockedSize.height) return;
      passthroughRestoringSize = true;
      try {
        win?.setBounds({ ...bounds, ...passthroughLockedSize }, false);
        logPassthroughWindow('size-restored', { lockedSize: passthroughLockedSize });
      } finally {
        passthroughRestoringSize = false;
      }
    });
    win.on('move', () => {
      if (!mousePassthrough || !passthroughLockedSize) return;
      const bounds = win?.getBounds();
      if (bounds && (bounds.width !== passthroughLockedSize.width || bounds.height !== passthroughLockedSize.height)) {
        logPassthroughWindow('moved-with-size-change', { lockedSize: passthroughLockedSize });
      }
    });
    logUiWindowState('created');
    win.on('focus', () => logUiWindowState('focus'));
    win.on('blur', () => logUiWindowState('blur'));
    win.on('show', () => logUiWindowState('show'));
    win.on('hide', () => logUiWindowState('hide'));
    if (process.platform === 'win32') {
      const nativeMessages = new Map<number, string>([
        [0x0021, 'WM_MOUSEACTIVATE'],
        [0x0006, 'WM_ACTIVATE'],
        [0x0007, 'WM_SETFOCUS'],
        [0x0008, 'WM_KILLFOCUS'],
        [0x0201, 'WM_LBUTTONDOWN'],
        [0x0202, 'WM_LBUTTONUP'],
      ]);
      for (const [messageId, message] of nativeMessages) {
        try {
          win.hookWindowMessage(messageId, (wParam, lParam) => {
            if (!win || win.isDestroyed()) return;
            const details = describeNativeWindowMessage(message, messageId, wParam, lParam);
            console.log('[ui-debug] native-message', JSON.stringify({
              at: new Date().toISOString(),
              ...details,
              focusable: win.isFocusable(),
              focused: win.isFocused(),
              visible: win.isVisible(),
            }));
            if (
              messageId === 0x0021 &&
              details.hitTest === 1 &&
              details.inputMessage === 0x0201
            ) {
              win.webContents.send(IPC.uiNativeMouseActivation, { at: Date.now() });
            }
          });
        } catch (error) {
          console.warn('[ui-debug] native-message-hook-failed', JSON.stringify({
            at: new Date().toISOString(),
            message,
            error: (error as Error).message,
          }));
        }
      }
    }
    win.webContents.on('unresponsive', () => {
      console.error('[ui-debug] renderer-unresponsive', JSON.stringify({
        at: new Date().toISOString(),
        url: win?.webContents.getURL(),
      }));
    });
    win.webContents.on('responsive', () => {
      console.log('[ui-debug] renderer-responsive', JSON.stringify({
        at: new Date().toISOString(),
        url: win?.webContents.getURL(),
      }));
    });
    win.webContents.on('render-process-gone', (_event, details) => {
      console.error('[ui-debug] renderer-gone', JSON.stringify({
        at: new Date().toISOString(),
        reason: details.reason,
        exitCode: details.exitCode,
      }));
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setContentProtection(settings.data.ui.stealth);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());

    win.webContents.on('did-finish-load', () => {
      // Showing an overlay must not activate it or move focus away from the
      // presentation window that is currently receiving keyboard input.
      win?.showInactive();
      // replay cached ASR state for late-attaching renderer
      if (asr.lastReady) win?.webContents.send(IPC.asrEvent, asr.lastReady);
      if (asr.lastStatus) win?.webContents.send(IPC.asrEvent, asr.lastStatus);
      if (process.env.MC_AUTOSTART === '1') {
        // executeJavaScript(code, true) supplies the user gesture that
        // getDisplayMedia needs — used by the E2E smoke test.
        void win?.webContents.executeJavaScript(
          'window.__mcAutoStart && window.__mcAutoStart()',
          true,
        );
      }
      // E2E: exercise the FULL renderer->IPC->main->LLM->stream->renderer path.
      if (process.env.MC_E2E_LLM) {
        const q = process.env.MC_E2E_LLM;
        const js = `(async()=>{const d=[];const done=new Promise(r=>{const off=window.mc.onLlmEvent(e=>{if(e.kind==='delta')d.push(e.text);else if(e.kind==='done'){off();r({ok:true,text:e.text||d.join('')});}else if(e.kind==='error'){off();r({ok:false,error:e.message});}});});window.mc.llmAsk({requestId:'e2e-llm',mode:'free',freeQuestion:${JSON.stringify(q)},recentTranscript:[]});return await done;})()`;
        void win?.webContents
          .executeJavaScript(js, true)
          .then((r) => console.log('[e2e-llm]', JSON.stringify(r)))
          .catch((e) => console.log('[e2e-llm] threw', (e as Error).message));
      }
      // Visual QA of the main window (same spirit as MC_SETUP_SHOT for the
      // wizard): open the settings panel, let it paint, capture a PNG.
      if (process.env.MC_MAIN_SHOT) {
        const dir = process.env.MC_MAIN_SHOT;
        const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
        const shoot = async (name: string): Promise<void> => {
          const image = await win?.webContents.capturePage();
          if (!image) return;
          mkdirSync(dir, { recursive: true });
          const file = join(dir, `${name}.png`);
          writeFileSync(file, image.toPNG());
          console.log(`[main] screenshot ${file}`);
        };
        void (async () => {
          try {
            await win?.webContents.executeJavaScript(
              'window.__mcOpenSettings && window.__mcOpenSettings()',
              true,
            );
            await wait(1200);
            await shoot('main-settings-common');
            // expand 高级 and scroll to it, so the collapsed half is reviewable too
            await win?.webContents.executeJavaScript(
              `(()=>{const p=document.querySelector('.settings');if(!p)return 0;p.querySelectorAll('details').forEach(d=>d.open=true);p.scrollTop=p.scrollHeight;return p.scrollHeight;})()`,
            );
            await wait(600);
            await shoot('main-settings-advanced');
          } catch (e) {
            console.warn('[main] screenshot failed:', (e as Error).message);
          }
        })();
      }
      if (process.env.MC_E2E_SHOT) {
        const q = process.env.MC_E2E_SHOT;
        const js = `(async()=>{const d=[];const done=new Promise(r=>{const off=window.mc.onLlmEvent(e=>{if(e.kind==='delta')d.push(e.text);else if(e.kind==='done'){off();r({ok:true,text:e.text||d.join('')});}else if(e.kind==='error'){off();r({ok:false,error:e.message});}});});window.mc.shotAsk({requestId:'e2e-shot',question:${JSON.stringify(q)}});return await done;})()`;
        void win?.webContents
          .executeJavaScript(js, true)
          .then((r) => console.log('[e2e-shot]', JSON.stringify(r)))
          .catch((e) => console.log('[e2e-shot] threw', (e as Error).message));
      }
    });

    // the tray menu shows 显示/隐藏窗口, so it has to follow the real state —
    // whichever of the four hide paths was used (hotkey, 「—」, tray, IPC)
    // "where did my window go" is THE support question for a frameless,
    // taskbar-less, content-protected overlay, so both transitions are logged
    win.on('show', () => {
      console.log('[window] shown');
      refreshTray();
    });
    win.on('hide', () => {
      passthroughWindowDrag = null;
      console.log('[window] hidden');
      refreshTray();
      noticeWindowHidden();
    });

    win.on('closed', () => {
      disableMousePassthrough();
      win = null;
    });

    if (process.env.ELECTRON_RENDERER_URL) {
      void win.loadURL(process.env.ELECTRON_RENDERER_URL);
    } else {
      void win.loadFile(join(__dirname, '../renderer/index.html'));
    }

    // the tray belongs to the running app, not to the first-run wizard: an
    // unconfigured machine that closes the wizard must still quit (Phase 2)
    ensureTray();
  }

  /** normal boot: warm the ASR worker, bind hotkeys, show the overlay */
  function startMainApp(): void {
    void startAsr();
    registerHotkeys();
    syncAutoLaunch();
    createWindow();
  }

  /**
   * First-run gate. While the wizard is up there is no ASR worker, no python
   * sidecar, no cloud connection and no LLM prewarm — an unconfigured machine
   * must not spawn anything.
   */
  function openSetupWindow(rerun = false): void {
    if (setupWin) {
      if (setupWin.isMinimized()) setupWin.restore();
      setupWin.show();
      setupWin.focus();
      return;
    }
    setupRerun = rerun;
    const w = createSetupWindow();
    setupWin = w;

    // E2E: drive the wizard->main-app handover without a human click
    if (process.env.MC_E2E_ONBOARDING_COMPLETE === '1') {
      w.webContents.on('did-finish-load', () => {
        void w.webContents.executeJavaScript('window.mcSetup.completeOnboarding({})', true);
      });
    }

    w.on('close', (e) => {
      // completion closes this window programmatically, an OS shutdown /
      // app.quit() must never be blocked by a modal, and a re-run just puts
      // the user back into a working app — no prompt in any of those cases
      if (quitting || setupRerun || settings.data.onboarding.completed) return;
      const t = T();
      const choice = dialog.showMessageBoxSync(w, {
        type: 'warning',
        title: t.setupQuitTitle,
        message: t.setupQuitTitle,
        detail: t.setupQuitMessage,
        buttons: [t.setupQuitConfirm, t.setupQuitCancel],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
      if (choice !== 0) e.preventDefault();
    });

    w.on('closed', () => {
      const wasRerun = setupRerun;
      setupWin = null;
      setupRerun = false;
      if (wasRerun) {
        // keys saved before the user backed out still have to reach the engine
        if (pendingAsrRestart) {
          pendingAsrRestart = false;
          void asr.stop().then(() => startAsr());
        }
        return;
      }
      // first-run launch closed without finishing => nothing is configured and
      // there is no other window; Phase 4 adds a tray
      if (!settings.data.onboarding.completed) app.quit();
    });
  }

  app.whenReady().then(() => {
    // users who never chose a UI language get their OS language (zh → zh, else en)
    osLang = app.getLocale().toLowerCase().startsWith('zh') ? 'zh' : 'en';
    settings = new SettingsStore(join(app.getPath('userData'), 'settings.json'), cipher(), osLang);
    knowledge = new KnowledgeStore(join(app.getPath('userData'), 'knowledge.md'));
    sessionStore = new SessionStore(join(app.getPath('userData'), 'sessions.json'));

    // Electron's `audio: loopback` display-media source is Windows-only.
    // macOS/Linux use a selectable ordinary input in the renderer instead.
    if (captureKindForPlatform(process.platform) === 'loopback') {
      session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
        desktopCapturer
          .getSources({ types: ['screen'] })
          .then((sources) => callback({ video: sources[0], audio: 'loopback' }))
          .catch((e) => {
            console.error('[main] display media handler failed:', e);
            callback({});
          });
      });
    }

    // ---- IPC ----
    ipcMain.on(IPC.capturePcm, (_e, buf: ArrayBuffer, captureTs: number, channel: 'them' | 'me') => {
      asr.sendPcm(buf, captureTs, channel === 'me' ? 'me' : 'them');
    });

    // ---- P1-6: DeepSeek prefix-cache prewarm + keep-warm while capturing ----
    // One max_tokens=1 request with the byte-identical stable prefix builds the
    // provider-side KV cache, so the first real answer prefills at 0.1x price
    // and lower latency. Re-ping when the cache would go cold (same pattern as
    // the ASR 45s keep-warm). Real answer requests refresh the cache themselves.
    const PREWARM_IDLE_MS = 4 * 60_000;
    let lastPrefix: string | null = null;
    let lastPrefixActivity = 0; // last time the answer prefix hit the provider
    let keepWarmTimer: NodeJS.Timeout | null = null;

    /** same material fallback as llmAsk — prewarm MUST match real requests byte-for-byte */
    function stablePrefixFor(resume?: string, secondResume?: string): string {
      const hasMaterial = !!(resume || secondResume);
      const effResume = resume || (hasMaterial ? '' : knowledge.text);
      return buildStablePrefix(effResume, secondResume ?? '', settings.data.llm.answerLang);
    }

    async function doPrewarm(prefix: string, reason: string): Promise<void> {
      const apiKey = settings.getLlmApiKey();
      if (!apiKey || settings.data.llm.answerWithVision) return; // vision path ≠ DeepSeek
      lastPrefix = prefix;
      lastPrefixActivity = Date.now();
      try {
        const r = await chatOnce(
          { baseUrl: settings.data.llm.baseUrl, model: settings.data.llm.model, apiKey },
          buildPrewarmMessages(prefix),
          { maxTokens: 1 },
        );
        console.log(
          `[prewarm] ${reason}: cache_hit=${r.usage?.prompt_cache_hit_tokens ?? '?'} cache_miss=${r.usage?.prompt_cache_miss_tokens ?? '?'} prompt=${r.usage?.prompt_tokens ?? '?'}`,
        );
      } catch (e) {
        console.warn('[prewarm] failed:', (e as Error).message);
      }
    }

    ipcMain.on(
      IPC.llmPrewarm,
      (_e, payload: { resume?: string; secondResume?: string; immediate?: boolean } = {}) => {
        const prefix = stablePrefixFor(payload.resume, payload.secondResume);
        const dirty = prefix !== lastPrefix;
        const cold = Date.now() - lastPrefixActivity >= PREWARM_IDLE_MS;
        if (!dirty && !cold) return;
        if (payload.immediate || capturing) {
          void doPrewarm(prefix, dirty ? 'dirty' : 'refresh');
        } else {
          lastPrefix = null; // mark stale; the next ▶ prewarm sees dirty and reheats
        }
      },
    );

    // last-known capture lifecycle, for the diagnostics report only
    let lastCaptureStartedAt: string | undefined;
    let lastCaptureStoppedAt: string | undefined;

    ipcMain.on(IPC.captureStarted, () => {
      console.log('[main] capture started');
      lastCaptureStartedAt = new Date().toISOString();
      capturing = true;
      refreshTray(); // 开始转写 -> 停止转写
      if (!keepWarmTimer) {
        keepWarmTimer = setInterval(() => {
          if (!capturing || !lastPrefix) return;
          if (Date.now() - lastPrefixActivity >= PREWARM_IDLE_MS) {
            void doPrewarm(lastPrefix, 'keep-warm');
          }
        }, 60_000);
      }
    });
    ipcMain.on(IPC.captureStopped, () => {
      console.log('[main] capture stopped');
      lastCaptureStoppedAt = new Date().toISOString();
      capturing = false;
      refreshTray();
      if (keepWarmTimer) {
        clearInterval(keepWarmTimer);
        keepWarmTimer = null;
      }
      asr.flush();
    });
    ipcMain.handle(IPC.settingsGet, () => publicSettings());
    // pull-based replay: renderer asks after subscribing, so instant-ready
    // cloud engines can't race the subscription (stuck "模型加载中" bug)
    ipcMain.handle(IPC.asrReplay, () => ({ ready: asr.lastReady, status: asr.lastStatus }));
    ipcMain.handle(IPC.settingsSet, (_e, patch: SettingsPatch) => {
      const asrPatch = patch.asr;
      const currentAsr = settings.data.asr;
      const textChanged = (next?: string, current?: string): boolean =>
        next !== undefined && (next.trim() || undefined) !== (current?.trim() || undefined);
      const keyChanged = (
        next: string | undefined,
        current: string | undefined,
        hasStoredKey: boolean,
      ): boolean => next !== undefined && (next === '' ? hasStoredKey : next !== current);
      const nextBackend = asrPatch?.backend ?? currentAsr.backend ?? 'local';
      const asrEngineChanged = !!asrPatch && (
        (asrPatch.backend !== undefined && asrPatch.backend !== (currentAsr.backend ?? 'local')) ||
        (nextBackend === 'cloud' && (
          textChanged(asrPatch.cloud?.baseUrl, currentAsr.cloud?.baseUrl) ||
          textChanged(asrPatch.cloud?.model, currentAsr.cloud?.model) ||
          keyChanged(asrPatch.cloud?.apiKey, settings.getCloudAsrApiKey(), !!currentAsr.cloud?.apiKeyEnc)
        )) ||
        (nextBackend === 'cloud-realtime' && (
          textChanged(asrPatch.realtime?.baseUrl, currentAsr.realtime?.baseUrl) ||
          textChanged(asrPatch.realtime?.model, currentAsr.realtime?.model) ||
          keyChanged(asrPatch.realtime?.apiKey, settings.getRealtimeAsrApiKey(), !!currentAsr.realtime?.apiKeyEnc)
        )) ||
        (nextBackend === 'local-realtime' &&
          textChanged(asrPatch.localRealtime?.model, currentAsr.localRealtime?.model ?? 'fun-asr-nano'))
      );
      const asrLanguageChanged =
        asrPatch?.language !== undefined && asrPatch.language !== currentAsr.language;
      settings.applyPatch(patch);
      if (
        patch.ui?.hotkeyToggle !== undefined ||
        patch.ui?.hotkeyShot !== undefined ||
        patch.ui?.hotkeyQuit !== undefined
      ) {
        registerHotkeys();
      }
      if (patch.ui?.stealth !== undefined) {
        win?.setContentProtection(patch.ui.stealth);
      }
      // the tray menu is a snapshot: rebuild it in the newly chosen language
      if (patch.ui?.lang !== undefined) refreshTray();
      if (patch.ui?.autoLaunch !== undefined) applyAutoLaunch(patch.ui.autoLaunch);
      // Rebuild only when the active engine's effective configuration changed.
      // SettingsPanel sends a complete ASR snapshot even for unrelated edits;
      // comparing values avoids bouncing a live engine just because the user
      // saved an API key or a display preference. Language can hot-update.
      if (asrEngineChanged) {
        // While the wizard is up the engine must NOT be rebuilt per key save:
        // on a first run nothing is configured yet (a restart would spawn the
        // local python sidecar the user never agreed to), and in a re-run it
        // would bounce the live engine once per card. The wizard writes its
        // plan as one final patch; the restart happens exactly once after it.
        if (setupWin || !settings.data.onboarding.completed) pendingAsrRestart = true;
        else void asr.stop().then(() => startAsr());
      } else if (asrLanguageChanged) {
        asr.setLanguage(settings.data.asr.language);
      }
      return publicSettings();
    });
    // ---- first-run wizard state (settings v2) ----
    let wizardReadyLogged = false;
    ipcMain.handle(IPC.onboardingGet, (e) => {
      // one-shot boot marker: the wizard's own renderer reached main, which
      // proves setup.html loaded, its module graph ran and the setup preload
      // bridge is live. tools/packaged-smoke.mjs asserts it.
      if (!wizardReadyLogged && setupWin && e.sender === setupWin.webContents) {
        wizardReadyLogged = true;
        console.log(SETUP_READY_MARKER);
      }
      return settings.getOnboarding();
    });
    ipcMain.handle(IPC.onboardingSaveProgress, (_e, patch: OnboardingProgressPatch = {}) =>
      settings.saveOnboardingProgress(patch ?? {}),
    );
    ipcMain.handle(IPC.onboardingComplete, (_e, payload: OnboardingCompletePayload = {}) => {
      const state = settings.completeOnboarding(payload ?? {});
      // create the main window BEFORE closing the wizard: closing the last
      // window first would fire window-all-closed and quit the app mid-handover
      if (!win) {
        // startMainApp() already builds the engine from the finished settings
        startMainApp();
      } else if (pendingAsrRestart) {
        // re-run: the main window kept running, so apply the deferred rebuild
        void asr.stop().then(() => startAsr());
      }
      pendingAsrRestart = false;
      setupWin?.close();
      return state;
    });
    // main window -> "重新运行配置向导" / the upgrade notice
    ipcMain.handle(IPC.onboardingRerun, () => {
      openSetupWindow(true);
      return true;
    });

    // ---- app shell services (wizard + main window) ----
    // The renderer never navigates: window.open is denied and will-navigate is
    // prevented, so documentation links come back here to be validated.
    ipcMain.handle(IPC.externalOpen, (_e, url: unknown) => openExternalUrl(url));
    // read on an explicit paste-button click only — never polled
    ipcMain.handle(IPC.clipboardReadText, () => clipboard.readText());
    ipcMain.handle(
      IPC.appGetInfo,
      (): AppInfo => ({
        version: app.getVersion(),
        platform: process.platform,
        packaged: app.isPackaged,
      }),
    );

    // ---- provider connection tests (Phase 3) ----
    // Runs ONLY on an explicit user action from the wizard or Settings. The
    // candidate key lives in a local const for the duration of one call: it is
    // never persisted here, never logged, and never travels back to the
    // renderer inside the result.
    ipcMain.handle(
      IPC.providerTest,
      async (_e, incoming: ProviderTestRequest): Promise<ProviderTestResult> => {
        const req = incoming ?? ({} as ProviderTestRequest);
        const apiKey = resolveTestApiKey(req, (slot) => settings.getApiKeyForSlot(slot));
        // the plaintext candidate stops here: everything downstream sees a
        // request without it, and the key only as a separate argument
        const request = withoutCandidateKey(req);
        const result = await runProviderTest(
          { ...request, language: request.language ?? settings.data.asr.language },
          apiKey,
        );
        // one dedicated write; applyPatch() would restart the ASR engine
        if (request.slot) {
          settings.recordVerification(request.slot, {
            lastTestAt: new Date().toISOString(),
            lastTestOk: result.ok,
            lastTestCode: result.code,
            latencyMs: result.latencyMs,
          });
        }
        if (!result.ok) {
          recordDiagnosticError(
            `provider-test/${request.capability}`,
            `${result.code} (${request.providerId} ${request.model})`,
          );
        }
        console.log(
          `[provider-test] ${request.capability} ${request.providerId} -> ${result.code} (${result.latencyMs ?? '?'}ms)`,
        );
        return result;
      },
    );

    // ---- local diagnostics (Phase 3) ----
    // Purely local: built on request, returned to the renderer for the user to
    // copy. Nothing is uploaded, nothing is written to disk, and the builder
    // never receives a key, a transcript or any knowledge-base text.
    const pythonProbe = new LocalPythonProbe(() =>
      resolvePython(pythonCandidates(getResourceRoot())),
    );

    ipcMain.handle(IPC.diagnosticsGet, (): string => {
      pythonProbe.start(); // background; 'unknown' until it settles
      const ready = asr.lastReady?.kind === 'ready' ? asr.lastReady : null;
      const status = asr.lastStatus?.kind === 'status' ? asr.lastStatus : null;
      return buildDiagnosticsReport({
        appVersion: app.getVersion(),
        packaged: app.isPackaged,
        platform: process.platform,
        arch: process.arch,
        osRelease: release(),
        electronVersion: process.versions.electron,
        nodeVersion: process.versions.node,
        uiLang: osLang,
        settings: settings.data,
        weakCrypto: settings.getPublic().weakCrypto,
        knowledgeChars: knowledge.chars,
        capture: {
          active: capturing,
          lastStartedAt: lastCaptureStartedAt,
          lastStoppedAt: lastCaptureStoppedAt,
        },
        asr: {
          ready: !!ready,
          ep: ready?.ep,
          gpuSuspect: ready?.gpuSuspect,
          state: status?.state,
        },
        localPython: pythonProbe.status,
        errors: recentDiagnosticErrors(),
        generatedAt: new Date(),
      });
    });

    ipcMain.handle(IPC.logsOpenFolder, async (): Promise<boolean> => {
      // userData holds settings.json, sessions.json and knowledge.md -- the
      // exact folder a user needs when asked to check or wipe their data
      const err = await shell.openPath(app.getPath('userData'));
      if (err) console.warn('[diagnostics] could not open the data folder:', err);
      return err === '';
    });

    ipcMain.handle(IPC.knowledgeImport, async () => {
      const r = await dialog.showOpenDialog({
        title: T().kbImportTitle,
        filters: [{ name: 'Markdown/Text', extensions: ['md', 'markdown', 'txt'] }],
        properties: ['openFile'],
      });
      if (!r.canceled && r.filePaths[0]) {
        try {
          knowledge.setFromText(readFileSync(r.filePaths[0], 'utf8'));
        } catch (e) {
          console.error('[knowledge] import failed:', (e as Error).message);
        }
      }
      return { chars: knowledge.chars };
    });
    ipcMain.handle(IPC.knowledgeClear, () => {
      knowledge.clear();
      return { chars: knowledge.chars };
    });
    ipcMain.handle(IPC.knowledgePick, async (event, slot: 'resume' | 'secondResume' = 'resume') => {
      const owner = BrowserWindow.fromWebContents(event.sender);
      const restoreAlwaysOnTop = owner?.isAlwaysOnTop() ?? false;
      // The main UI is an always-on-top, non-activating overlay. A parentless
      // native file picker can open behind it, so temporarily lower the owner
      // and open the picker as its modal child.
      if (restoreAlwaysOnTop) owner?.setAlwaysOnTop(false);
      let r: Awaited<ReturnType<typeof dialog.showOpenDialog>>;
      try {
        const options: OpenDialogOptions = {
          title: slot === 'secondResume' ? T().pickSecondResumeTitle : T().pickResumeTitle,
          filters: [{ name: T().docFilter, extensions: [...DOC_EXTENSIONS] }],
          properties: ['openFile'],
        };
        r = owner
          ? await dialog.showOpenDialog(owner, options)
          : await dialog.showOpenDialog(options);
      } finally {
        if (restoreAlwaysOnTop && owner && !owner.isDestroyed()) {
          owner.setAlwaysOnTop(true, 'screen-saver');
        }
      }
      if (r.canceled || !r.filePaths[0]) return null;
      try {
        // deterministic parse (mammoth / pdf-parse) — no LLM in the loop;
        // '' for scanned PDFs, the renderer warns the user
        const text = await extractDocText(r.filePaths[0]);
        return { name: basename(r.filePaths[0]), text, chars: text.length };
      } catch (e) {
        console.error('[knowledge] pick failed:', (e as Error).message);
        return null;
      }
    });
    ipcMain.handle(IPC.sessionsLoad, () => sessionStore.load());
    ipcMain.on(IPC.sessionsSave, (_e, data) => sessionStore.save(data));

    // ---- full-screen screenshot capture for vision Q&A ----
    // Capturing happens in the main process so both the button and the global
    // hotkey use the same primary-display image without an interactive overlay.
    ipcMain.handle(IPC.stealthSet, (_e, on: boolean) => {
      settings.applyPatch({ ui: { stealth: on } });
      win?.setContentProtection(on);
      return on;
    });
    ipcMain.handle(IPC.windowFocusableSet, (_e, on: boolean) => {
      const focusable = !!on;
      const before = win?.isFocusable() ?? null;
      win?.setFocusable(focusable);
      if (focusable) win?.focus();
      console.log('[ui-debug] focusable-set', JSON.stringify({
        at: new Date().toISOString(),
        requested: focusable,
        before,
        after: win?.isFocusable() ?? null,
        focused: win?.isFocused() ?? null,
      }));
      return focusable;
    });
    ipcMain.handle(IPC.mousePassthroughSet, (_e, on: boolean) => setMousePassthrough(!!on));
    ipcMain.on(IPC.mousePassthroughDragStart, (event, point: { x: number; y: number }) => {
      if (event.sender !== win?.webContents || !mousePassthrough) return;
      if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return;
      passthroughWindowDrag = { x: point.x, y: point.y };
      logPassthroughWindow('drag-start', { point, lockedSize: passthroughLockedSize });
    });
    ipcMain.on(IPC.uiInputDebug, (event, input: UiInputDebugEvent) => {
      if (event.sender !== win?.webContents || !input || typeof input !== 'object') return;
      const allowedTypes = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click'];
      if (!allowedTypes.includes(input.type)) return;
      console.log('[ui-debug] input', JSON.stringify({
        at: new Date().toISOString(),
        type: input.type,
        phase: input.phase === 'capture' ? 'capture' : 'bubble',
        targetTag: typeof input.targetTag === 'string' ? input.targetTag.slice(0, 32) : 'unknown',
        targetId: typeof input.targetId === 'string' ? input.targetId.slice(0, 64) : undefined,
        isTrusted: !!input.isTrusted,
        defaultPrevented: !!input.defaultPrevented,
        button: typeof input.button === 'number' ? input.button : undefined,
        pointerType: typeof input.pointerType === 'string' ? input.pointerType.slice(0, 16) : undefined,
      }));
    });
    ipcMain.on(IPC.winHide, () => win?.hide());
    ipcMain.on(IPC.appQuit, () => app.quit());

    // ---- LLM (R4): streaming answers; key stays in the main process ----
    const llmControllers = new Map<string, AbortController>();
    ipcMain.on(IPC.llmAsk, (_e, payload: LlmAskPayload) => {
      const sendEv = (ev: LlmEvent) => win?.webContents.send(IPC.llmEvent, ev);
      const apiKey = settings.getLlmApiKey();
      if (!apiKey) {
        sendEv({ requestId: payload.requestId, kind: 'error', message: T().noApiKey });
        return;
      }
      const ac = new AbortController();
      llmControllers.set(payload.requestId, ac);
      const isTranslate = payload.mode === 'translate';
      // session dual-slot material first; the global default KB only fills in
      // when the session has nothing (translate stays a clean pass-through)
      const hasMaterial = !!(payload.resume || payload.secondResume || payload.background);
      const messages = buildAnswerMessages({
        mode: payload.mode,
        question: payload.question,
        freeQuestion: payload.freeQuestion,
        recentTranscript: payload.recentTranscript,
        answerLang: payload.answerLang ?? settings.data.llm.answerLang,
        history: payload.history,
        resume: isTranslate ? undefined : payload.resume,
        secondResume: isTranslate ? undefined : payload.secondResume,
        memo: isTranslate ? undefined : payload.memo,
        background: isTranslate ? undefined : payload.background || (hasMaterial ? undefined : knowledge.text),
      });

      // "answer with multimodal": route through the vision provider (proxy-aware,
      // non-streaming). Otherwise stream from the text LLM (direct, fastest).
      const useVision =
        settings.data.llm.answerWithVision &&
        payload.mode !== 'translate' &&
        !!settings.data.vision.baseUrl &&
        !!settings.data.vision.model &&
        !!settings.getVisionApiKey();

      // a real answer request refreshes the provider-side prefix cache itself
      if (!isTranslate && !useVision && payload.mode !== 'free') {
        lastPrefix = stablePrefixFor(payload.resume || payload.background, payload.secondResume);
        lastPrefixActivity = Date.now();
      }

      const work = useVision
        ? visionChat(
            {
              baseUrl: settings.data.vision.baseUrl!,
              model: settings.data.vision.model!,
              apiKey: settings.getVisionApiKey()!,
              proxyUrl: settings.data.vision.proxyUrl,
            },
            messages,
            ac.signal,
          ).then((text) => {
            sendEv({ requestId: payload.requestId, kind: 'delta', text });
            return { text };
          })
        : chatStream(
            { baseUrl: settings.data.llm.baseUrl, model: settings.data.llm.model, apiKey },
            messages,
            { onDelta: (text) => sendEv({ requestId: payload.requestId, kind: 'delta', text }) },
            ac.signal,
          );

      work
        .then((r) => {
          const u = (r as ChatResult).usage;
          if (u) {
            // prewarm acceptance signal: after a warm, hit ≈ prefix length
            console.log(
              `[llm] done mode=${payload.mode} cache_hit=${u.prompt_cache_hit_tokens ?? '?'} cache_miss=${u.prompt_cache_miss_tokens ?? '?'}`,
            );
          }
          sendEv({ requestId: payload.requestId, kind: 'done', text: r.text });
        })
        .catch((e: Error) => {
          if (ac.signal.aborted) return; // user cancelled — not an error
          console.error('[llm] request failed:', e.message);
          sendEv({ requestId: payload.requestId, kind: 'error', message: e.message });
        })
        .finally(() => llmControllers.delete(payload.requestId));
    });
    ipcMain.on(IPC.llmCancel, (_e, requestId: string) => {
      llmControllers.get(requestId)?.abort();
      llmControllers.delete(requestId);
    });

    // P1-5: fold a finished Q&A into the rolling interview memo. Async and
    // off the critical answer path — renderer serializes calls per session.
    ipcMain.handle(
      IPC.memoUpdate,
      async (_e, p: { memo: string; question: string; answer: string }): Promise<string> => {
        const apiKey = settings.getLlmApiKey();
        if (!apiKey) return '';
        try {
          const r = await chatOnce(
            { baseUrl: settings.data.llm.baseUrl, model: settings.data.llm.model, apiKey },
            buildMemoUpdateMessages(p.memo ?? '', p.question ?? '', p.answer ?? ''),
            { maxTokens: 700, temperature: 0.2 },
          );
          return clampMemo(r.text);
        } catch (e) {
          console.warn('[memo] update failed:', (e as Error).message);
          return '';
        }
      },
    );

    // Cheap one-shot translation to Chinese (inline transcript 对照; off-session,
    // no history pollution). Uses the fast text model (deepseek-chat).
    ipcMain.handle(IPC.translateText, async (_e, text: string) => {
      const apiKey = settings.getLlmApiKey();
      if (!apiKey) throw new Error(T().noApiKeyShort);
      const r = await chatStream(
        { baseUrl: settings.data.llm.baseUrl, model: settings.data.llm.model, apiKey },
        buildTranslateMessages(text),
        { onDelta: () => {} },
      );
      return r.text;
    });

    // ---- R5: screenshot -> vision model. Our own window is excluded from
    // the capture automatically (content protection). ----
    ipcMain.on(
      IPC.shotAsk,
      (
        _e,
        payload: {
          requestId: string;
          question: string;
          resume?: string;
          secondResume?: string;
          imageDataUrl?: string;
        },
      ) => {
        const sendEv = (ev: LlmEvent) => win?.webContents.send(IPC.llmEvent, ev);
        const vision = settings.data.vision;
        const apiKey = settings.getVisionApiKey();
        if (!vision.baseUrl || !vision.model || !apiKey) {
          sendEv({
            requestId: payload.requestId,
            kind: 'error',
            message: T().noVision,
          });
          return;
        }
        const ac = new AbortController();
        llmControllers.set(payload.requestId, ac);
        // Callers may provide an image explicitly; the normal button/hotkey
        // path captures the complete primary display automatically.
        const imgP = payload.imageDataUrl
          ? Promise.resolve(payload.imageDataUrl)
          : capturePrimaryScreenDataUrl();
        const hasMaterial = !!(payload.resume || payload.secondResume);
        imgP
          .then((dataUrl) =>
            visionChat(
              { baseUrl: vision.baseUrl!, model: vision.model!, apiKey, proxyUrl: vision.proxyUrl },
              buildVisionMessages(
                payload.question,
                dataUrl,
                payload.resume || (hasMaterial ? undefined : knowledge.text),
                payload.secondResume,
              ),
              ac.signal,
            ),
          )
          .then((text) => {
            sendEv({ requestId: payload.requestId, kind: 'delta', text });
            sendEv({ requestId: payload.requestId, kind: 'done', text });
          })
          .catch((e: Error) => {
            if (ac.signal.aborted) return;
            console.error('[vision] request failed:', e.message);
            sendEv({ requestId: payload.requestId, kind: 'error', message: e.message });
          })
          .finally(() => llmControllers.delete(payload.requestId));
      },
    );

    // ---- ASR: warm the worker at launch (PLAN §6.3) ----
    asr.onEvent((ev: AsrEvent) => {
      if (ev.kind === 'segment') {
        const e2e = ev.timings.inferEndTs - ev.timings.speechEndTs;
        console.log(`[asr] #${ev.id} (${ev.lang ?? '?'}, ${ev.audioMs}ms audio, e2e ${e2e}ms) ${ev.text}`);
      } else if (ev.kind === 'ready') {
        console.log(`[asr] ready ep=${ev.ep} load=${ev.loadMs}ms warm=${ev.warmMs}ms gpuSuspect=${ev.gpuSuspect}`);
        if (process.env.MC_E2E_QUIT_ON_ASR_READY === '1') {
          setTimeout(() => app.quit(), 250);
        }
      } else if (ev.kind === 'error') {
        console.error(`[asr] error (fatal=${ev.fatal}): ${ev.message}`);
        // only fatal events belong in the support report — a transient
        // per-segment failure would flood the 50-entry buffer
        if (ev.fatal) recordDiagnosticError('asr', ev.message);
        if (ev.fatal) {
          // engine diagnostics are deliberately English (they end up in logs
          // and in the diagnostics report); the sentence AROUND them is the
          // part the user reads, so it gets localized here
          win?.webContents.send(IPC.asrEvent, { ...ev, message: T().asrEngineFail(ev.message) });
          return;
        }
      } else if (ev.kind === 'status') {
        console.log(`[asr] status=${ev.state} queued=${ev.queuedSegments}`);
      }
      win?.webContents.send(IPC.asrEvent, ev);
    });

    // First run (or MC_FORCE_ONBOARDING=1 for testing): the wizard owns the
    // whole startup — no overlay window, no ASR worker, no sidecar spawn.
    if (process.env.MC_FORCE_ONBOARDING === '1' || !settings.data.onboarding.completed) {
      openSetupWindow();
    } else {
      startMainApp();
    }
  });

  app.on('second-instance', () => {
    if (setupWin) {
      if (setupWin.isMinimized()) setupWin.restore();
      setupWin.show();
      setupWin.focus();
      return;
    }
    if (win?.isMinimized()) win.restore();
    win?.showInactive();
  });

  app.on('before-quit', () => {
    quitting = true;
    disableMousePassthrough();
    globalShortcut.unregisterAll();
    tray.destroy();
    void asr.stop();
    void sidecar.stop();
  });

  /**
   * Still a quit, tray or not: hiding the overlay does NOT close it, so this
   * only fires on a real teardown (app.quit() destroying the windows, or the
   * first-run wizard being closed before completion). A "close to tray" app
   * would return here instead — MeetingCopilot deliberately has no window
   * close button that leaves the app running headless without a window.
   */
  app.on('window-all-closed', () => {
    app.quit();
  });
}
