import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import type {
  AnswerLang,
  AsrEvent,
  KbSlot,
  LlmAskPayload,
  PublicSettings,
  PassthroughMouseEvent,
  StoredSession,
} from '../shared/protocol';
import { APP_DISPLAY_NAME } from '../shared/appIdentity';
import {
  appendSegment,
  nextSegmentId,
  percentile,
  reindexSegments,
  type TranscriptSegment,
} from '../shared/transcript';
import { isLikelyQuestion } from '../shared/textHeuristics';
import { normalizeSessionMaterial } from '../shared/sessionMigration';
import { captureKindForPlatform } from '../shared/platform';
import { deriveServiceHealth } from '../shared/healthState';
import { shouldSynthesizeMouseClick } from '../shared/uiInteractionFallback';
import { LoopbackCapture } from './audio/loopbackCapture';
import { MicCapture, listMics } from './audio/micCapture';
import { TranscriptPanel } from './components/TranscriptPanel';
import { ScriptPanel } from './components/ScriptPanel';
import { SettingsPanel } from './components/SettingsPanel';
import { ServiceHealthPanel } from './components/ServiceHealthPanel';
import { DiagnosticsPanel } from './components/DiagnosticsPanel';
import { HelpPanel } from './components/HelpPanel';
import { StatusBar } from './components/StatusBar';
import { AnswerSession, type AnswerTurn } from './components/AnswerSession';
import { I18nProvider, getDict, useT, type Dict } from './i18n';

export interface AsrUiState {
  phase: 'loading' | 'ready' | 'error';
  ep?: string;
  gpuSuspect?: boolean;
  workerState: 'loading' | 'listening' | 'speech' | 'transcribing' | 'stopped';
  lastError?: string;
}

export interface HudStats {
  lastE2eMs?: number;
  lastInferMs?: number;
  p50?: number;
  p95?: number;
  count: number;
}

const MAX_TURNS = 200;
// v2: only the last 8 turns ride along verbatim — the rolling memo carries
// older context, keeping per-request tokens flat as the interview runs long
const HISTORY_TURNS = 8;

let seq = 0;
const uid = (p: string) => `${p}-${++seq}-${Date.now()}`;

function newSession(name: string): StoredSession {
  return { id: uid('s'), name, createdAt: Date.now(), turns: [], segments: [] };
}

/** first-question topic → a short session title */
function deriveName(text: string, fallback: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return fallback;
  return t.length > 14 ? t.slice(0, 14) + '…' : t;
}

type PaneId = 'script' | 'transcript' | 'answer';
type PaneWeights = Record<PaneId, number>;

const MIN_RESIZED_PANE_WIDTH = 140;

function collapseWeight(weights: PaneWeights, id: PaneId, remaining: PaneId[]): PaneWeights {
  const next = { ...weights, [id]: 0 };
  const share = weights[id] / remaining.length;
  for (const pane of remaining) next[pane] += share;
  return next;
}

function expandWeight(weights: PaneWeights, id: PaneId, expanded: PaneId[]): PaneWeights {
  const next = { ...weights };
  const newShare = 1 / (expanded.length + 1);
  const oldTotal = expanded.reduce((sum, pane) => sum + weights[pane], 0);
  for (const pane of expanded) {
    next[pane] = oldTotal > 0 ? (weights[pane] / oldTotal) * (1 - newShare) : newShare;
  }
  next[id] = newShare;
  return next;
}

function PaneSlot({
  id,
  label,
  collapsed,
  weight,
  onExpand,
  children,
}: {
  id: PaneId;
  label: string;
  collapsed: boolean;
  weight: number;
  onExpand: () => void;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <div
      className={`pane-slot${collapsed ? ' pane-slot-collapsed' : ''}`}
      data-pane-id={id}
      style={collapsed ? undefined : { flexGrow: weight }}
    >
      {collapsed && (
        <button className="pane-rail" onClick={onExpand} title={t.layout.expand(label)} aria-label={t.layout.expand(label)}>
          <span>›</span>
          <span>{label}</span>
        </button>
      )}
      {children}
    </div>
  );
}

