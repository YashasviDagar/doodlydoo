-- Up Migration

CREATE TABLE invited_users (
  board_id uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invited_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (board_id, user_id)
);
CREATE INDEX invited_users_user_id_idx ON invited_users (user_id);

-- Down Migration

DROP TABLE invited_users;
