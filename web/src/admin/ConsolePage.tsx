import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useAuth, useClerk, useUser } from '@clerk/react';
import type { AdminRoom, RuntimeConfig, SessionRecord, SourceLanguage } from '@nerditulos/shared';
import { ApiError, adminApi } from '../api.js';
import { IconFileAudio, IconMic, IconUser, StatusIcon } from '../icons.js';
import { sessionStateLabel } from '../RoomsPage.js';
import { getCapture, type CaptureSnapshot } from './capture/runtime.js';
import { checkLabel, consoleView } from './capture/viewModel.js';

type Gate =
  | { kind: 'checking' }
  | { kind: 'ok'; userId: string }
  | { kind: 'not_configured' }
  | { kind: 'forbidden' }
  | { kind: 'unauthenticated' }
  | { kind: 'error'; message: string };

function gateMessage(gate: Gate): { text: string; tone: 'error' | 'warning' } | null {
  switch (gate.kind) {
    case 'not_configured':
      return { text: 'Administración no configurada: el servidor no tiene un usuario administrador asignado.', tone: 'warning' };
    case 'forbidden':
      return { text: 'Esta cuenta no tiene permisos de administración.', tone: 'error' };
    case 'unauthenticated':
      return { text: 'La sesión de identidad expiró. Volvé a iniciar sesión.', tone: 'error' };
    case 'error':
      return { text: gate.message, tone: 'error' };
    default:
      return null;
  }
}

const ACTIVE_STATES = new Set(['starting', 'live', 'interrupted', 'finishing']);

function activeSession(room: AdminRoom): SessionRecord | null {
  return room.sessions.find((s) => ACTIVE_STATES.has(s.state)) ?? null;
}