export function App() {
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [asr, setAsr] = useState<AsrUiState>({ phase: 'loading', workerState: 'loading' });
  const [capturing, setCapturing] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showHealth, setShowHealth] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showHud, setShowHud] = useState(true);
  const [hud, setHud] = useState<HudStats>({ count: 0 });
  const [continuous, setContinuous] = useState(false);
  const [scriptEnabled, setScriptEnabled] = useState(false);
  const [scriptText, setScriptText] = useState('');
  const [scriptEditing, setScriptEditing] = useState(false);
  const [collapsedPanes, setCollapsedPanes] = useState<Record<PaneId, boolean>>({
    script: false,
    transcript: false,
    answer: false,
  });
  const [paneWeights, setPaneWeights] = useState<PaneWeights>({ script: 0, transcript: 0.5, answer: 0.5 });
  const [resizingPanes, setResizingPanes] = useState(false);
  const [mousePassthrough, setMousePassthrough] = useState(false);
  const [passthroughBusy, setPassthroughBusy] = useState(false);
  const [passthroughError, setPassthroughError] = useState(false);
  const [mics, setMics] = useState<{ deviceId: string; label: string }[]>([]);
  const [micActive, setMicActive] = useState(false);
  const [partials, setPartials] = useState<{ them?: string; me?: string }>({});
  const [sessions, setSessions] = useState<StoredSession[]>([]);
  const [currentId, setCurrentId] = useState<string>('');
  const [kbNotice, setKbNotice] = useState<string | null>(null);

  const loopbackRef = useRef<LoopbackCapture | null>(null);
  const themInputRef = useRef<MicCapture | null>(null);
  const micRef = useRef<MicCapture | null>(null);
  const settingsRef = useRef<PublicSettings | null>(null);
  const previewWindowOpacity = useCallback((opacity: number | null) => {
    const value = opacity ?? settingsRef.current?.ui.opacity ?? 0.94;
    void window.mc.setWindowOpacity(value).catch((error) => {
      console.warn('[ui] window opacity update failed:', (error as Error).message);
    });
  }, []);
  const e2eSamples = useRef<number[]>([]);
  const sessionsRef = useRef<StoredSession[]>([]);
  const currentIdRef = useRef<string>('');
  const answerLangRef = useRef<AnswerLang>('chinese');
  const loaded = useRef(false);
  const panesRef = useRef<HTMLDivElement>(null);
  const resizeRef = useRef<{
    pointerId: number;
    left: PaneId;
    right: PaneId;
    startX: number;
    leftWidth: number;
    rightWidth: number;
    leftWeight: number;
    rightWeight: number;
  } | null>(null);
  const virtualDownRef = useRef<HTMLElement | null>(null);
  const virtualHoverRef = useRef<HTMLElement | null>(null);
  const virtualDragRef = useRef<NonNullable<typeof resizeRef.current> | null>(null);

  useEffect(() => {
    const cancelResize = () => {
      resizeRef.current = null;
      setResizingPanes(false);
    };
    window.addEventListener('blur', cancelResize);
    return () => window.removeEventListener('blur', cancelResize);
  }, []);

  // When the OS window ignores mouse input, a Windows helper observes the
  // same physical mouse without consuming it. Hit-test our DOM at the reported
  // position and execute the matching action while the webpage below receives
  // the original event. This only runs while passthrough is enabled.
  useEffect(() => {
    const actionAt = (x: number, y: number): HTMLElement | null => {
      const element = document.elementFromPoint(x, y);
      return element?.closest<HTMLElement>(
        'button, a, input, select, textarea, [role="button"], .bubble',
      ) ?? null;
    };
    const scrollAt = (x: number, y: number, delta: number) => {
      let element = document.elementFromPoint(x, y);
      while (element instanceof HTMLElement) {
        const style = getComputedStyle(element);
        if (element.scrollHeight > element.clientHeight && /(auto|scroll)/.test(style.overflowY)) {
          element.scrollTop -= (delta / 120) * 88;
          return;
        }
        element = element.parentElement;
      }
    };
    const handle = (event: PassthroughMouseEvent) => {
      const { x, y } = event;
      if (event.type === 'move') {
        const hovered = actionAt(x, y);
        if (virtualHoverRef.current !== hovered) {
          virtualHoverRef.current?.classList.remove('passthrough-hover');
          hovered?.classList.add('passthrough-hover');
          virtualHoverRef.current = hovered;
        }
        const drag = virtualDragRef.current;
        if (drag) {
          resizePair(drag.left, drag.right, drag.leftWidth, drag.rightWidth,
            drag.leftWeight, drag.rightWeight, x - drag.startX);
        }
        return;
      }
      if (event.type === 'wheel') {
        if (event.delta) scrollAt(x, y, event.delta);
        return;
      }
      if (event.type === 'down') {
        const element = document.elementFromPoint(x, y);
        const splitter = element?.closest<HTMLElement>('.pane-splitter');
        if (splitter) {
          const leftSlot = splitter.previousElementSibling as HTMLElement | null;
          const rightSlot = splitter.nextElementSibling as HTMLElement | null;
          const left = leftSlot?.dataset.paneId as PaneId | undefined;
          const right = rightSlot?.dataset.paneId as PaneId | undefined;
          if (left && right) {
            virtualDragRef.current = {
              pointerId: -1, left, right, startX: x,
              leftWidth: leftSlot!.getBoundingClientRect().width,
              rightWidth: rightSlot!.getBoundingClientRect().width,
              leftWeight: paneWeights[left], rightWeight: paneWeights[right],
            };
            setResizingPanes(true);
          }
          virtualDownRef.current = null;
        } else {
          virtualDownRef.current = actionAt(x, y);
          if (!virtualDownRef.current && element?.closest('.titlebar')) {
            window.mc.beginMousePassthroughDrag(x, y);
          }
        }
        return;
      }
      if (virtualDragRef.current) {
        virtualDragRef.current = null;
        setResizingPanes(false);
        return;
      }
      const target = actionAt(x, y);
      const pressed = virtualDownRef.current;
      virtualDownRef.current = null;
      if (!target || target !== pressed || target.getAttribute('aria-disabled') === 'true') return;
      if ('disabled' in target && target.disabled) return;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ||
          target instanceof HTMLSelectElement) {
        const editable = target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement ||
          (target instanceof HTMLInputElement && !['button', 'checkbox', 'file', 'radio', 'submit'].includes(target.type));
        if (editable) {
          void window.mc.setWindowFocusable(true).then(() => target.focus());
          return;
        }
      }
      target.click();
    };
    const bridge = window as typeof window & { __mcHandlePassthroughMouse?: (event: PassthroughMouseEvent) => void };
    bridge.__mcHandlePassthroughMouse = handle;
    const offMouse = window.mc.onMousePassthroughEvent(handle);
    return () => {
      offMouse();
      delete bridge.__mcHandlePassthroughMouse;
      virtualHoverRef.current?.classList.remove('passthrough-hover');
      virtualHoverRef.current = null;
    };
  }, [paneWeights]);

  useEffect(() => window.mc.onMousePassthroughState((state) => {
    setMousePassthrough(state.enabled);
    setPassthroughError(!!state.failed);
    if (!state.enabled) {
      virtualDownRef.current = null;
      virtualDragRef.current = null;
      virtualHoverRef.current?.classList.remove('passthrough-hover');
      virtualHoverRef.current = null;
      setResizingPanes(false);
    }
  }), []);

  // UI language: settings-driven; ref mirror so stable callbacks stay fresh
  const t = getDict(settings?.ui.lang);
  const tRef = useRef<Dict>(t);
  tRef.current = t;

  const visiblePanes: PaneId[] = scriptEnabled
    ? ['script', 'transcript', 'answer']
    : ['transcript', 'answer'];
  const expandedPanes = visiblePanes.filter((id) => !collapsedPanes[id]);
  const expandedCount = expandedPanes.length;

  const resizePair = (
    left: PaneId,
    right: PaneId,
    leftWidth: number,
    rightWidth: number,
    leftWeight: number,
    rightWeight: number,
    deltaX: number,
  ) => {
    const totalWidth = leftWidth + rightWidth;
    if (totalWidth <= 0) return;
    const minWidth = Math.min(MIN_RESIZED_PANE_WIDTH, totalWidth / 2);
    const nextLeftWidth = Math.max(minWidth, Math.min(totalWidth - minWidth, leftWidth + deltaX));
    const combinedWeight = leftWeight + rightWeight;
    const nextLeftWeight = (nextLeftWidth / totalWidth) * combinedWeight;
    setPaneWeights((current) => ({
      ...current,
      [left]: nextLeftWeight,
      [right]: combinedWeight - nextLeftWeight,
    }));
  };

  const startResize = (left: PaneId, right: PaneId, event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const leftSlot = panesRef.current?.querySelector<HTMLElement>(`[data-pane-id="${left}"]`);
    const rightSlot = panesRef.current?.querySelector<HTMLElement>(`[data-pane-id="${right}"]`);
    if (!leftSlot || !rightSlot) return;
    event.preventDefault();
    resizeRef.current = {
      pointerId: event.pointerId,
      left,
      right,
      startX: event.clientX,
      leftWidth: leftSlot.getBoundingClientRect().width,
      rightWidth: rightSlot.getBoundingClientRect().width,
      leftWeight: paneWeights[left],
      rightWeight: paneWeights[right],
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizingPanes(true);
  };

  const moveResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = resizeRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    resizePair(
      drag.left,
      drag.right,
      drag.leftWidth,
      drag.rightWidth,
      drag.leftWeight,
      drag.rightWeight,
      event.clientX - drag.startX,
    );
  };

  const stopResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (resizeRef.current?.pointerId !== event.pointerId) return;
    resizeRef.current = null;
    setResizingPanes(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const resizeWithKeyboard = (left: PaneId, right: PaneId, event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const leftSlot = panesRef.current?.querySelector<HTMLElement>(`[data-pane-id="${left}"]`);
    const rightSlot = panesRef.current?.querySelector<HTMLElement>(`[data-pane-id="${right}"]`);
    if (!leftSlot || !rightSlot) return;
    event.preventDefault();
    resizePair(
      left,
      right,
      leftSlot.getBoundingClientRect().width,
      rightSlot.getBoundingClientRect().width,
      paneWeights[left],
      paneWeights[right],
      event.key === 'ArrowRight' ? 24 : -24,
    );
  };

  const splitterAfter = (left: PaneId) => {
    const index = expandedPanes.indexOf(left);
    if (index < 0 || index === expandedPanes.length - 1) return null;
    const right = expandedPanes[index + 1];
    const labels: Record<PaneId, string> = {
      script: t.script.title,
      transcript: t.transcript.title,
      answer: t.answer.panelTitle,
    };
    return (
      <div
        key={`split-${left}-${right}`}
        className="pane-splitter"
        role="separator"
        tabIndex={0}
        aria-orientation="vertical"
        aria-label={t.layout.resize(labels[left], labels[right])}
        title={t.layout.resize(labels[left], labels[right])}
        onPointerDown={(event) => startResize(left, right, event)}
        onPointerMove={moveResize}
        onPointerUp={stopResize}
        onPointerCancel={stopResize}
        onLostPointerCapture={() => {
          resizeRef.current = null;
          setResizingPanes(false);
        }}
        onKeyDown={(event) => resizeWithKeyboard(left, right, event)}
      />
    );
  };

  const togglePane = (id: PaneId) => {
    if (!collapsedPanes[id] && expandedCount <= 1) return;
    if (id === 'script' && scriptEditing) {
      setScriptEditing(false);
      void window.mc.setWindowFocusable(false);
    }
    if (collapsedPanes[id]) {
      setPaneWeights((current) => expandWeight(current, id, expandedPanes));
    } else {
      setPaneWeights((current) => collapseWeight(current, id, expandedPanes.filter((pane) => pane !== id)));
    }
    setCollapsedPanes((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const toggleScript = () => {
    if (scriptEnabled) {
      setScriptEditing(false);
      void window.mc.setWindowFocusable(false);
      const remaining = expandedPanes.filter((id) => id !== 'script');
      if (remaining.length === 0) {
        setCollapsedPanes((prev) => ({ ...prev, answer: false }));
      }
      if (!collapsedPanes.script) {
        setPaneWeights((current) => collapseWeight(current, 'script', remaining.length ? remaining : ['answer']));
      }
      setScriptEnabled(false);
    } else {
      setPaneWeights((current) => expandWeight(current, 'script', expandedPanes));
      setCollapsedPanes((prev) => ({ ...prev, script: false }));
      setScriptEnabled(true);
    }
  };

  const editScript = () => {
    void window.mc.setWindowFocusable(true).then(() => setScriptEditing(true));
  };

  const finishScriptEdit = () => {
    setScriptEditing(false);
    void window.mc.setWindowFocusable(false);
  };

  const toggleMousePassthrough = async () => {
    if (passthroughBusy) return;
    setPassthroughBusy(true);
    setPassthroughError(false);
    try {
      const on = await window.mc.setMousePassthrough(!mousePassthrough);
      setMousePassthrough(on);
      if (!on && !mousePassthrough) setPassthroughError(true);
    } catch (error) {
      console.warn('[mouse-passthrough] activation failed:', error);
      setMousePassthrough(false);
      setPassthroughError(true);
    } finally {
      setPassthroughBusy(false);
    }
  };

  if (!loopbackRef.current) loopbackRef.current = new LoopbackCapture();
  if (!themInputRef.current) themInputRef.current = new MicCapture();
  if (!micRef.current) micRef.current = new MicCapture();
  settingsRef.current = settings;
  sessionsRef.current = sessions;
  currentIdRef.current = currentId;

  // The main overlay is created as a non-activating window so clicking its
  // controls does not take focus away from the presentation app. Text inputs
  // are the intentional exception: briefly make the window focusable, focus
  // the clicked control, and restore the overlay behavior after editing.
  useEffect(() => {
    const inputEventTypes = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click'] as const;
    const observedPointerDowns = new Set<number>();
    const nativeMouseActivations: number[] = [];
    const unsubscribeNativeMouseActivation = window.mc.onUiNativeMouseActivation(({ at }) => {
      if (Number.isFinite(at)) nativeMouseActivations.push(at);
    });
    const onInputEvent = (event: Event) => {
      const element = event.target instanceof Element ? event.target : null;
      const target = element?.closest('button, input, select, textarea, summary, [role="button"], a') ?? element;
      const mouse = event instanceof MouseEvent ? event : undefined;
      const pointer = event instanceof PointerEvent ? event : undefined;
      window.mc.debugUiInput({
        type: event.type as (typeof inputEventTypes)[number],
        phase: event.eventPhase === Event.CAPTURING_PHASE ? 'capture' : 'bubble',
        targetTag: target?.tagName.toLowerCase() ?? 'unknown',
        targetId: target?.id || undefined,
        isTrusted: event.isTrusted,
        defaultPrevented: event.defaultPrevented,
        ...(mouse ? { button: mouse.button } : {}),
        ...(pointer ? { pointerType: pointer.pointerType } : {}),
      });
    };
    for (const type of inputEventTypes) {
      document.addEventListener(type, onInputEvent, true);
      document.addEventListener(type, onInputEvent, false);
    }

    const isFocusManagedControl = (target: EventTarget | null): boolean => {
      if (target instanceof HTMLTextAreaElement) return true;
      if (target instanceof HTMLSelectElement) return true;
      if (target instanceof HTMLInputElement) {
        return !['button', 'checkbox', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(
          target.type,
        );
      }
      return target instanceof HTMLElement && target.isContentEditable;
    };

    const restoreOverlayBehavior = (force = false) => {
      window.setTimeout(() => {
        if (force || !isFocusManagedControl(document.activeElement)) {
          void window.mc.setWindowFocusable(false);
        }
      }, 0);
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.isTrusted && event.pointerType === 'mouse' && event.button === 0) {
        observedPointerDowns.add(event.pointerId);
      }
      if (!isFocusManagedControl(event.target)) return;
      const target = event.target as HTMLElement;
      // Keep the browser's normal click/caret placement, then explicitly
      // focus the control after the native window accepts focus again.
      void window.mc.setWindowFocusable(true).then(() => {
        if (document.contains(target)) target.focus();
      });
    };

    const onPointerUp = (event: PointerEvent) => {
      if (!event.isTrusted || event.pointerType !== 'mouse' || event.button !== 0) return;

      const now = Date.now();
      while (nativeMouseActivations.length && now - nativeMouseActivations[0] > 1500) {
        nativeMouseActivations.shift();
      }
      const nativeActivationSeen = nativeMouseActivations.length > 0;
      if (nativeActivationSeen) nativeMouseActivations.shift();
      const pointerDownObserved = observedPointerDowns.delete(event.pointerId);
      if (!shouldSynthesizeMouseClick({
        nativeActivationSeen,
        pointerDownObserved,
        isTrusted: event.isTrusted,
        button: event.button,
      })) return;

      const element = event.target instanceof Element ? event.target : null;
      const target = element?.closest<HTMLElement>(
        'button, input, select, textarea, summary, [role="button"], a, [contenteditable="true"]',
      );
      if (!target || target.getAttribute('aria-disabled') === 'true') return;
      if (
        (target instanceof HTMLButtonElement || target instanceof HTMLInputElement) &&
        target.disabled
      ) return;

      if (isFocusManagedControl(target)) {
        void window.mc.setWindowFocusable(true).then(() => {
          if (document.contains(target)) target.focus();
        });
        return;
      }

      // Electron/Windows can deliver the release after WM_MOUSEACTIVATE while
      // withholding the matching down event. In that case Chromium will never
      // emit click, so invoke the matched control once without activating the
      // overlay or changing the presenter's foreground window.
      window.setTimeout(() => {
        if (target.isConnected) target.click();
      }, 0);
    };

    const onPointerCancel = (event: PointerEvent) => {
      observedPointerDowns.delete(event.pointerId);
    };

    const onDocumentFocusOut = () => restoreOverlayBehavior();
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('pointerup', onPointerUp, true);
    document.addEventListener('pointercancel', onPointerCancel, true);
    document.addEventListener('focusout', onDocumentFocusOut, true);
    const onWindowBlur = () => restoreOverlayBehavior(true);
    window.addEventListener('blur', onWindowBlur);
    return () => {
      for (const type of inputEventTypes) {
        document.removeEventListener(type, onInputEvent, true);
        document.removeEventListener(type, onInputEvent, false);
      }
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('pointerup', onPointerUp, true);
      document.removeEventListener('pointercancel', onPointerCancel, true);
      document.removeEventListener('focusout', onDocumentFocusOut, true);
      window.removeEventListener('blur', onWindowBlur);
      unsubscribeNativeMouseActivation();
    };
  }, []);

  const current = useMemo(
    () => sessions.find((s) => s.id === currentId) ?? null,
    [sessions, currentId],
  );
  const segments = current?.segments ?? [];

  const patchSession = useCallback((id: string, fn: (s: StoredSession) => StoredSession) => {
    setSessions((list) => list.map((s) => (s.id === id ? fn(s) : s)));
  }, []);

  const appendTurn = useCallback(
    (sessionId: string, turn: AnswerTurn) => {
      patchSession(sessionId, (s) => {
        const turns = [...s.turns, turn];
        return { ...s, turns: turns.length > MAX_TURNS ? turns.slice(turns.length - MAX_TURNS) : turns };
      });
    },
    [patchSession],
  );

  const buildHistory = useCallback((): { role: 'user' | 'assistant'; content: string }[] => {
    const s = sessionsRef.current.find((x) => x.id === currentIdRef.current);
    if (!s) return [];
    const done = s.turns.filter((t) => t.status === 'done' && t.kind !== 'translate').slice(-HISTORY_TURNS);
    return done.flatMap((t) => [
      { role: 'user' as const, content: t.label },
      { role: 'assistant' as const, content: t.text },
    ]);
  }, []);

  /** current session's dual-slot material (resume / second resume / memo) */
  const currentMaterial = useCallback((): { resume?: string; secondResume?: string; memo?: string } => {
    const s = sessionsRef.current.find((x) => x.id === currentIdRef.current);
    return {
      resume: s?.resumeText || undefined,
      secondResume: s?.secondResumeText || undefined,
      memo: s?.memo || undefined,
    };
  }, []);

  /** P1-6: ask main to warm the DeepSeek prefix cache for the current material */
  const prewarm = useCallback(
    (immediate: boolean) => {
      const m = currentMaterial();
      window.mc.prewarm({ resume: m.resume, secondResume: m.secondResume, immediate });
    },
    [currentMaterial],
  );

  // P1-5: rolling memo — fold each finished Q&A in asynchronously, one update
  // at a time per session (promise chain), never on the answer critical path
  const memoChain = useRef(new Map<string, Promise<void>>());
  const enqueueMemoUpdate = useCallback(
    (sid: string, question: string, answer: string) => {
      if (!question.trim() || !answer.trim()) return;
      const prev = memoChain.current.get(sid) ?? Promise.resolve();
      const next = prev
        .then(async () => {
          const old = sessionsRef.current.find((x) => x.id === sid)?.memo ?? '';
          const memo = await window.mc.memoUpdate({ memo: old, question, answer });
          if (memo) patchSession(sid, (s) => ({ ...s, memo }));
        })
        .catch(() => {});
      memoChain.current.set(sid, next);
    },
    [patchSession],
  );

  /** auto-name a session from its first real question (once) */
  const maybeTitle = useCallback(
    (sid: string, text?: string) => {
      if (!text?.trim()) return;
      patchSession(sid, (s) =>
        s.titled ? s : { ...s, name: deriveName(text, tRef.current.app.newSession), titled: true },
      );
    },
    [patchSession],
  );

  const askLlm = useCallback(
    (mode: 'segment' | 'continuous' | 'free' | 'translate', text?: string) => {
      const sid = currentIdRef.current;
      if (!sid) return;
      const requestId = uid('req');
      const segs = sessionsRef.current.find((x) => x.id === sid)?.segments ?? [];
      // continuous: resolve the actual question NOW — the other party's latest
      // line — so the turn label (and thus session history) carries the real
      // question instead of a constant '对方最新发言' (v1 history-label bug)
      let question = text;
      if (mode === 'continuous') {
        for (let i = segs.length - 1; i >= 0; i--) {
          if ((segs[i].speaker ?? 'them') === 'them') {
            question = segs[i].text;
            break;
          }
        }
      }
      const label = question ?? (mode === 'continuous' ? tRef.current.app.latestRemark : '');
      appendTurn(sid, { id: requestId, kind: mode, label, text: '', status: 'streaming' });
      if (mode === 'segment' || mode === 'free') maybeTitle(sid, text);
      const material = mode === 'translate' ? {} : currentMaterial();
      const payload: LlmAskPayload = {
        requestId,
        mode,
        question: mode === 'free' ? undefined : question,
        freeQuestion: mode === 'free' ? text : undefined,
        recentTranscript: segs.slice(-30).map((s) => s.text),
        answerLang: answerLangRef.current,
        history: mode === 'translate' ? undefined : buildHistory(),
        ...material,
      };
      window.mc.llmAsk(payload);
    },
    [appendTurn, buildHistory, currentMaterial, maybeTitle],
  );

  const askShot = useCallback(
    (question: string, imageDataUrl?: string) => {
      const sid = currentIdRef.current;
      if (!sid) return;
      const requestId = uid('shot');
      appendTurn(sid, {
        id: requestId,
        kind: 'vision',
        label: question || tRef.current.app.readShot,
        text: '',
        status: 'streaming',
      });
      maybeTitle(sid, question || tRef.current.app.shotQuestion);
      const m = currentMaterial();
      window.mc.shotAsk({
        requestId,
        question,
        resume: m.resume,
        secondResume: m.secondResume,
        imageDataUrl,
      });
    },
    [appendTurn, currentMaterial, maybeTitle],
  );

  /** full-screen screenshot flow (📷 button or hotkey): capture and ask */
  const doScreenShot = useCallback(() => {
    askShot('');
  }, [askShot]);

  // ---- boot: load settings + sessions ----
  useEffect(() => {
    void window.mc.getSettings().then((s) => {
      setSettings(s);
      answerLangRef.current = s.llm.answerLang;
    });
    void window.mc.loadSessions().then((f) => {
      if (f.sessions.length) {
        // heal legacy duplicate segment ids (worker counter used to reset per
        // engine rebuild — translations then landed on multiple bubbles)
        setSessions(
          f.sessions.map((s) =>
            normalizeSessionMaterial(
              { ...s, segments: reindexSegments(s.segments ?? []) },
              tRef.current.app.legacyKbName,
            ),
          ),
        );
        setCurrentId(f.currentId && f.sessions.some((s) => s.id === f.currentId) ? f.currentId : f.sessions[0].id);
      } else {
        const s = newSession(tRef.current.app.sessionN(1));
        setSessions([s]);
        setCurrentId(s.id);
      }
      loaded.current = true;
    });

    const handleAsrEvent = (ev: AsrEvent) => {
      if (ev.kind === 'ready') {
        setAsr((s) => ({ ...s, phase: 'ready', ep: ev.ep, gpuSuspect: ev.gpuSuspect, workerState: 'listening' }));
      } else if (ev.kind === 'status') {
        setAsr((s) => ({ ...s, workerState: ev.state }));
      } else if (ev.kind === 'error') {
        setAsr((s) => ({ ...s, phase: ev.fatal ? 'error' : s.phase, lastError: ev.message }));
      } else if (ev.kind === 'partial') {
        setPartials((p) => ({ ...p, [ev.speaker]: ev.text }));
      } else if (ev.kind === 'segment') {
        setPartials((p) => ({ ...p, [ev.speaker]: undefined })); // final replaces the live partial
        const e2eMs = Date.now() - ev.timings.speechEndTs;
        const inferMs = ev.timings.inferEndTs - ev.timings.inferStartTs;
        e2eSamples.current.push(e2eMs);
        if (e2eSamples.current.length > 200) e2eSamples.current.shift();
        setHud({
          lastE2eMs: e2eMs,
          lastInferMs: inferMs,
          p50: percentile(e2eSamples.current, 50),
          p95: percentile(e2eSamples.current, 95),
          count: e2eSamples.current.length,
        });
        const sid = currentIdRef.current;
        setSessions((list) =>
          list.map((s) =>
            s.id === sid
              ? {
                  ...s,
                  segments: appendSegment(s.segments ?? [], {
                    // NOT ev.id: the worker counter resets per engine rebuild,
                    // duplicating ids inside a persisted session
                    id: nextSegmentId(s.segments ?? []),
                    text: ev.text,
                    lang: ev.lang,
                    speaker: ev.speaker,
                    startTs: ev.timings.speechStartTs,
                    endTs: ev.timings.speechEndTs,
                    e2eMs,
                    inferMs,
                  }),
                }
              : s,
          ),
        );
      }
    };
    const off = window.mc.onAsrEvent(handleAsrEvent);
    // instant-ready cloud engines emit ready/status BEFORE this subscription
    // exists — pull the last ones so the UI never sticks at "模型加载中"
    void window.mc.asrReplay().then(({ ready, status }) => {
      if (ready) handleAsrEvent(ready);
      if (status) handleAsrEvent(status);
    });

    const offLlm = window.mc.onLlmEvent((ev) => {
      setSessions((list) =>
        list.map((s) => ({
          ...s,
          turns: s.turns.map((t) => {
            if (t.id !== ev.requestId) return t;
            if (ev.kind === 'delta') return { ...t, text: t.text + ev.text };
            if (ev.kind === 'done') return { ...t, text: ev.text || t.text, status: 'done' };
            return { ...t, status: 'error', error: ev.message };
          }),
        })),
      );
      // fold finished ANSWER turns into the session memo (async, off-path);
      // translate/vision turns are not interview Q&A
      if (ev.kind === 'done') {
        const s = sessionsRef.current.find((x) => x.turns.some((t) => t.id === ev.requestId));
        const t = s?.turns.find((x) => x.id === ev.requestId);
        if (s && t && (t.kind === 'segment' || t.kind === 'continuous' || t.kind === 'free')) {
          enqueueMemoUpdate(s.id, t.label, ev.text || t.text);
        }
      }
    });

    const offShot = window.mc.onShotHotkey(() => doScreenShot());

    window.__mcAutoStart = () => void startCapture();
    // visual-QA hooks (MC_MAIN_SHOT in electron/main.ts): open a panel from the
    // main process so it can be screenshotted
    window.__mcOpenSettings = () => setShowSettings(true);
    window.__mcOpenHelp = () => setShowHelp(true);
    return () => {
      off();
      offLlm();
      offShot();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- persist sessions (debounced) ----
  useEffect(() => {
    if (!loaded.current) return;
    const t = setTimeout(() => window.mc.saveSessions({ sessions, currentId }), 400);
    return () => clearTimeout(t);
  }, [sessions, currentId]);

  // ---- apply UI theme + answer font scale to the document root ----
  useEffect(() => {
    const ui = settings?.ui;
    if (!ui) return;
    document.documentElement.dataset.fontScale = ui.fontScale ?? 'medium';
    const apply = () => {
      const mode = ui.theme ?? 'dark';
      const dark =
        mode === 'system' ? window.matchMedia('(prefers-color-scheme: dark)').matches : mode === 'dark';
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    };
    apply();
    if ((ui.theme ?? 'dark') !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [settings]);

  // auto-dismiss the KB parse notice
  useEffect(() => {
    if (!kbNotice) return;
    const t = setTimeout(() => setKbNotice(null), 8000);
    return () => clearTimeout(t);
  }, [kbNotice]);

  // switching sessions swaps the material → prefix dirty (reheats if capturing)
  useEffect(() => {
    if (!loaded.current || !currentId) return;
    prewarm(false);
  }, [currentId, prewarm]);

  // continuous mode: only the OTHER party's questions trigger it (never my own
  // mic), question-gated + append, per current session.
  const lastSeg = segments.length ? segments[segments.length - 1] : null;
  useEffect(() => {
    if (!continuous || !lastSeg) return;
    if ((lastSeg.speaker ?? 'them') !== 'them') return; // ignore my own voice
    if (!isLikelyQuestion(lastSeg.text)) return;
    const timer = setTimeout(() => askLlm('continuous'), 1100);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [continuous, lastSeg?.id, lastSeg?.endTs]);

  // Windows: Electron system loopback. macOS/Linux: selected ordinary input
  // (typically a virtual audio device for meeting/system audio).
  const startCapture = useCallback(async () => {
    const inputMode = captureKindForPlatform(window.mc.platform) === 'input';
    const cap = inputMode ? themInputRef.current! : loopbackRef.current!;
    if (cap.running) return;
    try {
      if (inputMode) {
        await themInputRef.current!.start(
          settingsRef.current?.audio.themDeviceId,
          (buf, ts) => window.mc.sendPcm(buf, ts, 'them'),
          { audioProcessing: false },
        );
        void listMics().then(setMics).catch(() => undefined);
      } else {
        await loopbackRef.current!.start((buf, ts) => window.mc.sendPcm(buf, ts, 'them'));
      }
      window.mc.captureStarted();
      setCapturing(true);
      prewarm(true); // ▶ = the meeting starts — build the KV prefix cache now
    } catch (e) {
      setAsr((s) => ({ ...s, lastError: tRef.current.app.captureStartFail((e as Error).message) }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stopCapture = useCallback(async () => {
    const cap =
      captureKindForPlatform(window.mc.platform) === 'input'
        ? themInputRef.current!
        : loopbackRef.current!;
    await cap.stop();
    window.mc.captureStopped();
    setCapturing(false);
  }, []);

  // 🎤 独立麦克风采集：只转麦克风(我)，与系统声音互不影响，按钮直接控制起停
  const toggleMicCapture = useCallback(async () => {
    const mic = micRef.current!;
    if (mic.running) {
      await mic.stop();
      setMicActive(false);
      return;
    }
    try {
      await mic.start(settings?.audio.micDeviceId, (buf, ts) => window.mc.sendPcm(buf, ts, 'me'));
      setMicActive(true);
      if (mics.length === 0) void listMics().then(setMics);
    } catch (e) {
      setAsr((s) => ({ ...s, lastError: tRef.current.app.micStartFail((e as Error).message) }));
    }
  }, [settings, mics]);

  const setSeg = useCallback(
    (segId: number, patch: Partial<TranscriptSegment>) => {
      const sid = currentIdRef.current;
      setSessions((list) =>
        list.map((s) =>
          s.id === sid
            ? { ...s, segments: (s.segments ?? []).map((g) => (g.id === segId ? { ...g, ...patch } : g)) }
            : s,
        ),
      );
    },
    [],
  );

  const translateSegment = useCallback(
    (seg: TranscriptSegment) => {
      if (seg.translating) return; // re-translating an already-translated bubble is allowed
      setSeg(seg.id, { translating: true });
      window.mc
        .translate(seg.text)
        .then((zh) => setSeg(seg.id, { translation: zh, translating: false }))
        .catch(() => setSeg(seg.id, { translation: tRef.current.app.translateFail, translating: false }));
    },
    [setSeg],
  );

  const toggleStealth = useCallback(async () => {
    if (!settings) return;
    const on = await window.mc.setStealth(!settings.ui.stealth);
    setSettings({ ...settings, ui: { ...settings.ui, stealth: on } });
  }, [settings]);

  const toggleAnswerLang = useCallback(async () => {
    if (!settings) return;
    const next: AnswerLang = settings.llm.answerLang === 'chinese' ? 'english' : 'chinese';
    answerLangRef.current = next;
    const updated = await window.mc.setSettings({ llm: { answerLang: next } });
    setSettings(updated);
    answerLangRef.current = updated.llm.answerLang;
    prewarm(false); // lang is part of the stable prefix → mark dirty / reheat
  }, [settings, prewarm]);

  const toggleAnswerModel = useCallback(async () => {
    if (!settings) return;
    const updated = await window.mc.setSettings({ llm: { answerWithVision: !settings.llm.answerWithVision } });
    setSettings(updated);
  }, [settings]);

  const selectMic = useCallback(
    async (deviceId: string) => {
      const updated = await window.mc.setSettings({ audio: { micDeviceId: deviceId || undefined } });
      setSettings(updated);
      // if the mic is currently on, restart it on the newly chosen device
      const mic = micRef.current!;
      if (mic.running) {
        await mic.stop();
        await mic
          .start(deviceId || undefined, (buf, ts) => window.mc.sendPcm(buf, ts, 'me'))
          .catch(() => setMicActive(false));
      }
    },
    [],
  );

  const selectThemInput = useCallback(async (deviceId: string) => {
    const updated = await window.mc.setSettings({ audio: { themDeviceId: deviceId || undefined } });
    setSettings(updated);
    settingsRef.current = updated;
    const input = themInputRef.current!;
    if (input.running) {
      await input.stop();
      await input
        .start(
          deviceId || undefined,
          (buf, ts) => window.mc.sendPcm(buf, ts, 'them'),
          { audioProcessing: false },
        )
        .catch((e) => {
          window.mc.captureStopped();
          setCapturing(false);
          setAsr((s) => ({ ...s, lastError: tRef.current.app.themInputSwitchFail((e as Error).message) }));
        });
    }
  }, []);

  const clearTranscript = useCallback(() => {
    patchSession(currentIdRef.current, (s) => ({ ...s, segments: [] }));
  }, [patchSession]);

  const cancelTurn = useCallback(
    (id: string) => {
      window.mc.llmCancel(id);
      patchSession(currentIdRef.current, (s) => ({
        ...s,
        turns: s.turns.map((t) => (t.id === id ? { ...t, status: 'done' } : t)),
      }));
    },
    [patchSession],
  );

  const createSession = useCallback(() => {
    const s = newSession(tRef.current.app.sessionN(sessionsRef.current.length + 1));
    setSessions((list) => [...list, s]);
    setCurrentId(s.id);
  }, []);

  const deleteSession = useCallback((id: string) => {
    setSessions((list) => {
      const next = list.filter((s) => s.id !== id);
      if (next.length === 0) {
        const s = newSession(tRef.current.app.sessionN(1));
        setCurrentId(s.id);
        return [s];
      }
      setCurrentId((cur) => (cur === id ? next[0].id : cur));
      return next;
    });
  }, []);

  const renameSession = useCallback(
    (id: string, name: string) => {
      patchSession(id, (s) => ({ ...s, name: name.trim() || s.name, titled: true }));
    },
    [patchSession],
  );

  /** the overlays are mutually exclusive: one panel at a time, never stacked */
  const closePanels = useCallback(() => {
    setShowSettings(false);
    setShowHealth(false);
    setShowDiagnostics(false);
    setShowHelp(false);
  }, []);

  /**
   * Tray menu -> renderer (Phase 4 §A). Main only forwards what it cannot do
   * itself, and it has already made the window visible. 开始/停止转写
   * deliberately runs the SAME code path as the title-bar button, readiness
   * gate included, so the two can never disagree. Re-subscribed whenever that
   * state changes — cheaper and less error-prone than a fistful of refs.
   */
  useEffect(() => {
    return window.mc.onTrayCommand(({ command }) => {
      switch (command) {
        case 'toggle-capture':
          if (capturing) void stopCapture();
          else if (asr.phase === 'ready') void startCapture();
          return;
        case 'new-session':
          createSession();
          return;
        case 'open-settings':
          closePanels();
          setShowSettings(true);
          return;
        case 'open-health':
          closePanels();
          setShowHealth(true);
          return;
        case 'open-help':
          closePanels();
          setShowHelp(true);
          return;
      }
    });
  }, [capturing, asr.phase, startCapture, stopCapture, createSession, closePanels]);

  const pickKb = useCallback(
    async (slot: KbSlot) => {
      const r = await window.mc.pickKnowledge(slot);
      if (!r) return;
      if (!r.text.trim()) {
        // deterministic parsers return '' for scanned/image-only PDFs
        setKbNotice(tRef.current.app.kbNoText(r.name));
        return;
      }
      setKbNotice(null);
      patchSession(currentIdRef.current, (s) =>
        slot === 'resume'
          ? { ...s, resumeName: r.name, resumeText: r.text }
          : { ...s, secondResumeName: r.name, secondResumeText: r.text },
      );
      // material changed → reheat the prefix cache with the fresh bytes;
      // patchSession is async (React state), so pass the new slots directly
      window.mc.prewarm({
        resume: slot === 'resume' ? r.text : currentMaterial().resume,
        secondResume: slot === 'secondResume' ? r.text : currentMaterial().secondResume,
        immediate: true,
      });
    },
    [patchSession, currentMaterial],
  );

  const clearKb = useCallback(
    (slot: KbSlot) => {
      patchSession(currentIdRef.current, (s) =>
        slot === 'resume'
          ? { ...s, resumeName: undefined, resumeText: undefined }
          : { ...s, secondResumeName: undefined, secondResumeText: undefined },
      );
      // prefix went stale; reheats now if capturing, else at the next ▶
      window.mc.prewarm({
        resume: slot === 'resume' ? undefined : currentMaterial().resume,
        secondResume: slot === 'secondResume' ? undefined : currentMaterial().secondResume,
      });
    },
    [patchSession, currentMaterial],
  );

  /** the v1 -> v2 migration marks hand-configured profiles; show the notice
   * once until the user dismisses it (persisted in onboarding state) */
  const showUpgradeNotice =
    !!settings &&
    settings.version === 2 &&
    settings.onboarding.completed &&
    !!settings.onboarding.migratedFromV1 &&
    !settings.onboarding.dismissedUpgradePrompt;

  const dismissUpgradeNotice = async () => {
    const onboarding = await window.mc.saveOnboardingProgress({ dismissedUpgradePrompt: true });
    setSettings((s) => (s ? { ...s, onboarding } : s));
  };

  const visionReady =
    !!settings?.llm.answerWithVision &&
    !!settings?.vision.baseUrl &&
    !!settings?.vision.model &&
    !!settings?.vision.apiKeySet;

  /**
   * One derivation for the status chips, the health panel and the answer
   * gating (shared/healthState.ts). A missing LLM key disables the answer
   * buttons with an explanation instead of letting every click produce the
   * same main-process error turn — but it never blocks transcription.
   */
  const health = useMemo(
    () => (settings ? deriveServiceHealth({ settings, asr, capturing }) : null),
    [settings, asr, capturing],
  );
  const answersReady = health?.answersAvailable ?? true;

  return (
    <I18nProvider lang={settings?.ui.lang}>
    <div className="app">
      <header className="titlebar">
          <span className="brand">{APP_DISPLAY_NAME}</span>
        <div className="titlebar-actions">
          <button
            className={capturing ? 'btn btn-live' : 'btn btn-primary'}
            onClick={() => (capturing ? void stopCapture() : void startCapture())}
            disabled={asr.phase !== 'ready'}
            title={
              captureKindForPlatform(window.mc.platform) === 'loopback'
                ? capturing
                  ? t.titlebar.stopTitle
                  : t.titlebar.startTitle
                : capturing
                  ? t.titlebar.stopInputTitle
                  : t.titlebar.startInputTitle
            }
          >
            {capturing ? t.titlebar.stop : t.titlebar.start}
          </button>
          {captureKindForPlatform(window.mc.platform) === 'input' && mics.length > 0 && (
            <select
              className="mic-select"
              value={settings?.audio.themDeviceId ?? ''}
              onChange={(e) => void selectThemInput(e.target.value)}
              title={t.titlebar.themDeviceTitle}
            >
              <option value="">{t.titlebar.themDeviceDefault}</option>
              {mics.map((m) => (
                <option key={m.deviceId} value={m.deviceId}>
                  {(m.label || t.titlebar.themDeviceDefault).slice(0, 14)}
                </option>
              ))}
            </select>
          )}
          <button
            className={continuous ? 'btn btn-on' : 'btn'}
            onClick={() => setContinuous((v) => !v)}
            title={t.titlebar.continuousTitle}
          >
            {t.titlebar.continuous}
          </button>
          <button
            className={scriptEnabled ? 'btn btn-on' : 'btn'}
            onClick={toggleScript}
            title={t.titlebar.scriptTitle}
            aria-pressed={scriptEnabled}
          >
            {t.titlebar.script(scriptEnabled)}
          </button>
          <button
            className={settings?.llm.answerWithVision ? 'btn btn-on' : 'btn'}
            onClick={() => void toggleAnswerModel()}
            title={t.titlebar.modelTitle}
          >
            {settings?.llm.answerWithVision ? t.titlebar.vision : t.titlebar.textOnly}
          </button>
          <button className="btn" onClick={() => void toggleAnswerLang()} title={t.titlebar.answerLangTitle}>
            {t.titlebar.answerLang(settings?.llm.answerLang === 'english')}
          </button>
          <button
            className={micActive ? 'btn btn-live' : 'btn'}
            onClick={() => void toggleMicCapture()}
            title={t.titlebar.micTitle}
          >
            {micActive ? t.titlebar.micOn : t.titlebar.micOff}
          </button>
          {micActive && mics.length > 0 && (
            <select
              className="mic-select"
              value={settings?.audio.micDeviceId ?? ''}
              onChange={(e) => void selectMic(e.target.value)}
              title={t.titlebar.micDeviceTitle}
            >
              <option value="">{t.titlebar.micDefault}</option>
              {mics.map((m) => (
                <option key={m.deviceId} value={m.deviceId}>
                  {(m.label || t.titlebar.micDefault).slice(0, 10)}
                </option>
              ))}
            </select>
          )}
          <button
            className={settings?.ui.stealth ? 'btn btn-on' : 'btn'}
            onClick={() => void toggleStealth()}
            title={
              window.mc.platform === 'darwin'
                ? t.titlebar.stealthMacTitle
                : t.titlebar.stealthTitle
            }
          >
            {t.titlebar.stealth(!!settings?.ui.stealth)}
          </button>
          <button
            className={mousePassthrough ? 'btn btn-on' : 'btn'}
            onClick={() => void toggleMousePassthrough()}
            disabled={passthroughBusy || window.mc.platform !== 'win32'}
            title={window.mc.platform === 'win32' ? t.titlebar.passthroughTitle : t.titlebar.passthroughUnsupported}
            aria-pressed={mousePassthrough}
          >
            {t.titlebar.passthrough(mousePassthrough)}
          </button>
          <button className="btn" onClick={() => setShowHud((v) => !v)} title={t.titlebar.hudTitle}>
            HUD
          </button>
          <button className="btn" onClick={() => setShowSettings((v) => !v)} title={t.titlebar.settingsTitle}>
            ⚙
          </button>
          <button className="btn" onClick={() => window.mc.hide()} title={t.titlebar.hideTitle}>
            —
          </button>
          <button className="btn btn-close" onClick={() => window.mc.quit()} title={t.titlebar.quitTitle}>
            ✕
          </button>
        </div>
      </header>

      {passthroughError && <div className="passthrough-error" role="alert">{t.titlebar.passthroughFailed}</div>}

      {/* grandfathered users (settings.json predates the wizard) get one
          dismissible pointer at the new wizard; wizard-created profiles never
          carry onboarding.migratedFromV1, so they never see it */}
      {showUpgradeNotice && (
        <div className="upgrade-banner">
          <span>{t.app.upgradeNotice}</span>
          <button className="btn btn-sm btn-primary" onClick={() => void window.mc.rerunOnboarding()}>
            {t.app.upgradeCheck}
          </button>
          <button className="btn btn-sm" onClick={() => void dismissUpgradeNotice()}>
            {t.app.upgradeSkip}
          </button>
        </div>
      )}

      {showHealth && settings && health && (
        <ServiceHealthPanel
          settings={settings}
          health={health}
          onClose={() => setShowHealth(false)}
          onOpenSettings={() => {
            setShowHealth(false);
            setShowSettings(true);
          }}
          onOpenDiagnostics={() => {
            setShowHealth(false);
            setShowDiagnostics(true);
          }}
          onSettingsRefreshed={setSettings}
        />
      )}

      {showDiagnostics && <DiagnosticsPanel onClose={() => setShowDiagnostics(false)} />}

      {showHelp && (
        <HelpPanel
          onClose={() => setShowHelp(false)}
          onOpenSettings={() => {
            setShowHelp(false);
            setShowSettings(true);
          }}
          onOpenDiagnostics={() => {
            setShowHelp(false);
            setShowDiagnostics(true);
          }}
        />
      )}

      {showSettings && settings && (
        <SettingsPanel
          settings={settings}
          onSaved={(s) => {
            setSettings(s);
            answerLangRef.current = s.llm.answerLang;
            setShowSettings(false);
          }}
          onClose={() => setShowSettings(false)}
          onRerunWizard={() => {
            setShowSettings(false);
            void window.mc.rerunOnboarding();
          }}
          onOpenDiagnostics={() => {
            setShowSettings(false);
            setShowDiagnostics(true);
          }}
          onOpenHelp={() => {
            setShowSettings(false);
            setShowHelp(true);
          }}
          onOpacityPreview={previewWindowOpacity}
        />
      )}

      <div className={`panes${resizingPanes ? ' panes-resizing' : ''}`} ref={panesRef}>
        {scriptEnabled && (
          <PaneSlot
            id="script"
            label={t.script.title}
            collapsed={collapsedPanes.script}
            weight={paneWeights.script}
            onExpand={() => togglePane('script')}
          >
            <ScriptPanel
              text={scriptText}
              editing={scriptEditing}
              canCollapse={expandedCount > 1}
              onTextChange={setScriptText}
              onEdit={editScript}
              onDone={finishScriptEdit}
              onCollapse={() => togglePane('script')}
            />
          </PaneSlot>
        )}
        {scriptEnabled && splitterAfter('script')}
        <PaneSlot
          id="transcript"
          label={t.transcript.title}
          collapsed={collapsedPanes.transcript}
          weight={paneWeights.transcript}
          onExpand={() => togglePane('transcript')}
        >
          <TranscriptPanel
            segments={segments}
            partials={partials}
            answersReady={answersReady}
            answersHint={t.health.answersDisabled}
            onAsk={(text) => askLlm('segment', text)}
            onTranslate={translateSegment}
            onClear={clearTranscript}
            collapsed={collapsedPanes.transcript}
            canCollapse={expandedCount > 1}
            onCollapse={() => togglePane('transcript')}
          />
        </PaneSlot>
        {splitterAfter('transcript')}
        <PaneSlot
          id="answer"
          label={t.answer.panelTitle}
          collapsed={collapsedPanes.answer}
          weight={paneWeights.answer}
          onExpand={() => togglePane('answer')}
        >
          <AnswerSession
            sessions={sessions}
            currentId={currentId}
            turns={current?.turns ?? []}
            resumeName={current?.resumeName}
            resumeChars={current?.resumeText?.length ?? 0}
            secondResumeName={current?.secondResumeName}
            secondResumeChars={current?.secondResumeText?.length ?? 0}
            notice={kbNotice}
            visionReady={visionReady}
            answersReady={answersReady}
            answersHint={t.health.answersDisabled}
            onSwitch={setCurrentId}
            onNew={createSession}
            onDelete={deleteSession}
            onRename={renameSession}
            onPickKb={(slot) => void pickKb(slot)}
            onClearKb={clearKb}
            onCancel={cancelTurn}
            onClear={() => patchSession(currentIdRef.current, (s) => ({ ...s, turns: [] }))}
            onFreeAsk={(q) => askLlm('free', q)}
            onShotAsk={askShot}
            canCollapse={expandedCount > 1}
            onCollapse={() => togglePane('answer')}
          />
        </PaneSlot>
      </div>

      <StatusBar
        asr={asr}
        capturing={capturing}
        hud={showHud ? hud : undefined}
        health={health ?? undefined}
        onOpenHealth={() => setShowHealth((v) => !v)}
      />
    </div>
    </I18nProvider>
  );
}
