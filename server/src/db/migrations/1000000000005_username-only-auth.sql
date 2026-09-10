-- Up Migration

-- Product decision: username + password only, email dropped entirely (see auth/routes.ts and
-- boards/routes.ts, which move from email-based login/invites to username-based). No real user
-- data exists yet in any environment this has been run against, so a straight drop is safe - a
-- populated environment would need a dedupe pass on username before this ADD CONSTRAINT could
-- succeed.
ALTER TABLE users DROP COLUMN email;
ALTER TABLE users ADD CONSTRAINT users_username_key UNIQUE (username);

-- Down Migration

ALTER TABLE users DROP CONSTRAINT users_username_key;
ALTER TABLE users ADD COLUMN email text;
