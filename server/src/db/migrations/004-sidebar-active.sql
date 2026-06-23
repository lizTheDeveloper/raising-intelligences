-- Persist the active sidebar slot so sidebar state survives server restarts.
-- Without this, phase = "sidebar" loads with sidebarActive = null, permanently
-- blocking parent messages until the client explicitly calls end-sidebar.

ALTER TABLE games ADD COLUMN IF NOT EXISTS sidebar_active TEXT;