export function ConsolePage({ config }: { config: RuntimeConfig }) {
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
        else setGate({ kind: 'error', message: 'No se pudo verificar la autorización. Reintentá en unos segundos.' });
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
    document.title = `${config.eventName || 'Subtítulos'} · Consola`;
  }, [config.eventName]);

  const liveRooms = (rooms ?? []).filter((r) => activeSession(r)?.state === 'live');
  useEffect(() => {
    document.documentElement.style.setProperty('--status-bar-height', liveRooms.length > 0 ? '40px' : '0px');
    return () => document.documentElement.style.setProperty('--status-bar-height', '0px');
  }, [liveRooms.length]);

  const message = gateMessage(gate);
  const accountName = user?.primaryEmailAddress?.emailAddress ?? user?.username ?? null;

  return (
    <div className="console">
      <a className="skip-link" href="#main">
        Ir al contenido
      </a>
      <header className="console__header">
        <img className="console__logo" src="/brand/nerdearla-simplified.svg" alt="Nerdearla" />
        <span className="console__spacer" />
        <div className="account-menu" ref={menuRef}>
          <button type="button" className="btn btn--outline btn--icon" aria-label="Cuenta" aria-expanded={menuOpen} aria-controls="account-panel" onClick={() => setMenuOpen((v) => !v)}>
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
                Cerrar sesión
              </button>
            </div>
          )}
        </div>
      </header>
      {liveRooms.length > 0 && (
        <div className="status-bar" role="status">
          <span className="chip chip--live">En vivo</span>
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
        {gate.kind === 'checking' && <p className="page-loading">Verificando autorización…</p>}
        {message && (
          <div className={`banner banner--${message.tone}`} role="alert">
            {message.text}
          </div>
        )}
        {gate.kind === 'ok' && !rooms && <p className="page-loading">Cargando salas…</p>}
        {gate.kind === 'ok' && rooms && rooms.length > 1 && (
          <div className="tabs" role="tablist" aria-label="Salas">
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
                  <span className="tab__meta">{active ? `${active.title} · ${sessionStateLabel(active.state).text}` : 'Sin sesión activa'}</span>
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
        Nerditulos · Software bajo licencia MIT
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

  const active = activeSession(room);
  // The socket's state messages are fresher than polling, but only while that socket is open and
  // refers to the same session; once it closes, the polled state (refreshed right away) decides.
  const socketOpen = snap.state === 'connecting' || snap.state === 'waiting' || snap.state === 'streaming' || snap.state === 'paused' || snap.state === 'ending';
  const fromSocket = socketOpen && snap.sessionId !== null && active?.sessionId === snap.sessionId && snap.sessionState !== null;
  const view = consoleView({
    sessionState: fromSocket ? snap.sessionState : (active?.state ?? null),
    cause: fromSocket ? snap.cause : (active?.cause ?? null),
    completeness: fromSocket ? snap.completeness : (active?.completeness ?? null),
    capture: snap.state,
    sourceChecked: capture.sourceChecked,
  });
  useEffect(() => {
    if (!socketOpen && snap.sessionId !== null) void onChanged();
  }, [socketOpen, snap.sessionId, onChanged]);
  // "Iniciar" belongs to a prepared session, evaluated with the room's capture state.
  const canStartPrepared = active === null && consoleView({ sessionState: 'prepared', cause: null, capture: snap.state, sourceChecked: capture.sourceChecked }).canStart;
  const visibleSession = room.sessions.find((s) => s.sessionId === room.visibleSessionId) ?? null;
  // Current: not finished yet, plus the finished session attendees still see. The rest folds under "Sesiones finalizadas".
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
      setActionError(e instanceof ApiError ? `No se pudo preparar la sesión (${e.code}).` : 'No se pudo preparar la sesión.');
    } finally {
      setBusy(null);
    }
  };

  const start = async (session: SessionRecord) => {
    setBusy(session.sessionId);
    setActionError(null);
    try {
      await adminApi.start(getToken, session.sessionId);
      await onChanged();
      await capture.start(session.sessionId);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'room_busy') {
        const blocking = (e.body as { blockingTitle?: string } | null)?.blockingTitle ?? 'otra sesión';
        setActionError(`La sala ya tiene una sesión activa (${blocking}). Finalizala antes de iniciar otra.`);
      } else setActionError(e instanceof ApiError ? `No se pudo iniciar (${e.code}).` : 'No se pudo iniciar la sesión.');
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
      setActionError(e instanceof ApiError ? `No se pudo finalizar (${e.code}).` : 'No se pudo finalizar la sesión.');
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
    const label = sessionStateLabel(s.state);
    const isActive = active?.sessionId === s.sessionId;
    return (
      <li key={s.sessionId} className="session-list__item">
        <span className="stack stack--tight">
          <span className="session-list__title" lang={s.sourceLanguage}>
            {s.title}
          </span>
          <span className="row">
            <span className="chip chip--lang">{s.sourceLanguage === 'en' ? 'English' : 'Español'}</span>
            {label.status === 'live' ? <span className="chip chip--live">En vivo</span> : <span className={`chip chip--status-${label.status}`}>{isActive ? view.chipText : label.text}</span>}
            {visibleSession?.sessionId === s.sessionId && <span className="chip">Visible</span>}
          </span>
        </span>
        {s.state === 'prepared' && (
          <button type="button" className="btn btn--primary" disabled={!canStartPrepared || busy !== null} onClick={() => void start(s)}>
            Iniciar
          </button>
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
          <span className="chip chip--room" style={roomVar}>
            /r/{room.slug}
          </span>
          {view.status === 'live' ? <span className="chip chip--live">{view.chipText}</span> : <span className={`chip chip--status-${view.status}`}><StatusIcon status={view.status} />{view.chipText}</span>}
        </div>
        <div className="console__columns">
          <div className="stack">
            <h3 className="field__label">Fuente de audio</h3>
            <div className="row">
              <button type="button" className="btn btn--secondary" disabled={!view.canChangeSource || snap.state === 'checking'} onClick={() => void capture.useMicrophone(snap.selectedDeviceId ?? undefined)}>
                <IconMic />
                Usar micrófono
              </button>
              <button type="button" className="btn btn--secondary" disabled={!view.canChangeSource || snap.state === 'checking'} onClick={() => fileRef.current?.click()}>
                <IconFileAudio />
                Archivo WAV
              </button>
              <input
                ref={fileRef}
                type="file"
                accept=".wav,audio/wav"
                className="visually-hidden"
                aria-label="Archivo WAV"
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
                  Dispositivo
                </label>
                <select
                  id={`device-${room.slug}`}
                  className="field__input"
                  value={snap.selectedDeviceId ?? ''}
                  disabled={!view.canChangeSource}
                  onChange={(e) => void capture.useMicrophone(e.target.value || undefined)}
                >
                  {snap.devices.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {snap.sourceLabel && (
              <p className="card__meta">
                Fuente: {snap.sourceLabel}
                {snap.file && ` · ${snap.file.currentTime.toFixed(1)} s / ${Number.isFinite(snap.file.duration) ? snap.file.duration.toFixed(1) : '?'} s`}
              </p>
            )}
            <ul className="checks" aria-label="Comprobaciones">
              {(['permission', 'device', 'signal', 'receipt'] as const).map((name) => (
                <li key={name}>
                  <span className={`status-dot status-dot--${snap.checks[name] === 'pending' ? 'off' : snap.checks[name]}`} />
                  <span>
                    {name === 'permission' ? 'Permiso' : name === 'device' ? 'Dispositivo' : name === 'signal' ? 'Señal' : 'Recepción en el servidor'}: {checkLabel(snap.checks[name])}
                  </span>
                </li>
              ))}
            </ul>
            <div className="meter" aria-hidden="true">
              <div className="meter__fill" style={{ width: `${Math.min(100, Math.round(snap.level * 300))}%` }} />
            </div>
            {snap.noSignal && snap.state === 'streaming' && (
              <div className="banner banner--warning" role="status">
                Sin señal: no se detecta audio desde hace más de 3 segundos.
              </div>
            )}
            {snap.error && (
              <div className="banner banner--error" role="alert">
                {snap.error}
              </div>
            )}
            {snap.message && !snap.error && (
              <div className="banner banner--warning" role="status">
                {snap.message}
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
                  Pausar
                </button>
              )}
              {view.canResume && (
                <button type="button" className="btn btn--secondary" onClick={() => void capture.resume()}>
                  Reanudar
                </button>
              )}
              {view.canResume && snap.file && (
                <label className="row">
                  <span className="field__label">Posición (s)</span>
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
                  Reconectar
                </button>
              )}
              {view.canFinish && (
                <button type="button" className="btn btn--danger" disabled={busy === 'finish'} onClick={openDialog}>
                  Finalizar
                </button>
              )}
            </div>
            {snap.epoch !== null && (
              <p className="card__meta">
                Conexión {snap.epoch} · tramas enviadas {snap.framesSent} · descartadas {snap.framesDropped} · discontinuidades {snap.discontinuities}
                {snap.lastAck && ` · última recepción pos. ${snap.lastAck.samplePosition}`}
              </p>
            )}
          </div>
          <div className="stack">
            <h3 className="field__label">Sesiones</h3>
            <form className="stack" onSubmit={prepare}>
              <div className="field">
                <label className="field__label" htmlFor={`title-${room.slug}`}>
                  Título de la charla
                </label>
                <input id={`title-${room.slug}`} className="field__input" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} placeholder="Nombre de la charla" />
              </div>
              <div className="field">
                <label className="field__label" htmlFor={`lang-${room.slug}`}>
                  Idioma de origen
                </label>
                <select id={`lang-${room.slug}`} className="field__input" value={language} onChange={(e) => setLanguage(e.target.value as SourceLanguage)}>
                  <option value="es">Español (con traducción al inglés)</option>
                  <option value="en">English (con traducción al español)</option>
                </select>
              </div>
              <div className="row">
                <button type="submit" className="btn btn--outline" disabled={busy === 'prepare' || !title.trim()}>
                  Preparar sesión
                </button>
              </div>
            </form>
            <ul className="session-list" aria-label={`Sesiones de ${room.name}`}>
              {currentSessions.length === 0 && <li className="card__meta">Sin sesiones preparadas.</li>}
              {currentSessions.map(renderSession)}
            </ul>
            {finishedSessions.length > 0 && (
              <details className="session-history">
                <summary className="session-history__summary">Sesiones finalizadas ({finishedSessions.length})</summary>
                <ul className="session-list session-history__list" aria-label={`Sesiones finalizadas de ${room.name}`} tabIndex={0}>
                  {finishedSessions.map(renderSession)}
                </ul>
              </details>
            )}
          </div>
        </div>
      </div>
      <dialog ref={dialogRef} className="modal" aria-labelledby={`finish-title-${room.slug}`}>
        <h2 className="modal__title" id={`finish-title-${room.slug}`}>
          Finalizar la sesión
        </h2>
        <p>Se detiene el envío de audio y se espera hasta {Math.round(drainTimeoutMs / 1000)} segundos a que el proveedor entregue el texto pendiente. El texto ya publicado queda visible.</p>
        <div className="modal__actions">
          <button ref={cancelRef} type="button" className="btn btn--secondary" onClick={() => dialogRef.current?.close()}>
            Cancelar
          </button>
          <button type="button" className="btn btn--danger" onClick={() => void finish()}>
            Finalizar sesión
          </button>
        </div>
      </dialog>
    </section>
  );
}
