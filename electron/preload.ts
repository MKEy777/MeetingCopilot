import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC,
  type AppInfo,
  type AsrEvent,
  type KbSlot,
  type LlmAskPayload,
  type LlmEvent,
  type OnboardingProgressPatch,
  type OnboardingState,
  type ProviderTestRequest,
  type ProviderTestResult,
  type PublicSettings,
  type SessionsFile,
  type SettingsPatch,
  type TrayCommandPayload,
  type UiInputDebugEvent,
  type UiNativeMouseActivation,
  type PassthroughMouseEvent,
  type PassthroughMouseState,
} from '../shared/protocol';

export interface McApi {
  readonly platform: NodeJS.Platform;
  getSettings(): Promise<PublicSettings>;
  setSettings(patch: SettingsPatch): Promise<PublicSettings>;
  /** first-run wizard state (the main window only reads it / dismisses the
   * upgrade notice — completing onboarding belongs to the setup window) */
  getOnboarding(): Promise<OnboardingState>;
  saveOnboardingProgress(patch: OnboardingProgressPatch): Promise<OnboardingState>;
  /** reopen the setup wizard without closing the app (settings / upgrade notice) */
  rerunOnboarding(): Promise<boolean>;
  importKnowledge(): Promise<{ chars: number }>;
  clearKnowledge(): Promise<{ chars: number }>;
  /** pick a resume/reference document for the current session (.md/.txt/.docx/.pdf) */
  pickKnowledge(slot: KbSlot): Promise<{ name: string; text: string; chars: number } | null>;
  loadSessions(): Promise<SessionsFile>;
  saveSessions(data: SessionsFile): void;
  setStealth(on: boolean): Promise<boolean>;
  /** Enable focus only while the user is editing a text control. */
  setWindowFocusable(on: boolean): Promise<boolean>;
  setMousePassthrough(on: boolean): Promise<boolean>;
  onMousePassthroughEvent(cb: (event: PassthroughMouseEvent) => void): () => void;
  onMousePassthroughState(cb: (state: PassthroughMouseState) => void): () => void;
  beginMousePassthroughDrag(x: number, y: number): void;
  /** Temporary click diagnostics. Payload contains no control text or values. */
  debugUiInput(event: UiInputDebugEvent): void;
  /** Observe non-activating Windows clicks for the renderer's targeted fallback. */
  onUiNativeMouseActivation(cb: (event: UiNativeMouseActivation) => void): () => void;
  sendPcm(buf: ArrayBuffer, captureTs: number, channel: 'them' | 'me'): void;
  captureStarted(): void;
  captureStopped(): void;
  translate(text: string): Promise<string>;
  onAsrEvent(cb: (ev: AsrEvent) => void): () => void;
  /** pull the last ready/status events (call AFTER onAsrEvent subscription) */
  asrReplay(): Promise<{ ready: AsrEvent | null; status: AsrEvent | null }>;
  llmAsk(payload: LlmAskPayload): void;
  shotAsk(payload: {
    requestId: string;
    question: string;
    resume?: string;
    secondResume?: string;
    imageDataUrl?: string;
  }): void;
  llmCancel(requestId: string): void;
  /** P1-6: warm the DeepSeek prefix cache with the session's material;
   * immediate=true warms even when not capturing (▶ start / material import) */
  prewarm(payload: { resume?: string; secondResume?: string; immediate?: boolean }): void;
  /** P1-5: fold a finished Q&A into the rolling memo ('' = keep the old one) */
  memoUpdate(p: { memo: string; question: string; answer: string }): Promise<string>;
  onLlmEvent(cb: (ev: LlmEvent) => void): () => void;
  onShotHotkey(cb: () => void): () => void;
  /** tray menu entries only the renderer can service (capture / session /
   * panels). Main has already made the window visible when this fires. */
  onTrayCommand(cb: (payload: TrayCommandPayload) => void): () => void;
  /** open an allowlisted https documentation link in the OS browser;
   * false = refused by the main-process allowlist */
  openExternal(url: string): Promise<boolean>;
  /** read the clipboard — call ONLY from an explicit paste-button click */
  readClipboardText(): Promise<string>;
  getAppInfo(): Promise<AppInfo>;
  /** run ONE real provider connection test; explicit user action only (it
   * costs the user a minimal billable request). Main maps every failure to a
   * ProviderTestCode + zh/en message, so nothing raw reaches the UI. */
  providerTest(req: ProviderTestRequest): Promise<ProviderTestResult>;
  /** plaintext support report, built locally on request. Contains no keys, no
   * transcripts and no knowledge-base text — safe to paste into an issue. */
  getDiagnostics(): Promise<string>;
  /** reveal %APPDATA%/MeetingCopilot (settings, sessions, knowledge) */
  openLogsFolder(): Promise<boolean>;
  hide(): void;
  quit(): void;
}

