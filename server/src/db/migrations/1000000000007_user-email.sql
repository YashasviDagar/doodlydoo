-- Up Migration

-- Email is back (product decision reversal of 1000000000005): accounts now carry an optional
-- unique email, login accepts email OR username, and board invites can be sent by email. NULL is
-- allowed so accounts created during the username-only era aren't broken; the profile page lets
-- them add one. Uniqueness is enforced case-insensitively via a lower() unique index.
ALTER TABLE users ADD COLUMN email text;
CREATE UNIQUE INDEX users_email_lower_key ON users (LOWER(email)) WHERE email IS NOT NULL;

-- Down Migration

DROP INDEX users_email_lower_key;
ALTER TABLE users DROP COLUMN email;
