import { useEffect, useState } from 'react';
import type { PublicRoom, RuntimeConfig } from '@nerditulos/shared';
import { fetchRooms } from './api.js';
import { stateLabel, strings } from './i18n.js';
import { hrefWithLang, langFromSearch } from './language.js';
import { useLanguage } from './LanguageProvider.js';
import { LanguageSwitch } from './LanguageSwitch.js';
import { onLinkClick } from './router.js';

export function RoomsPage({ config }: { config: RuntimeConfig }) {
  const [lang] = useLanguage();
  const d = strings(lang);
  // Room links keep only an explicit `?lang`, so a shared link to `/` carries its language into the rooms.
  const explicitLang = langFromSearch(window.location.search);
  const [rooms, setRooms] = useState<PublicRoom[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetchRooms()
        .then((list) => {
          if (!cancelled) {
            setRooms(list);
            setError(false);
          }
        })
        .catch(() => {
          if (!cancelled) setError(true);
        });
    load();
    const timer = setInterval(load, 15000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    document.title = `${config.eventName || d.appTitle} · ${d.roomsTitle}`;
  }, [config.eventName, d.appTitle, d.roomsTitle]);

  return (
    <div className="listener">
      <a className="skip-link" href="#main">
        {d.skipToContent}
      </a>
      <header className="listener__header">
        <div className="listener__brand">
          <img className="listener__logo" src="/brand/nerdearla-simplified.svg" alt="Nerdearla" />
          <LanguageSwitch />
        </div>
        <h1 className="listener__title">{config.eventName ? d.roomsTitleFor(config.eventName) : d.roomsTitle}</h1>
        <p className="card__meta">{d.roomsIntro}</p>
      </header>
      <main className="listener__main" id="main">
        {error && (
          <div className="banner banner--error" role="alert">
            {d.roomsLoadError}
          </div>
        )}
        {!rooms && !error && <p className="page-loading">{d.roomsLoading}</p>}
        {rooms && rooms.length === 0 && <p className="listener__empty">{d.roomsEmpty}</p>}
        {rooms && rooms.length > 0 && (
          <ul className="rooms__list">
            {rooms.map((entry) => {
              const label = stateLabel(d, entry.session?.state);
              const roomVar = { ['--room' as string]: `var(--room-${((entry.room.index - 1) % 8) + 1})` } as React.CSSProperties;
              return (
                <li key={entry.room.slug}>
                  <a className="card card--link card--session" style={roomVar} href={hrefWithLang(`/r/${entry.room.slug}`, explicitLang)} onClick={onLinkClick}>
                    <div className="stack stack--tight">
                      <span className="card__title">{entry.room.name}</span>
                      <span className="card__meta">{entry.session ? entry.session.title : d.noSession}</span>
                      <span className="row">
                        {label.status === 'live' ? (
                          <span className="chip chip--live">{d.stateLive}</span>
                        ) : (
                          <span className={`chip chip--status-${label.status}`}>{label.text}</span>
                        )}
                        {entry.session?.availableLanguages.map((l) => (
                          <span key={l.lang} className="chip chip--lang" lang={l.lang}>
                            {l.label}
                          </span>
                        ))}
                      </span>
                    </div>
                  </a>
                </li>
              );
            })}
          </ul>
        )}
      </main>
      <footer className="footer" style={{ textAlign: 'center' }}>
        {d.footer}
      </footer>
    </div>
  );
}
