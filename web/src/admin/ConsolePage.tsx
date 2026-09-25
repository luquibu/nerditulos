import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useAuth, useClerk, useUser } from '@clerk/react';
import type { AdminRoom, RuntimeConfig, SessionRecord, SourceLanguage } from '@nerditulos/shared';
import { ApiError, adminApi } from '../api.js';
import { LANGUAGE_NATIVE_NAMES, stateLabel } from '../i18n.js';
import { IconFileAudio, IconMic, IconTriangleAlert, IconUser, StatusIcon } from '../icons.js';
import { hrefWithLang, langFromSearch } from '../language.js';
import { useLanguage } from '../LanguageProvider.js';
import { LanguageSwitch } from '../LanguageSwitch.js';
import { formatDbfs, meterFraction, NO_SIGNAL_RMS, toDbfs } from './capture/level.js';
import { noticeText } from './capture/notices.js';
import { testEndMessage } from './capture/preview.js';
import { getCapture, type CaptureSnapshot } from './capture/runtime.js';
import { checkLabel, consoleView, formatElapsed, formatTrackProcessing, startWarningText, testLanguageFor } from './capture/viewModel.js';
import { consoleStrings, type ConsoleStrings } from './consoleStrings.js';
import { openReaderWindow, readerPath, readerWindowName } from './readerWindow.js';

type Gate =
  | { kind: 'checking' }
  | { kind: 'ok'; userId: string }
  | { kind: 'not_configured' }
  | { kind: 'forbidden' }
  | { kind: 'unauthenticated' }
  | { kind: 'error' };

function gateMessage(d: ConsoleStrings, gate: Gate): { text: string; tone: 'error' | 'warning' } | null {
  switch (gate.kind) {
    case 'not_configured':
      return { text: d.gateNotConfigured, tone: 'warning' };
    case 'forbidden':
      return { text: d.gateForbidden, tone: 'error' };
    case 'unauthenticated':
      return { text: d.gateUnauthenticated, tone: 'error' };
    case 'error':
      return { text: d.gateCheckFailed, tone: 'error' };
    default:
      return null;
  }
}

const ACTIVE_STATES = new Set(['starting', 'live', 'interrupted', 'finishing']);

function activeSession(room: AdminRoom): SessionRecord | null {
  return room.sessions.find((s) => ACTIVE_STATES.has(s.state)) ?? null;
}

