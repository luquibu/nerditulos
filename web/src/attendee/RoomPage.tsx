import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RuntimeConfig, SessionSummary } from '@nerditulos/shared';
import { ApiError, fetchRoom } from '../api.js';
import { isLanguage, readerStateText, strings } from '../i18n.js';
import { hrefWithLang, langFromSearch, parseLanguage } from '../language.js';
import { useLanguage } from '../LanguageProvider.js';
import { debugEnabled, onLinkClick } from '../router.js';
import { Caption } from './Caption.js';
import { streamLanguageFor, useCaptionStream, type CaptionDebugLine } from './useCaptionStream.js';

const FOLLOW_THRESHOLD_PX = 80;

export function RoomPage({ config, slug }: { config: RuntimeConfig; slug: string }) {
  const [readerLang, setReaderLang] = useLanguage();
  const d = strings(readerLang);
  const [roomInfo, setRoomInfo] = useState<{ name: string; index: number; session: SessionSummary | null } | null>(null);
  const [roomError, setRoomError] = useState<'not_found' | 'load_error' | null>(null);
  // The subscribed stream: the reader's language when the session offers it, else the session's default stream.
  const [streamLang, setStreamLang] = useState<string | null>(null);
  const [announce, setAnnounce] = useState(false);
  const [following, setFollowing] = useState(true);
  // Announced text carries its own language: captions in the stream's language, states in the reader's language.
  const [liveMessage, setLiveMessage] = useState<{ text: string; lang: string }>({ text: '', lang: readerLang });
  const debug = debugEnabled();
  const explicitLang = langFromSearch(window.location.search);
  const debugRef = useRef<CaptionDebugLine[]>([]);
  const onDebug = useCallback((line: CaptionDebugLine) => {
    debugRef.current.push(line);
  }, []);
  const stream = useCaptionStream(slug, streamLang, config.publicWindowSegments, debug ? onDebug : undefined);
  const mainRef = useRef<HTMLElement>(null);
  const anchorRef = useRef<{ segment: string; top: number } | null>(null);
  const prevFollowingRef = useRef(true);
  // Segment numbering restarts per session and per stream, so the announced-segment key carries all three.
  const lastSegmentRef = useRef<string | null>(null);
  const lastStateRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchRoom(slug)
      .then((r) => {
        if (cancelled) return;
        setRoomInfo({ name: r.room.name, index: r.room.index, session: r.session });
      })
      .catch((e: unknown) => {
        if (!cancelled) setRoomError(e instanceof ApiError && e.status === 404 ? 'not_found' : 'load_error');
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  // The room fetch seeds the first subscription so it already opens with the right stream; afterwards the
  // stream's own session decides (a session switch may add or remove the reader's language). Subscribing
  // before the room's first session is intended: the stream announces it when it goes live.
  useEffect(() => {
    if (!roomInfo) return;
    const next = streamLanguageFor(readerLang, stream.sessionKnown ? stream.session : roomInfo.session);
    setStreamLang((current) => (current === next ? current : next));
  }, [readerLang, roomInfo, stream.sessionKnown, stream.session]);

  useEffect(() => {
    const parts = [roomInfo?.name ?? slug, stream.session?.title, config.eventName || d.appTitle].filter(Boolean);
    document.title = parts.join(' · ');
  }, [roomInfo?.name, stream.session?.title, slug, config.eventName, d.appTitle]);

  // Measure "following" before applying an update; compensate removed top segments in the same frame.
  const measureFollowing = () => {
    const doc = document.documentElement;
    const distance = doc.scrollHeight - (window.scrollY + window.innerHeight);
    return distance <= FOLLOW_THRESHOLD_PX;
  };
  useLayoutEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    const committedLines = () => main.querySelectorAll<HTMLElement>('.caption__line[data-segment]:not(.caption__segment--provisional)');
    const pageTop = (el: HTMLElement) => el.getBoundingClientRect().top + window.scrollY;
    if (prevFollowingRef.current) {
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'auto' });
    } else if (anchorRef.current) {
      // Removing top segments moves every remaining line up by the removed height; appends below
      // do not. The last line of the previous frame survives the trim, so its shift is that height.
      const previous = anchorRef.current;
      const anchor = [...committedLines()].find((el) => el.dataset.segment === previous.segment);
      const shift = anchor ? pageTop(anchor) - previous.top : 0;
      if (shift !== 0) window.scrollBy({ top: shift, behavior: 'auto' });
    }
    const lines = committedLines();
    const last = lines[lines.length - 1];
    anchorRef.current = last ? { segment: last.dataset.segment ?? '', top: pageTop(last) } : null;
  }, [stream.version]);

  useEffect(() => {
    const onScroll = () => {
      const f = measureFollowing();
      prevFollowingRef.current = f;
      setFollowing(f);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Display timing for the reader debug log: taken in a frame scheduled from the committing effect.
  useEffect(() => {
    if (!debug) return;
    const pending = debugRef.current.splice(0);
    if (pending.length === 0) return;
    requestAnimationFrame(() => {
      const displayAt = Date.now();
      const currentFinalText = stream.segments.map((s) => s.rows.map((r) => r.text).join('')).join('\n');
      for (const line of pending) console.log('[reader]', JSON.stringify({ ...line, displayAt, currentFinalText: currentFinalText.slice(-200), partialText: stream.partial.text }));
    });
  }, [stream.version, debug, stream.segments, stream.partial.text]);

  // Accessible announcements: one entry per closed segment and per state change, when enabled.
  useEffect(() => {
    if (!announce) return;
    const segs = stream.segments;
    if (segs.length >= 2) {
      const closed = segs[segs.length - 2];
      const key = closed ? `${stream.session?.sessionId ?? ''}:${stream.stream?.outputType ?? ''}:${stream.stream?.language ?? ''}:${closed.segmentSeq}` : null;
      if (closed && key !== lastSegmentRef.current) {
        lastSegmentRef.current = key;
        setLiveMessage({ text: closed.rows.map((r) => r.text).join(''), lang: stream.stream?.language ?? streamLang ?? readerLang });
      }
    }
  }, [stream.segments, stream.session?.sessionId, stream.stream, announce, streamLang, readerLang]);
  useEffect(() => {
    if (!announce) return;
    const label = readerStateText(d, stream.session, stream.sessionKnown).text;
    if (label !== lastStateRef.current) {
      lastStateRef.current = label;
      setLiveMessage({ text: label, lang: readerLang });
    }
  }, [stream.session?.state, stream.session?.cause, stream.session?.completeness, stream.sessionKnown, announce, d, readerLang]);

  const state = readerStateText(d, stream.session, stream.sessionKnown);
  const roomVar = roomInfo ? ({ ['--room' as string]: `var(--room-${((roomInfo.index - 1) % 8) + 1})` } as React.CSSProperties) : undefined;
  const session = stream.session;
  const hasText = stream.segments.length > 0 || stream.partial.text.length > 0;
  const streamLabel = session?.availableLanguages.find((l) => l.lang === streamLang)?.label ?? null;
  // Derived from the session rather than from `streamLang`, which lags one effect behind a language change.
  const shownLang = session ? streamLanguageFor(readerLang, session) : readerLang;
  const shownName = isLanguage(shownLang) ? d.languageName[shownLang] : (session?.availableLanguages.find((l) => l.lang === shownLang)?.label ?? shownLang);
  const roomsHref = hrefWithLang('/', explicitLang);

  return (
    <div className="listener">
      <a className="skip-link" href="#main">
        {d.skipToContent}
      </a>
      <header className="listener__header">
        <div className="listener__brand">
          <a href={roomsHref} onClick={onLinkClick} aria-label={d.roomsLink}>
            <img className="listener__logo" src="/brand/nerdearla-simplified.svg" alt="Nerdearla" />
          </a>
          {config.demoMode && (
            <>
              <span className="chip chip--status-warning">{d.demoChip}</span>
              <a className="chip chip--link chip--status-off" href={hrefWithLang('/admin', explicitLang)} onClick={onLinkClick}>
                {d.adminLink}
              </a>
            </>
          )}
        </div>
        <h1 className="listener__title">{session?.title ?? roomInfo?.name ?? d.roomFallback}</h1>
        <div className="listener__chips">
          {roomInfo && (
            <span className="chip chip--room" style={roomVar}>
              {roomInfo.name}
            </span>
          )}
          {streamLabel && streamLang && (
            <span className="chip chip--lang" lang={streamLang}>
              {streamLabel}
            </span>
          )}
          {state.status === 'live' ? <span className="chip chip--live">{d.stateLive}</span> : <span className={`chip chip--status-${state.status}`}>{state.text}</span>}
          {stream.connection === 'reconnecting' && <span className="chip chip--status-warning">{d.reconnecting}</span>}
          {stream.storage === 'failing' && <span className="chip chip--status-warning">{d.storageFailing}</span>}
        </div>
        {session && shownLang !== readerLang && (
          <div className="banner banner--warning" role="status">
            {d.languageFallbackNotice(d.languageName[readerLang], shownName)}
          </div>
        )}
      </header>
      <main className="listener__main" id="main" ref={mainRef}>
        {roomError && (
          <div className="banner banner--error" role="alert">
            {roomError === 'not_found' ? d.roomNotFound : d.roomLoadError}{' '}
            <a href={roomsHref} onClick={onLinkClick}>
              {d.backToRooms}
            </a>
          </div>
        )}
        {!roomError && !stream.sessionKnown && <p className="page-loading">{d.loadingRoom}</p>}
        {stream.sessionKnown && !session && <p className="listener__empty">{d.noSession}</p>}
        {/* Not offered is transient: the subscription follows the session's streams in the effect above. */}
        {session && !stream.languageOffered && <p className="listener__empty">{d.stateConnecting}</p>}
        {session && stream.languageOffered && !hasText && (
          <p className="listener__empty">{session.state === 'live' ? d.liveNoText : session.state === 'finished' ? d.finishedNoText : state.text}</p>
        )}
        {/* The stream's language, not the selection: while a language change is in flight the text on screen still belongs to the previous stream. */}
        {session && stream.languageOffered && hasText && streamLang && (
          <Caption segments={stream.segments} partial={stream.partial} lang={stream.stream?.language ?? streamLang} describeGap={d.gapTitle} />
        )}
        <div className="visually-hidden" aria-live="polite" role="log">
          {announce && liveMessage.text ? <span lang={liveMessage.lang}>{liveMessage.text}</span> : ''}
        </div>
      </main>
      {!following && hasText && (
        <button
          type="button"
          className="btn listener__jump"
          onClick={() => {
            window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'auto' });
            prevFollowingRef.current = true;
            setFollowing(true);
          }}
        >
          {d.jumpToCurrent}
        </button>
      )}
      <div className="listener__bar">
        <label className="visually-hidden" htmlFor="lang">
          {d.languageLabel}
        </label>
        {/* Options carry the server's labels, each written in its own language; choosing one sets the reader language. */}
        <select
          id="lang"
          className="field__input"
          value={session ? (streamLang ?? '') : ''}
          disabled={!session || session.availableLanguages.length === 0}
          onChange={(e) => {
            const next = parseLanguage(e.target.value);
            if (next) setReaderLang(next);
          }}
        >
          {!session && <option value="">{d.languageLabel}</option>}
          {session?.availableLanguages.map((l) => (
            <option key={l.lang} value={l.lang} lang={l.lang}>
              {l.label}
            </option>
          ))}
        </select>
        <button type="button" className="switch" role="switch" aria-checked={announce} onClick={() => setAnnounce((v) => !v)}>
          <span className="switch__track">
            <span className="switch__thumb" />
          </span>
          <span>{d.announceToggle}</span>
        </button>
      </div>
    </div>
  );
}
