import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { AdminRoom, AdminSourceTest, RuntimeConfig, SessionRecord, SourceLanguage } from '@nerditulos/shared';
import { ApiError, adminApi, type TokenSupplier } from '../api.js';
import { LANGUAGE_NATIVE_NAMES, stateLabel } from '../i18n.js';
import { IconFileAudio, IconMic, IconTriangleAlert, IconUser, StatusIcon } from '../icons.js';
import { hrefWithLang, langFromSearch } from '../language.js';
import { useLanguage } from '../LanguageProvider.js';
import { LanguageSwitch } from '../LanguageSwitch.js';
import { adminPath, navigate, onLinkClick, replace } from '../router.js';
import { formatDbfs, meterFraction, NO_SIGNAL_RMS, toDbfs } from './capture/level.js';
import { noticeText } from './capture/notices.js';
import { testEndMessage } from './capture/preview.js';
import { getCapture, type CaptureSnapshot } from './capture/runtime.js';
import { checkLabel, consoleView, formatElapsed, formatTrackProcessing, startWarningText } from './capture/viewModel.js';
import { consoleStrings, type ConsoleStrings } from './consoleStrings.js';
import { drafts } from './drafts.js';
import { useAdminIdentity } from './identity.js';
import { openReaderWindow, readerPath, readerWindowName } from './readerWindow.js';
import { createSequence } from './sequence.js';
import { decideAfterTestActive, decideStart } from './startDecision.js';

type Gate =
  | { kind: 'checking' }
  | { kind: 'ok'; userId: string | null }
  | { kind: 'not_configured' }
  | { kind: 'forbidden' }
  | { kind: 'unauthenticated' }
  /** Demo mode was switched off while this tab was open: nothing works until a reload. */
  | { kind: 'demo_disabled' }
  | { kind: 'error' };

function gateMessage(d: ConsoleStrings, gate: Gate): { text: string; tone: 'error' | 'warning' } | null {
  switch (gate.kind) {
    case 'not_configured':
      return { text: d.gateNotConfigured, tone: 'warning' };
    case 'forbidden':
      return { text: d.gateForbidden, tone: 'error' };
    case 'unauthenticated':
      return { text: d.gateUnauthenticated, tone: 'error' };
    case 'demo_disabled':
      return { text: d.demoDisabled, tone: 'warning' };
    case 'error':
      return { text: d.gateCheckFailed, tone: 'error' };
    default:
      return null;
  }
}

const ACTIVE_STATES = new Set(['starting', 'live', 'interrupted', 'finishing']);
/** A `starting` session without a sender is offered to other consoles only after this long. */
const ORPHAN_START_MS = 10000;
const POLL_MS = 5000;

function activeSession(room: AdminRoom): SessionRecord | null {
  return room.sessions.find((s) => ACTIVE_STATES.has(s.state)) ?? null;
}

