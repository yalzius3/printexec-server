-- Hide extra fields: a per-company DISPLAY default for the asset intake forms.
--
-- Purely a view preference. It stores nothing about the assets themselves, and
-- no server code reads it — the client is the only consumer. It lives on the
-- company rather than the user because a shop's operators fill the same forms
-- all day and shouldn't each have to tidy their own; the owner sets the house
-- default and anyone can still expand a form's extras in place.
--
-- DEFAULT false so every existing company keeps today's forms exactly as they
-- are, and nothing needs backfilling. NOT NULL so the client never has to
-- reason about a third, "unset" state — though it still treats an ABSENT column
-- (pre-migration server) as false, which is the same thing.
--
-- What "extra" means is deliberately NOT encoded here. It is a per-form
-- judgement about which boxes an operator fills every time versus once a year,
-- and it belongs next to the fields in the client. The one rule the client
-- enforces: a field that can ever be REQUIRED is never hidden, because an
-- unmounted required input cannot be validated by the browser and would fail
-- on the server with an error pointing at a box nobody can see.

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS hide_extra_asset_fields BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN companies.hide_extra_asset_fields IS
  'Display-only default for the asset intake forms: true = they open with the rarely-used fields collapsed behind "More fields". Client-side only; no server logic reads it. Required fields are never collapsed.';