const api: McApi = {
  platform: process.platform,
  getSettings: () => ipcRenderer.invoke(IPC.settingsGet),
  setSettings: (patch) => ipcRenderer.invoke(IPC.settingsSet, patch),
  getOnboarding: () => ipcRenderer.invoke(IPC.onboardingGet),
  saveOnboardingProgress: (patch) => ipcRenderer.invoke(IPC.onboardingSaveProgress, patch),
  rerunOnboarding: () => ipcRenderer.invoke(IPC.onboardingRerun),
  importKnowledge: () => ipcRenderer.invoke(IPC.knowledgeImport),
  clearKnowledge: () => ipcRenderer.invoke(IPC.knowledgeClear),
  pickKnowledge: (slot) => ipcRenderer.invoke(IPC.knowledgePick, slot),
  loadSessions: () => ipcRenderer.invoke(IPC.sessionsLoad),
  saveSessions: (data) => ipcRenderer.send(IPC.sessionsSave, data),
  setStealth: (on) => ipcRenderer.invoke(IPC.stealthSet, on),
  setWindowFocusable: (on) => ipcRenderer.invoke(IPC.windowFocusableSet, on),
  setMousePassthrough: (on) => ipcRenderer.invoke(IPC.mousePassthroughSet, on),
  onMousePassthroughEvent: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, event: PassthroughMouseEvent) => cb(event);
    ipcRenderer.on(IPC.mousePassthroughEvent, listener);
    return () => ipcRenderer.removeListener(IPC.mousePassthroughEvent, listener);
  },
  onMousePassthroughState: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, state: PassthroughMouseState) => cb(state);
    ipcRenderer.on(IPC.mousePassthroughState, listener);
    return () => ipcRenderer.removeListener(IPC.mousePassthroughState, listener);
  },
  beginMousePassthroughDrag: (x, y) => ipcRenderer.send(IPC.mousePassthroughDragStart, { x, y }),
  debugUiInput: (event) => ipcRenderer.send(IPC.uiInputDebug, event),
  onUiNativeMouseActivation: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, event: UiNativeMouseActivation) => cb(event);
    ipcRenderer.on(IPC.uiNativeMouseActivation, listener);
    return () => ipcRenderer.removeListener(IPC.uiNativeMouseActivation, listener);
  },
  sendPcm: (buf, captureTs, channel) => ipcRenderer.send(IPC.capturePcm, buf, captureTs, channel),
  captureStarted: () => ipcRenderer.send(IPC.captureStarted),
  captureStopped: () => ipcRenderer.send(IPC.captureStopped),
  translate: (text) => ipcRenderer.invoke(IPC.translateText, text),
  onAsrEvent: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, ev: AsrEvent) => cb(ev);
    ipcRenderer.on(IPC.asrEvent, listener);
    return () => ipcRenderer.removeListener(IPC.asrEvent, listener);
  },
  asrReplay: () => ipcRenderer.invoke(IPC.asrReplay),
  llmAsk: (payload) => ipcRenderer.send(IPC.llmAsk, payload),
  shotAsk: (payload) => ipcRenderer.send(IPC.shotAsk, payload),
  llmCancel: (requestId) => ipcRenderer.send(IPC.llmCancel, requestId),
  prewarm: (payload) => ipcRenderer.send(IPC.llmPrewarm, payload),
  memoUpdate: (p) => ipcRenderer.invoke(IPC.memoUpdate, p),
  onLlmEvent: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, ev: LlmEvent) => cb(ev);
    ipcRenderer.on(IPC.llmEvent, listener);
    return () => ipcRenderer.removeListener(IPC.llmEvent, listener);
  },
  onShotHotkey: (cb) => {
    const listener = () => cb();
    ipcRenderer.on(IPC.shotHotkey, listener);
    return () => ipcRenderer.removeListener(IPC.shotHotkey, listener);
  },
  onTrayCommand: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: TrayCommandPayload) => cb(payload);
    ipcRenderer.on(IPC.trayCommand, listener);
    return () => ipcRenderer.removeListener(IPC.trayCommand, listener);
  },
  openExternal: (url) => ipcRenderer.invoke(IPC.externalOpen, url),
  readClipboardText: () => ipcRenderer.invoke(IPC.clipboardReadText),
  getAppInfo: () => ipcRenderer.invoke(IPC.appGetInfo),
  providerTest: (req) => ipcRenderer.invoke(IPC.providerTest, req),
  getDiagnostics: () => ipcRenderer.invoke(IPC.diagnosticsGet),
  openLogsFolder: () => ipcRenderer.invoke(IPC.logsOpenFolder),
  hide: () => ipcRenderer.send(IPC.winHide),
  quit: () => ipcRenderer.send(IPC.appQuit),
};

contextBridge.exposeInMainWorld('mc', api);
