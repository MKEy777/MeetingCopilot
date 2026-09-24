import type { UiLang } from '../shared/protocol';
import type { TrayMenuLabels } from '../shared/trayMenu';
import { APP_DISPLAY_NAME } from '../shared/appIdentity';

/**
 * Main-process user-facing strings (dialogs and high-visibility
 * errors). The renderer chrome has its own dictionary in src/i18n.tsx; deep
 * engine diagnostics stay untranslated on purpose.
 */
const zh = {
  kbImportTitle: '导入个人知识库（.md / .txt）',
  docFilter: '文档',
  pickResumeTitle: '导入我的简历（md/txt/docx/pdf）',
  pickSecondResumeTitle: '导入第二简历或面试参考资料（md/txt/docx/pdf）',
  noApiKey: '未设置 API Key，请在设置里填入后重试',
  noApiKeyShort: '未设置 API Key',
  noVision: '未配置视觉模型：请在设置里填 Vision Base URL / 模型 / Key（如 MiMo / Gemini）',
  sidecarFail: (msg: string) => `本地 ASR 引擎启动失败：${msg}`,
  /** wraps the ASR worker's own (English, log-friendly) engine diagnostics */
  asrEngineFail: (msg: string) => `语音识别引擎异常：${msg}`,
  setupQuitTitle: '尚未完成配置',
  setupQuitMessage: '配置尚未完成，确定退出吗？可稍后从设置中重新打开向导。',
  setupQuitConfirm: '退出',
  setupQuitCancel: '继续配置',
  tray: {
    brand: APP_DISPLAY_NAME,
    showWindow: '显示窗口',
    hideWindow: '隐藏窗口',
    startCapture: '开始转写',
    stopCapture: '停止转写',
    newSession: '新建会话',
    settings: '设置',
    serviceStatus: '服务状态',
    help: '帮助与教程',
    checkUpdates: '检查更新',
    quit: '退出',
    capturing: '转写中',
  } satisfies TrayMenuLabels,
  trayNoticeTitle: `${APP_DISPLAY_NAME} 仍在运行`,
  trayNoticeBody: '窗口已隐藏，可从系统托盘图标重新打开；托盘菜单里也能直接退出。',
};

type MainDict = typeof zh;

const en: MainDict = {
  kbImportTitle: 'Import personal knowledge base (.md / .txt)',
  docFilter: 'Documents',
  pickResumeTitle: 'Import my resume (md/txt/docx/pdf)',
  pickSecondResumeTitle: 'Import a second resume or interview reference (md/txt/docx/pdf)',
  noApiKey: 'API Key not set — add one in Settings and retry',
  noApiKeyShort: 'API Key not set',
  noVision: 'Vision model not configured: set the Vision Base URL / model / key in Settings (e.g. MiMo / Gemini)',
  sidecarFail: (msg: string) => `Local ASR engine failed to start: ${msg}`,
  asrEngineFail: (msg: string) => `Speech recognition engine error: ${msg}`,
  setupQuitTitle: 'Setup is not finished',
  setupQuitMessage:
    'Setup is not finished. Quit anyway? You can reopen the wizard later from Settings.',
  setupQuitConfirm: 'Quit',
  setupQuitCancel: 'Keep setting up',
  tray: {
    brand: APP_DISPLAY_NAME,
    showWindow: 'Show window',
    hideWindow: 'Hide window',
    startCapture: 'Start transcription',
    stopCapture: 'Stop transcription',
    newSession: 'New session',
    settings: 'Settings',
    serviceStatus: 'Service status',
    help: 'Help & guides',
    checkUpdates: 'Check for updates',
    quit: 'Quit',
    capturing: 'transcribing',
  },
  trayNoticeTitle: `${APP_DISPLAY_NAME} is still running`,
  trayNoticeBody:
    'The window is hidden — reopen it from the tray icon. The tray menu also has Quit.',
};

const dicts: Record<UiLang, MainDict> = { zh, en };

export function mainStrings(lang: UiLang | undefined, fallback: UiLang): MainDict {
  return dicts[lang ?? fallback];
}
