-- Up Migration

-- Separate from `username` (the unique login credential, used for invite-lookup, never shown to
-- other users) - display_name is what actually renders in collaborative UI (top bar, presence
-- list, cursor labels, invite messages). Not unique on purpose: two people can share a display
-- name the way they can on any chat app, there's no lookup that depends on it being distinct.
-- No default/backfill needed - no real user data exists yet in any environment this has run
-- against (see the username-only-auth migration's identical note).
ALTER TABLE users ADD COLUMN display_name text NOT NULL;

-- Down Migration

ALTER TABLE users DROP COLUMN display_name;
