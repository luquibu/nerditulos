CREATE TABLE rooms (
  id serial PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  visible_session_id uuid NULL
);

CREATE TABLE event_sessions (
  id uuid PRIMARY KEY,
  room_id integer NOT NULL REFERENCES rooms(id),
  title text NOT NULL,
  source_language text NOT NULL CHECK (source_language IN ('es', 'en')),
  state text NOT NULL CHECK (state IN ('prepared', 'starting', 'live', 'interrupted', 'finishing', 'finished')),
  cause text NULL,
  started_at timestamptz NULL,
  finishing_at timestamptz NULL,
  ended_at timestamptz NULL,
  effective_config jsonb NULL,
  completeness text NULL CHECK (completeness IS NULL OR completeness IN ('complete', 'incomplete')),
  provider_generation integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX event_sessions_room_created_idx ON event_sessions (room_id, created_at DESC);

-- A room has at most one session that is not prepared or finished.
CREATE UNIQUE INDEX event_sessions_one_active_per_room
  ON event_sessions (room_id)
  WHERE state IN ('starting', 'live', 'interrupted', 'finishing');

ALTER TABLE rooms
  ADD CONSTRAINT rooms_visible_session_fk FOREIGN KEY (visible_session_id) REFERENCES event_sessions(id);

CREATE TABLE text_streams (
  id serial PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES event_sessions(id),
  output_type text NOT NULL CHECK (output_type IN ('original', 'translation')),
  language text NOT NULL,
  published_seq bigint NULL,
  UNIQUE (session_id, output_type, language)
);

CREATE TABLE final_chunks (
  stream_id integer NOT NULL REFERENCES text_streams(id),
  seq bigint NOT NULL,
  segment_seq integer NOT NULL,
  text text NOT NULL,
  tokens jsonb NOT NULL,
  provider_generation integer NOT NULL,
  received_at timestamptz NOT NULL,
  persisted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (stream_id, seq)
);

CREATE TABLE session_events (
  id serial PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES event_sessions(id),
  seq integer NOT NULL,
  kind text NOT NULL,
  detail jsonb NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, seq)
);
