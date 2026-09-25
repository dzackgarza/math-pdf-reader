-- Hyprland window rules for the bucket window; load them from the Hyprland Lua config with
-- dofile("<checkout>/desktop/hyprland/pdf-bucket.lua").
--
-- After a capture the window's follower script calls setFocus, which GTK sends to the
-- compositor as an xdg-activation request. Hyprland marks the requesting window urgent and
-- focuses it only when focus_on_activate holds for that window (CWindow::activate in
-- src/desktop/view/window/Window.cpp); the rule turns it on for this window alone, leaving
-- misc.focus_on_activate as the user set it. Rule syntax: the Hyprland wiki, Window Rules.
-- The class is the Wayland app_id, which Tauri takes from the binary name in Cargo.toml.
hl.window_rule({ match = { class = "^(pdf-bucket-desktop)$" }, focus_on_activate = true })

-- The window opens on workspace 8 without switching to it; an activation after a capture
-- then brings workspace 8 into view.
hl.window_rule({ match = { class = "^(pdf-bucket-desktop)$" }, workspace = "8 silent" })