export function ConsolePage({ config, roomSlug }: { config: RuntimeConfig; roomSlug: string | null }) {
  const [lang] = useLanguage();
  const d = consoleStrings(lang);
  const identity = useAdminIdentity();
  const tokenSupplier = identity.getToken;
  const demo = identity.kind === 'demo';
  const [gate, setGate] = useState<Gate>({ kind: 'checking' });
  const [rooms, setRooms] = useState<AdminRoom[] | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const sequence = useRef(createSequence());
  const gateRef = useRef(gate);
  gateRef.current = gate;

  /** A 401 in demo means the server left demo mode: stop everything until a reload. */
  const onAuthLost = useCallback(() => {
    setGate(demo ? { kind: 'demo_disabled' } : { kind: 'unauthenticated' });
  }, [demo]);

  const loadRooms = useCallback(async () => {
    if (gateRef.current.kind !== 'ok' && gateRef.current.kind !== 'checking') return;
    const n = sequence.current.issue();
    try {
      const result = await adminApi.rooms(tokenSupplier);
      if (!sequence.current.accept(n)) return;
      setRooms(result.rooms);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onAuthLost();
      else if (error instanceof ApiError && error.status === 403) setGate({ kind: 'forbidden' });
      else if (error instanceof ApiError && error.status === 503) setGate({ kind: 'not_configured' });
    }
  }, [tokenSupplier, onAuthLost]);

  useEffect(() => {
    let cancelled = false;
    adminApi
      .me(tokenSupplier)
      .then((me) => {
        if (cancelled) return;
        setGate({ kind: 'ok', userId: me.mode === 'clerk' ? me.userId : null });
        void loadRooms();
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 503 && error.code === 'admin_not_configured') setGate({ kind: 'not_configured' });
        else if (error instanceof ApiError && error.status === 403) setGate({ kind: 'forbidden' });
        else if (error instanceof ApiError && error.status === 401) onAuthLost();
        else setGate({ kind: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [tokenSupplier, loadRooms, onAuthLost]);

  // Polling only while the tab is visible; coming back (visibility, focus) refreshes right away.
  useEffect(() => {
    if (gate.kind !== 'ok') return;
    let timer: number | null = null;
    const stop = () => {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
    };
    const startPolling = () => {
      stop();
      if (document.visibilityState === 'visible') timer = window.setInterval(() => void loadRooms(), POLL_MS);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void loadRooms();
      startPolling();
    };
    const onFocus = () => void loadRooms();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onFocus);
    startPolling();
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onFocus);
    };
  }, [gate.kind, loadRooms]);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [menuOpen]);

  useEffect(() => {
    document.title = `${config.eventName || d.appTitle} · ${d.consoleTitle}`;
  }, [config.eventName, d.appTitle, d.consoleTitle]);

  // `/admin` canonicalizes to the first room; an unknown slug keeps the tabs and shows no panel.
  const knownSlug = rooms?.some((r) => r.slug === roomSlug) ?? false;
  useEffect(() => {
    if (!rooms || rooms.length === 0 || roomSlug !== null) return;
    const first = rooms[0];
    if (first) replace(adminPath(first.slug) + window.location.search);
  }, [rooms, roomSlug]);
  const selectedRoom = knownSlug ? roomSlug : null;

  const liveRooms = (rooms ?? []).filter((r) => activeSession(r)?.state === 'live');
  useEffect(() => {
    document.documentElement.style.setProperty('--status-bar-height', liveRooms.length > 0 ? '40px' : '0px');
    return () => document.documentElement.style.setProperty('--status-bar-height', '0px');
  }, [liveRooms.length]);

  const message = gateMessage(d, gate);
  const accountName = identity.kind === 'clerk' ? identity.accountName : null;

  return (
    <div className="console">
      <a className="skip-link" href="#main">
        {d.skipToContent}
      </a>
      <header className="console__header">
        <a href={hrefWithLang('/', langFromSearch(window.location.search))} onClick={onLinkClick} aria-label={d.roomsLink}>
          <img className="console__logo" src="/brand/nerdearla-simplified.svg" alt="Nerdearla" />
        </a>
        {config.demoMode && <span className="chip chip--status-warning">{d.demoChip}</span>}
        <span className="console__spacer" />
        {/* Interface language only: a session's source language is chosen per session below. */}
        <LanguageSwitch />
        <div className="account-menu" ref={menuRef}>
          <button type="button" className="btn btn--outline btn--icon" aria-label={d.accountMenu} aria-expanded={menuOpen} aria-controls="account-panel" onClick={() => setMenuOpen((v) => !v)}>
            <IconUser />
          </button>
          {menuOpen && (
            <div className="dropdown" id="account-panel">
              {identity.kind === 'demo' ? (
                <div className="dropdown__identity">
                  <p className="dropdown__account">{d.demoIdentity}</p>
                </div>
              ) : (
                <>
                  {(accountName || gate.kind === 'ok') && (
                    <div className="dropdown__identity">
                      {accountName && <p className="dropdown__account">{accountName}</p>}
                      {gate.kind === 'ok' && gate.userId && <p className="dropdown__meta">{gate.userId}</p>}
                    </div>
                  )}
                  <button type="button" className="dropdown__item" onClick={() => identity.signOut()}>
                    {d.signOut}
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </header>
      {liveRooms.length > 0 && (
        <div className="status-bar" role="status">
          <span className="chip chip--live">{d.stateLive}</span>
          {liveRooms.map((r) => (
            <span key={r.slug} className="status-bar__room">
              <span className="status-dot status-dot--live" />
              <span className="chip chip--room" style={{ ['--room' as string]: `var(--room-${((r.index - 1) % 8) + 1})` } as React.CSSProperties}>
                {r.name}
              </span>
              <span className="card__meta">{activeSession(r)?.title}</span>
            </span>
          ))}
        </div>
      )}
      <main className="console__main" id="main">
        {gate.kind === 'checking' && <p className="page-loading">{d.checkingAuth}</p>}
        {message && (
          <div className={`banner banner--${message.tone}`} role="alert">
            {message.text}
            {gate.kind === 'demo_disabled' && (
              <button type="button" className="btn btn--secondary" onClick={() => window.location.reload()}>
                {d.reload}
              </button>
            )}
          </div>
        )}
        {gate.kind === 'ok' && !rooms && <p className="page-loading">{d.roomsLoading}</p>}
        {(gate.kind === 'ok' || gate.kind === 'demo_disabled') && rooms && rooms.length > 1 && (
          <div className="tabs" role="tablist" aria-label={d.roomsTabs}>
            {rooms.map((room) => {
              const active = activeSession(room);
              const go = (slug: string) => navigate(adminPath(slug) + window.location.search);
              return (
                <button
                  key={room.slug}
                  type="button"
                  role="tab"
                  className="tab"
                  id={`tab-${room.slug}`}
                  aria-selected={selectedRoom === room.slug}
                  aria-controls={`panel-${room.slug}`}
                  tabIndex={selectedRoom === room.slug ? 0 : -1}
                  onClick={() => go(room.slug)}
                  onKeyDown={(e) => {
                    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
                    const index = rooms.findIndex((r) => r.slug === room.slug);
                    const next = rooms[(index + (e.key === 'ArrowRight' ? 1 : rooms.length - 1)) % rooms.length];
                    if (next) {
                      go(next.slug);
                      document.getElementById(`tab-${next.slug}`)?.focus();
                    }
                  }}
                >
                  <span className="tab__title">{room.name}</span>
                  <span className="tab__meta">{active ? `${active.title} · ${stateLabel(d, active.state).text}` : d.noActiveSession}</span>
                </button>
              );
            })}
          </div>
        )}
        {gate.kind === 'ok' && rooms && rooms.length > 0 && roomSlug !== null && !knownSlug && <p className="card__meta">{d.chooseRoom}</p>}
        {(gate.kind === 'ok' || gate.kind === 'demo_disabled') &&
          rooms &&
          rooms.map((room) => (
            // Every room panel stays mounted; tabs only change visibility, so capture never unmounts.
            <div key={room.slug} id={`panel-${room.slug}`} role={rooms.length > 1 ? 'tabpanel' : undefined} aria-labelledby={rooms.length > 1 ? `tab-${room.slug}` : undefined} hidden={rooms.length > 1 && selectedRoom !== room.slug}>
              <RoomPanel room={room} getToken={tokenSupplier} onChanged={loadRooms} onAuthLost={onAuthLost} drainTimeoutMs={config.drainTimeoutMs} appOrigin={config.appOrigin} disabled={gate.kind !== 'ok'} />
            </div>
          ))}
      </main>
      <footer className="footer" style={{ textAlign: 'center' }}>
        {d.footer}
      </footer>
    </div>
  );
}

function useCapture(slug: string): CaptureSnapshot {
  const capture = getCapture(slug);
  return useSyncExternalStore(
    (listener) => capture.subscribe(listener),
    () => capture.snapshot(),
    () => capture.snapshot(),
  );
}

function useDraft(slug: string) {
  return useSyncExternalStore(
    (listener) => drafts.subscribe(slug, listener),
    () => drafts.get(slug),
    () => drafts.get(slug),
  );
}

interface SessionTarget {
  sessionId: string;
  title: string;
}

interface StartTarget extends SessionTarget {
  testId: string;
  testSourceLanguage: SourceLanguage;
}

function RoomPanel({
  room,
  getToken,
  onChanged,
  onAuthLost,
  drainTimeoutMs,
  appOrigin,
  disabled,
}: {
  room: AdminRoom;
  getToken: TokenSupplier;
  onChanged: () => Promise<void>;
  onAuthLost: () => void;
  drainTimeoutMs: number;
  appOrigin: string;
  disabled: boolean;
}) {
  const [lang] = useLanguage();
  const d = consoleStrings(lang);
  const capture = getCapture(room.slug);
  const snap = useCapture(room.slug);
  const draft = useDraft(room.slug);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [finishTarget, setFinishTarget] = useState<SessionTarget | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SessionTarget | null>(null);
  const [startTarget, setStartTarget] = useState<StartTarget | null>(null);
  const finishDialog = useRef<HTMLDialogElement>(null);
  const deleteDialog = useRef<HTMLDialogElement>(null);
  const startDialog = useRef<HTMLDialogElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const roomVar = { ['--room' as string]: `var(--room-${((room.index - 1) % 8) + 1})` } as React.CSSProperties;
  const readerHref = hrefWithLang(readerPath(room.slug), langFromSearch(window.location.search));
  const openReader = (event: React.MouseEvent<HTMLAnchorElement>) => {
    // Modifier clicks keep the browser's own behaviour (new tab, new window).
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (openReaderWindow(room.slug, readerHref)) event.preventDefault();
    // Blocked: the anchor's named target still opens or reuses the window, with a full load.
  };

  useEffect(() => {
    if (finishTarget) finishDialog.current?.showModal();
  }, [finishTarget]);
  useEffect(() => {
    if (deleteTarget) deleteDialog.current?.showModal();
  }, [deleteTarget]);
  useEffect(() => {
    if (startTarget) startDialog.current?.showModal();
  }, [startTarget]);

  const active = activeSession(room);
  // The socket's state messages are fresher than polling, but only while that socket is open and
  // refers to the same session; once it closes, the polled state (refreshed right away) decides.
  const socketOpen = snap.state === 'connecting' || snap.state === 'waiting' || snap.state === 'streaming' || snap.state === 'paused' || snap.state === 'ending';
  const fromSocket = socketOpen && snap.sessionId !== null && active?.sessionId === snap.sessionId && snap.sessionState !== null;
  const view = consoleView(d, {
    sessionState: fromSocket ? snap.sessionState : (active?.state ?? null),
    cause: fromSocket ? snap.cause : (active?.cause ?? null),
    completeness: fromSocket ? snap.completeness : (active?.completeness ?? null),
    capture: snap.state,
    sourceChecked: capture.sourceChecked,
    signal: snap.checks.signal,
    tested: snap.testedSource,
  });
  useEffect(() => {
    if (!socketOpen && snap.sessionId !== null) void onChanged();
  }, [socketOpen, snap.sessionId, onChanged]);
  // A test ended by the server because the room is taken: the polled state is stale.
  const testEndedReason = snap.preview?.state === 'ended' ? snap.preview.endedReason : null;
  useEffect(() => {
    if (testEndedReason === 'room_busy' || testEndedReason === 'session_started' || testEndedReason === 'test_active') void onChanged();
  }, [testEndedReason, onChanged]);
  // "Start" belongs to a prepared session, evaluated with the room's capture state.
  const preparedView = consoleView(d, { sessionState: 'prepared', cause: null, capture: snap.state, sourceChecked: capture.sourceChecked, signal: snap.checks.signal, tested: snap.testedSource });
  const canStartPrepared = active === null && preparedView.canStart && !disabled;
  const startWarning = active === null ? preparedView.startWarning : null;
  const sourceOff = snap.sourceKind === null && snap.remembered !== null;
  const testStageVisible = (snap.sourceKind !== null || sourceOff) && (view.canTest || view.canStopTest || sourceOff);
  const testEnd = snap.preview?.state === 'ended' && snap.preview.endedReason ? testEndMessage(d, snap.preview.endedReason) : null;
  const visibleSession = room.sessions.find((s) => s.sessionId === room.visibleSessionId) ?? null;
  // Current: not finished yet, plus the finished session attendees still see. The rest folds under "Finished sessions".
  const currentSessions = room.sessions.filter((s) => s.state !== 'finished' || s.sessionId === room.visibleSessionId);
  const finishedSessions = room.sessions.filter((s) => !currentSessions.includes(s));
  const testLanguage = snap.testLanguage ?? draft.language;
  // Attach this console's source to a started session nobody is feeding: right away for a session this
  // console started, after a grace period for one started elsewhere (its own sender may still be connecting).
  const ownSession = active !== null && snap.sessionId === active.sessionId;
  const orphanAge = active?.startedAt ? Date.now() - Date.parse(active.startedAt) : 0;
  const canConnect = view.canReconnect && active !== null && !active.senderActive && (ownSession || active.state !== 'starting' || orphanAge > ORPHAN_START_MS) && !disabled;

  /** Failures every action shares: lost demo access, a refused origin, or the given fallback text. */
  const failed = (error: unknown, fallback: (code: string | null) => string) => {
    if (error instanceof ApiError) {
      if (error.status === 401) {
        onAuthLost();
        return;
      }
      if (error.status === 403 && error.code === 'origin_not_allowed') {
        setActionError(d.originNotAllowed(appOrigin));
        return;
      }
      setActionError(fallback(error.code));
      return;
    }
    setActionError(fallback(null));
  };

  const prepare = async (event: React.FormEvent) => {
    event.preventDefault();
    const submitted = draft.title;
    setBusy('prepare');
    setActionError(null);
    setNotice(null);
    try {
      await adminApi.prepare(getToken, room.slug, { title: submitted, sourceLanguage: draft.language });
      drafts.clearTitleIf(room.slug, submitted);
      await onChanged();
    } catch (e) {
      failed(e, d.prepareFailed);
    } finally {
      setBusy(null);
    }
  };

  const doStart = async (sessionId: string, confirmedTestId: string | null) => {
    setBusy(sessionId);
    setActionError(null);
    setNotice(null);
    try {
      await adminApi.start(getToken, sessionId, confirmedTestId ? { confirmedTestId } : {});
    } catch (e) {
      if (e instanceof ApiError) {
        const body = (e.body ?? {}) as { testId?: string; testSourceLanguage?: SourceLanguage; blockingTitle?: string };
        if (e.status === 409 && e.code === 'test_active' && body.testId) {
          // The room's test changed since the decision: ask about the current one, once.
          const next = decideAfterTestActive({ refusedTestId: body.testId, refusedSourceLanguage: body.testSourceLanguage ?? 'es', confirmedTestId, ownTestId: snap.testId });
          const session = room.sessions.find((s) => s.sessionId === sessionId);
          if (next?.kind === 'send') {
            setBusy(null);
            return doStart(sessionId, next.confirmedTestId);
          }
          if (next?.kind === 'confirm' && session) setStartTarget({ sessionId, title: session.title, testId: next.testId, testSourceLanguage: next.testSourceLanguage });
          else setActionError(d.testChanged);
        } else if (e.status === 409 && e.code === 'room_busy') setActionError(d.roomBusy(body.blockingTitle ?? d.otherSession));
        else if (e.status === 409 && e.code === 'not_prepared') setActionError(d.startNotPrepared);
        else if (e.status === 404) setActionError(d.deletedMeanwhile);
        else failed(e, d.startFailed);
      } else {
        // No answer: the start may have committed. The refreshed list decides what to offer next.
        setNotice(d.startResponseLost);
      }
      setBusy(null);
      void onChanged();
      return;
    }
    await onChanged();
    try {
      await capture.start(sessionId);
    } catch {
      // The capture reports its own failure in its snapshot.
    }
    setBusy(null);
    void onChanged();
  };

  const start = (session: SessionRecord) => {
    setActionError(null);
    const decision = decideStart({ roomTest: room.test, ownTestId: snap.testId });
    if (decision.kind === 'confirm') {
      setStartTarget({ sessionId: session.sessionId, title: session.title, testId: decision.testId, testSourceLanguage: decision.testSourceLanguage });
      return;
    }
    void doStart(session.sessionId, decision.confirmedTestId);
  };

  const confirmStart = () => {
    const target = startTarget;
    startDialog.current?.close();
    setStartTarget(null);
    if (!target) return;
    void doStart(target.sessionId, target.testId);
  };

  const finish = async () => {
    const target = finishTarget;
    finishDialog.current?.close();
    setFinishTarget(null);
    if (!target) return;
    setBusy('finish');
    setActionError(null);
    setNotice(null);
    try {
      if (snap.sessionId === target.sessionId && (snap.state === 'streaming' || snap.state === 'paused')) {
        await capture.finish();
      } else {
        const result = await adminApi.finish(getToken, target.sessionId);
        // A start of this console still connecting to that session has nothing to connect to any more.
        if (snap.sessionId === target.sessionId) capture.abort();
        if (result.alreadyFinished) setNotice(d.alreadyFinished);
      }
      await onChanged();
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setActionError(d.deletedMeanwhile);
      else failed(e, d.finishFailed);
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    const target = deleteTarget;
    deleteDialog.current?.close();
    setDeleteTarget(null);
    if (!target) return;
    setBusy('delete');
    setActionError(null);
    setNotice(null);
    try {
      await adminApi.delete(getToken, target.sessionId);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.code === 'not_deletable') setActionError(d.notDeletable);
      else if (e instanceof ApiError && e.status === 404) setActionError(d.deletedMeanwhile);
      else failed(e, d.deleteFailed);
    } finally {
      setBusy(null);
      void onChanged();
    }
  };

  const connect = async () => {
    if (!active) return;
    setActionError(null);
    if (snap.sessionId !== active.sessionId) {
      await capture.start(active.sessionId);
    } else {
      await capture.reconnect();
    }
    void onChanged();
  };

  const testLabel = (langOf: SourceLanguage) => (snap.sourceKind === 'file' || snap.remembered?.kind === 'file' ? d.testFileIn(langOf.toUpperCase()) : d.testMicrophoneIn(langOf.toUpperCase()));

  const renderSession = (s: SessionRecord) => {
    const label = stateLabel(d, s.state);
    const isActive = active?.sessionId === s.sessionId;
    return (
      <li key={s.sessionId} className="session-list__item">
        <span className="stack stack--tight">
          <span className="session-list__title" lang={s.sourceLanguage}>
            {s.title}
          </span>
          <span className="row">
            <span className="chip chip--lang" lang={s.sourceLanguage}>
              {LANGUAGE_NATIVE_NAMES[s.sourceLanguage]}
            </span>
            {label.status === 'live' ? <span className="chip chip--live">{d.stateLive}</span> : <span className={`chip chip--status-${label.status}`}>{isActive ? view.chipText : label.text}</span>}
            {visibleSession?.sessionId === s.sessionId && <span className="chip">{d.visible}</span>}
          </span>
        </span>
        {s.state === 'prepared' && (
          <span className="stack stack--tight">
            <span className="row">
              <button type="button" className="btn btn--primary" disabled={!canStartPrepared || busy !== null} onClick={() => start(s)}>
                {d.start}
              </button>
              <button type="button" className="btn btn--danger" disabled={busy !== null || disabled} onClick={() => setDeleteTarget({ sessionId: s.sessionId, title: s.title })}>
                {d.delete}
              </button>
            </span>
            {canStartPrepared && startWarning && (
              <span className="start-warning">
                <IconTriangleAlert />
                {startWarningText(d, startWarning)}
              </span>
            )}
          </span>
        )}
      </li>
    );
  };

  return (
    <section className="card card--session" style={roomVar} aria-labelledby={`room-${room.slug}`}>
      <div className="stack">
        <div className="row">
          <h2 className="card__title" id={`room-${room.slug}`}>
            {room.name}
          </h2>
          <a className="chip chip--room chip--link" style={roomVar} href={readerHref} target={readerWindowName(room.slug)} onClick={openReader}>
            /r/{room.slug}
            <span className="visually-hidden">, {d.readerOpensInWindow}</span>
          </a>
          {view.status === 'live' ? <span className="chip chip--live">{view.chipText}</span> : <span className={`chip chip--status-${view.status}`}><StatusIcon status={view.status} />{view.chipText}</span>}
        </div>
        <div className="console__columns">
          <div className="stack">
            <h3 className="field__label">{d.sourceHeading}</h3>
            <div className="row">
              <button type="button" className="btn btn--secondary" disabled={!view.canChangeSource || snap.state === 'checking'} onClick={() => void capture.useMicrophone(snap.selectedDeviceId ?? undefined)}>
                <IconMic />
                {d.useMicrophone}
              </button>
              <button type="button" className="btn btn--secondary" disabled={!view.canChangeSource || snap.state === 'checking'} onClick={() => fileRef.current?.click()}>
                <IconFileAudio />
                {d.wavFile}
              </button>
              <input
                ref={fileRef}
                type="file"
                accept=".wav,audio/wav"
                className="visually-hidden"
                aria-label={d.wavFile}
                tabIndex={-1}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void capture.useFile(file);
                  e.target.value = '';
                }}
              />
            </div>
            {snap.sourceKind === 'microphone' && snap.devices.length > 0 && (
              <div className="field">
                <label className="field__label" htmlFor={`device-${room.slug}`}>
                  {d.device}
                </label>
                <select
                  id={`device-${room.slug}`}
                  className="field__input"
                  value={snap.selectedDeviceId ?? ''}
                  disabled={!view.canChangeSource}
                  onChange={(e) => void capture.useMicrophone(e.target.value || undefined)}
                >
                  {snap.devices.map((device, i) => (
                    <option key={device.deviceId} value={device.deviceId}>
                      {device.label || d.microphoneN(i + 1)}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {snap.sourceLabel !== null && (
              <p className="card__meta">
                {d.sourceLine(snap.sourceLabel || d.microphoneFallback)}
                {snap.file && ` · ${snap.file.currentTime.toFixed(1)} s / ${Number.isFinite(snap.file.duration) ? snap.file.duration.toFixed(1) : '?'} s`}
              </p>
            )}
            {sourceOff && snap.remembered && (
              <div className="banner banner--off" role="status">
                <span>
                  {d.sourceOff} · {snap.remembered.label || d.microphoneFallback}
                </span>
                <button type="button" className="btn btn--secondary" disabled={snap.state === 'checking'} onClick={() => void capture.reopen()}>
                  {d.reopenSource}
                </button>
                <span className="card__meta">{d.sourceOffHint}</span>
              </div>
            )}
            {snap.sourceKind === 'microphone' && (
              <p className="card__meta card__meta--quiet">
                {d.processing}: {formatTrackProcessing(d, snap.trackSettings)}
              </p>
            )}
            <ul className="checks" aria-label={d.checks}>
              {(['permission', 'device', 'signal', 'receipt'] as const).map((name) => (
                <li key={name}>
                  <span className={`status-dot status-dot--${snap.checks[name] === 'pending' ? 'off' : snap.checks[name]}`} />
                  <span>
                    {name === 'permission' ? d.checkPermission : name === 'device' ? d.checkDevice : name === 'signal' ? d.checkSignal : d.checkReceipt}: {checkLabel(d, snap.checks[name])}
                  </span>
                </li>
              ))}
            </ul>
            <div className={`meter meter--level${snap.clipping ? ' meter--clipping' : ''}`} aria-hidden="true">
              <div className="meter__fill" style={{ width: `${(meterFraction(toDbfs(snap.level)) * 100).toFixed(1)}%` }} />
              <div className="meter__threshold" style={{ left: `${(meterFraction(toDbfs(NO_SIGNAL_RMS)) * 100).toFixed(1)}%` }} />
              <div className="meter__peak" style={{ left: `${(meterFraction(toDbfs(snap.peak)) * 100).toFixed(1)}%` }} />
            </div>
            <div className="row meter__readout">
              <span className="card__meta">
                {d.level}: {formatDbfs(toDbfs(snap.level))}
              </span>
              {snap.clipping && <span className="chip chip--status-error">{d.clipping}</span>}
            </div>
            {snap.noSignal && (
              <div className="banner banner--warning" role="status">
                {d.noSignalBanner}
              </div>
            )}
            {testStageVisible && (
              <div className="test-stage stack">
                <div className="row">
                  {view.canTest && (
                    <button type="button" className="btn btn--secondary" disabled={disabled} onClick={() => void capture.startTest(draft.language)}>
                      {testLabel(draft.language)}
                    </button>
                  )}
                  {view.canStopTest && (
                    <button type="button" className="btn btn--secondary" onClick={() => capture.stopTest()}>
                      {d.stopTest}
                    </button>
                  )}
                  {snap.state === 'testing' && <span className="card__meta meter__readout">{snap.preview?.state === 'connecting' ? d.connectingRecognition : formatElapsed(snap.testElapsedMs)}</span>}
                  <button type="button" className="switch" role="switch" aria-checked={snap.monitor} disabled={!view.canMonitor} onClick={() => void capture.setMonitor(!snap.monitor)}>
                    <span className="switch__track">
                      <span className="switch__thumb" />
                    </span>
                    {d.monitor}
                  </button>
                </div>
                {snap.monitor && (
                  <p className="test-stage__warning" role="status">
                    {d.headphonesWarning}
                  </p>
                )}
                <div className="check-preview" aria-live="off" lang={testLanguage}>
                  <div className="check-preview__text">
                    {snap.preview && (snap.preview.text || snap.preview.partial) ? (
                      <>
                        {snap.preview.text}
                        {snap.preview.partial && <span className="check-preview__partial">{snap.preview.partial}</span>}
                      </>
                    ) : (
                      <span className="check-preview__empty">{snap.state === 'testing' ? d.speakNow : d.testToSee}</span>
                    )}
                  </div>
                </div>
                {snap.state !== 'testing' && testEnd && (
                  <p className={`test-stage__end test-stage__end--${testEnd.tone}`} role="status">
                    {testEnd.text}
                  </p>
                )}
              </div>
            )}
            {snap.error && (
              <div className="banner banner--error" role="alert">
                {noticeText(d, snap.error)}
              </div>
            )}
            {snap.message && !snap.error && (
              <div className="banner banner--warning" role="status">
                {noticeText(d, snap.message)}
              </div>
            )}
            {actionError && (
              <div className="banner banner--error" role="alert">
                {actionError}
              </div>
            )}
            {notice && !actionError && (
              <div className="banner banner--warning" role="status">
                {notice}
              </div>
            )}
            <div className="row">
              {view.canPause && (
                <button type="button" className="btn btn--secondary" onClick={() => void capture.pause()}>
                  {d.pause}
                </button>
              )}
              {view.canResume && (
                <button type="button" className="btn btn--secondary" onClick={() => void capture.resume()}>
                  {d.resume}
                </button>
              )}
              {view.canResume && snap.file && (
                <label className="row">
                  <span className="field__label">{d.position}</span>
                  <input
                    type="number"
                    className="field__input"
                    style={{ width: '7rem' }}
                    min={0}
                    max={Number.isFinite(snap.file.duration) ? Math.floor(snap.file.duration) : undefined}
                    defaultValue={Math.floor(snap.file.currentTime)}
                    onBlur={(e) => capture.seekFile(Number(e.target.value))}
                  />
                </label>
              )}
              {canConnect && (
                <button type="button" className="btn btn--secondary" onClick={() => void connect()}>
                  {ownSession ? d.reconnect : d.connectSource}
                </button>
              )}
              {view.canFinish && active && (
                <button type="button" className="btn btn--danger" disabled={busy === 'finish' || disabled} onClick={() => setFinishTarget({ sessionId: active.sessionId, title: active.title })}>
                  {d.finish}
                </button>
              )}
            </div>
            {snap.epoch !== null && (
              <p className="card__meta">
                {d.connectionStats({ epoch: snap.epoch, framesSent: snap.framesSent, framesDropped: snap.framesDropped, discontinuities: snap.discontinuities, lastAckPosition: snap.lastAck?.samplePosition ?? null })}
              </p>
            )}
          </div>
          <div className="stack">
            <h3 className="field__label">{d.sessionsHeading}</h3>
            <form className="stack" onSubmit={prepare}>
              <div className="field">
                <label className="field__label" htmlFor={`title-${room.slug}`}>
                  {d.talkTitle}
                </label>
                <input id={`title-${room.slug}`} className="field__input" value={draft.title} onChange={(e) => drafts.set(room.slug, { title: e.target.value })} required maxLength={200} placeholder={d.talkTitlePlaceholder} />
              </div>
              <div className="field">
                <label className="field__label" htmlFor={`lang-${room.slug}`}>
                  {d.sourceLanguage}
                </label>
                <select id={`lang-${room.slug}`} className="field__input" value={draft.language} onChange={(e) => drafts.set(room.slug, { language: e.target.value as SourceLanguage })}>
                  <option value="es">{d.sourceOption.es}</option>
                  <option value="en">{d.sourceOption.en}</option>
                </select>
              </div>
              <div className="row">
                <button type="submit" className="btn btn--outline" disabled={busy === 'prepare' || !draft.title.trim() || disabled}>
                  {d.prepareSession}
                </button>
              </div>
            </form>
            <ul className="session-list session-list--capped session-list--current" aria-label={d.sessionsOf(room.name)} tabIndex={0}>
              {currentSessions.length === 0 && <li className="card__meta">{d.noPrepared}</li>}
              {currentSessions.map(renderSession)}
            </ul>
            {finishedSessions.length > 0 && (
              <details className="session-history">
                <summary className="session-history__summary">{d.finishedSessions(finishedSessions.length)}</summary>
                <ul className="session-list session-list--capped session-history__list" aria-label={d.finishedSessionsOf(room.name)} tabIndex={0}>
                  {finishedSessions.map(renderSession)}
                </ul>
              </details>
            )}
          </div>
        </div>
      </div>
      <dialog ref={finishDialog} className="modal" aria-labelledby={`finish-title-${room.slug}`} onClose={() => setFinishTarget(null)}>
        <h2 className="modal__title" id={`finish-title-${room.slug}`}>
          {d.finishDialogTitle}
        </h2>
        {finishTarget && <p className="card__meta">{d.finishDialogSession(finishTarget.title)}</p>}
        <p>{d.finishDialogBody(Math.round(drainTimeoutMs / 1000))}</p>
        <div className="modal__actions">
          <button type="button" className="btn btn--secondary" autoFocus onClick={() => finishDialog.current?.close()}>
            {d.cancel}
          </button>
          <button type="button" className="btn btn--danger" onClick={() => void finish()}>
            {d.finishSession}
          </button>
        </div>
      </dialog>
      <dialog ref={deleteDialog} className="modal" aria-labelledby={`delete-title-${room.slug}`} onClose={() => setDeleteTarget(null)}>
        <h2 className="modal__title" id={`delete-title-${room.slug}`}>
          {d.deleteDialogTitle}
        </h2>
        <p>{d.deleteDialogBody(deleteTarget?.title ?? '')}</p>
        <div className="modal__actions">
          <button type="button" className="btn btn--secondary" autoFocus onClick={() => deleteDialog.current?.close()}>
            {d.cancel}
          </button>
          <button type="button" className="btn btn--danger" onClick={() => void remove()}>
            {d.deleteSession}
          </button>
        </div>
      </dialog>
      <dialog ref={startDialog} className="modal" aria-labelledby={`start-title-${room.slug}`} onClose={() => setStartTarget(null)}>
        <h2 className="modal__title" id={`start-title-${room.slug}`}>
          {d.startConfirmTitle}
        </h2>
        {startTarget && <p className="card__meta">{d.finishDialogSession(startTarget.title)}</p>}
        <p>{d.startConfirmBody(startTarget ? LANGUAGE_NATIVE_NAMES[startTarget.testSourceLanguage] : '')}</p>
        <div className="modal__actions">
          <button type="button" className="btn btn--secondary" autoFocus onClick={() => startDialog.current?.close()}>
            {d.cancel}
          </button>
          <button type="button" className="btn btn--danger" onClick={confirmStart}>
            {d.startAnyway}
          </button>
        </div>
      </dialog>
    </section>
  );
}

export type { AdminSourceTest };