export function ConsolePage({ config }: { config: RuntimeConfig }) {
  const [lang] = useLanguage();
  const d = consoleStrings(lang);
  const { getToken } = useAuth();
  const { user } = useUser();
  const clerk = useClerk();
  const tokenSupplier = useCallback(() => getToken(), [getToken]);
  const [gate, setGate] = useState<Gate>({ kind: 'checking' });
  const [rooms, setRooms] = useState<AdminRoom[] | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [selectedRoom, setSelectedRoom] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const loadRooms = useCallback(async () => {
    try {
      const result = await adminApi.rooms(tokenSupplier);
      setRooms(result.rooms);
      setSelectedRoom((current) => current ?? result.rooms[0]?.slug ?? null);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) setGate({ kind: 'unauthenticated' });
      else if (error instanceof ApiError && error.status === 403) setGate({ kind: 'forbidden' });
      else if (error instanceof ApiError && error.status === 503) setGate({ kind: 'not_configured' });
    }
  }, [tokenSupplier]);

  useEffect(() => {
    let cancelled = false;
    adminApi
      .me(tokenSupplier)
      .then((me) => {
        if (cancelled) return;
        setGate({ kind: 'ok', userId: me.userId });
        void loadRooms();
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 503 && error.code === 'admin_not_configured') setGate({ kind: 'not_configured' });
        else if (error instanceof ApiError && error.status === 403) setGate({ kind: 'forbidden' });
        else if (error instanceof ApiError && error.status === 401) setGate({ kind: 'unauthenticated' });
        else setGate({ kind: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [tokenSupplier, loadRooms]);

  useEffect(() => {
    if (gate.kind !== 'ok') return;
    const timer = window.setInterval(() => void loadRooms(), 5000);
    return () => window.clearInterval(timer);
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

  const liveRooms = (rooms ?? []).filter((r) => activeSession(r)?.state === 'live');
  useEffect(() => {
    document.documentElement.style.setProperty('--status-bar-height', liveRooms.length > 0 ? '40px' : '0px');
    return () => document.documentElement.style.setProperty('--status-bar-height', '0px');
  }, [liveRooms.length]);

  const message = gateMessage(d, gate);
  const accountName = user?.primaryEmailAddress?.emailAddress ?? user?.username ?? null;

  return (
    <div className="console">
      <a className="skip-link" href="#main">
        {d.skipToContent}
      </a>
      <header className="console__header">
        <img className="console__logo" src="/brand/nerdearla-simplified.svg" alt="Nerdearla" />
        <span className="console__spacer" />
        {/* Interface language only: a session's source language is chosen per session below. */}
        <LanguageSwitch />
        <div className="account-menu" ref={menuRef}>
          <button type="button" className="btn btn--outline btn--icon" aria-label={d.accountMenu} aria-expanded={menuOpen} aria-controls="account-panel" onClick={() => setMenuOpen((v) => !v)}>
            <IconUser />
          </button>
          {menuOpen && (
            <div className="dropdown" id="account-panel">
              {(accountName || gate.kind === 'ok') && (
                <div className="dropdown__identity">
                  {accountName && <p className="dropdown__account">{accountName}</p>}
                  {gate.kind === 'ok' && <p className="dropdown__meta">{gate.userId}</p>}
                </div>
              )}
              <button type="button" className="dropdown__item" onClick={() => clerk.signOut({ redirectUrl: '/admin' })}>
                {d.signOut}
              </button>
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
          </div>
        )}
        {gate.kind === 'ok' && !rooms && <p className="page-loading">{d.roomsLoading}</p>}
        {gate.kind === 'ok' && rooms && rooms.length > 1 && (
          <div className="tabs" role="tablist" aria-label={d.roomsTabs}>
            {rooms.map((room) => {
              const active = activeSession(room);
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
                  onClick={() => setSelectedRoom(room.slug)}
                  onKeyDown={(e) => {
                    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
                    const index = rooms.findIndex((r) => r.slug === room.slug);
                    const next = rooms[(index + (e.key === 'ArrowRight' ? 1 : rooms.length - 1)) % rooms.length];
                    if (next) {
                      setSelectedRoom(next.slug);
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
        {gate.kind === 'ok' &&
          rooms &&
          rooms.map((room) => (
            // Every room panel stays mounted; tabs only change visibility, so capture never unmounts.
            <div key={room.slug} id={`panel-${room.slug}`} role={rooms.length > 1 ? 'tabpanel' : undefined} aria-labelledby={rooms.length > 1 ? `tab-${room.slug}` : undefined} hidden={rooms.length > 1 && selectedRoom !== room.slug}>
              <RoomPanel room={room} getToken={tokenSupplier} onChanged={loadRooms} drainTimeoutMs={config.drainTimeoutMs} />
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

function RoomPanel({ room, getToken, onChanged, drainTimeoutMs }: { room: AdminRoom; getToken: () => Promise<string | null>; onChanged: () => Promise<void>; drainTimeoutMs: number }) {
  const [lang] = useLanguage();
  const d = consoleStrings(lang);
  const capture = getCapture(room.slug);
  const snap = useCapture(room.slug);
  const [title, setTitle] = useState('');
  const [language, setLanguage] = useState<SourceLanguage>('es');
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const roomVar = { ['--room' as string]: `var(--room-${((room.index - 1) % 8) + 1})` } as React.CSSProperties;
  const readerHref = hrefWithLang(readerPath(room.slug), langFromSearch(window.location.search));
  const openReader = (event: React.MouseEvent<HTMLAnchorElement>) => {
    // Modifier clicks keep the browser's own behaviour (new tab, new window).
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (openReaderWindow(room.slug, readerHref)) event.preventDefault();
    // Blocked: the anchor's named target still opens or reuses the window, with a full load.
  };

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
    if (testEndedReason === 'room_busy' || testEndedReason === 'session_started') void onChanged();
  }, [testEndedReason, onChanged]);
  // "Start" belongs to a prepared session, evaluated with the room's capture state.
  const preparedView = consoleView(d, { sessionState: 'prepared', cause: null, capture: snap.state, sourceChecked: capture.sourceChecked, signal: snap.checks.signal, tested: snap.testedSource });
  const canStartPrepared = active === null && preparedView.canStart;
  const startWarning = active === null ? preparedView.startWarning : null;
  const testStageVisible = snap.sourceKind !== null && (view.canTest || view.canStopTest);
  const testEnd = snap.preview?.state === 'ended' && snap.preview.endedReason ? testEndMessage(d, snap.preview.endedReason) : null;
  const visibleSession = room.sessions.find((s) => s.sessionId === room.visibleSessionId) ?? null;
  // Current: not finished yet, plus the finished session attendees still see. The rest folds under "Finished sessions".
  const currentSessions = room.sessions.filter((s) => s.state !== 'finished' || s.sessionId === room.visibleSessionId);
  const finishedSessions = room.sessions.filter((s) => !currentSessions.includes(s));

  const prepare = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy('prepare');
    setActionError(null);
    try {
      await adminApi.prepare(getToken, room.slug, { title, sourceLanguage: language });
      setTitle('');
      await onChanged();
    } catch (e) {
      setActionError(d.prepareFailed(e instanceof ApiError ? e.code : null));
    } finally {
      setBusy(null);
    }
  };

  const start = async (session: SessionRecord) => {
    setBusy(session.sessionId);
    setActionError(null);
    // The room's test socket closes before the session's sender authenticates.
    if (snap.state === 'testing') capture.stopTest('session_started');
    try {
      await adminApi.start(getToken, session.sessionId);
      await onChanged();
      await capture.start(session.sessionId);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'room_busy') {
        const blocking = (e.body as { blockingTitle?: string } | null)?.blockingTitle ?? d.otherSession;
        setActionError(d.roomBusy(blocking));
      } else setActionError(d.startFailed(e instanceof ApiError ? e.code : null));
    } finally {
      setBusy(null);
      void onChanged();
    }
  };

  const finish = async () => {
    dialogRef.current?.close();
    if (!active) return;
    setBusy('finish');
    try {
      if (snap.sessionId === active.sessionId && (snap.state === 'streaming' || snap.state === 'paused' || snap.state === 'connecting')) {
        await capture.finish();
      } else {
        await adminApi.finish(getToken, active.sessionId);
      }
      await onChanged();
    } catch (e) {
      setActionError(d.finishFailed(e instanceof ApiError ? e.code : null));
    } finally {
      setBusy(null);
    }
  };

  const reconnect = async () => {
    if (!active) return;
    setActionError(null);
    if (snap.sessionId !== active.sessionId) {
      await capture.start(active.sessionId);
    } else {
      await capture.reconnect();
    }
    void onChanged();
  };

  const openDialog = () => {
    dialogRef.current?.showModal();
    cancelRef.current?.focus();
  };

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
            <button type="button" className="btn btn--primary" disabled={!canStartPrepared || busy !== null} onClick={() => void start(s)}>
              {d.start}
            </button>
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
                    <button type="button" className="btn btn--secondary" onClick={() => void capture.startTest(testLanguageFor(room.sessions))}>
                      {snap.sourceKind === 'file' ? d.testFile : d.testMicrophone}
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
                <div className="check-preview" aria-live="off" lang={testLanguageFor(room.sessions)}>
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
              {view.canReconnect && (
                <button type="button" className="btn btn--secondary" onClick={() => void reconnect()}>
                  {d.reconnect}
                </button>
              )}
              {view.canFinish && (
                <button type="button" className="btn btn--danger" disabled={busy === 'finish'} onClick={openDialog}>
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
                <input id={`title-${room.slug}`} className="field__input" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} placeholder={d.talkTitlePlaceholder} />
              </div>
              <div className="field">
                <label className="field__label" htmlFor={`lang-${room.slug}`}>
                  {d.sourceLanguage}
                </label>
                <select id={`lang-${room.slug}`} className="field__input" value={language} onChange={(e) => setLanguage(e.target.value as SourceLanguage)}>
                  <option value="es">{d.sourceOption.es}</option>
                  <option value="en">{d.sourceOption.en}</option>
                </select>
              </div>
              <div className="row">
                <button type="submit" className="btn btn--outline" disabled={busy === 'prepare' || !title.trim()}>
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
      <dialog ref={dialogRef} className="modal" aria-labelledby={`finish-title-${room.slug}`}>
        <h2 className="modal__title" id={`finish-title-${room.slug}`}>
          {d.finishDialogTitle}
        </h2>
        <p>{d.finishDialogBody(Math.round(drainTimeoutMs / 1000))}</p>
        <div className="modal__actions">
          <button ref={cancelRef} type="button" className="btn btn--secondary" onClick={() => dialogRef.current?.close()}>
            {d.cancel}
          </button>
          <button type="button" className="btn btn--danger" onClick={() => void finish()}>
            {d.finishSession}
          </button>
        </div>
      </dialog>
    </section>
  );
}
