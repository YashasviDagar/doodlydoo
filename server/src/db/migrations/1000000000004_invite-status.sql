-- Up Migration

-- Invites now require the invitee to accept before they get board access - see boards/routes.ts
-- and the new invites/routes.ts. Existing rows (from before this migration) default to 'accepted'
-- so already-granted access isn't silently revoked; new invites are inserted as 'pending'.
ALTER TABLE invited_users ADD COLUMN status text NOT NULL DEFAULT 'accepted' CHECK (status IN ('pending', 'accepted'));

-- Down Migration

ALTER TABLE invited_users DROP COLUMN status;
