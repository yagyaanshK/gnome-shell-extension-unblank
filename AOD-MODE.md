# Interactive AOD mode (local development)

This branch adds an optional interactive clock mode to Unblank, based on upstream
commit `e6a7d6b` (2026-10-21). It includes the
merged OLED shifting, dimming, black background, and screensaver notification fixes.
These additional interactive changes have not been submitted or merged upstream.

Enable **Restore wallpaper and brightness on input** in preferences, then
disable and re-enable Unblank. While locked and allowed by the AC policy:

- The clock and notifications fade to a black background at the configured
  brightness, with optional OLED shifting.
- Pointer or keyboard activity restores the wallpaper and normal brightness.
- After the configured inactivity interval, the dim clock returns. Password
  entry stays at normal brightness.
- Unplugging with the AC-only option enabled returns to normal screen blanking.
  Plugging back in resumes the clock; the unlock notification is preserved.
- The existing timeout remains in seconds; zero keeps the clock on indefinitely.

The interactive mode uses its own brightness controls, so the regular Unblank
content-opacity and black-background settings do not add a second dimming layer.
Its initial settings are 40% software brightness, 10 seconds idle delay,
1500 ms fade into the dim clock, and 300 ms fade back to the wallpaper.
OLED radius and interval continue to use the existing settings.

`aod-mode` defaults to false. Disabling the mode and re-enabling the extension
uses the normal upstream Unblank implementation. The new controller is kept in
`aodMode.js` to leave that implementation available. Both the controller and
Unblank's existing OLED helper are distributed under the repository's MIT license.

Upstream lists GNOME Shell 50 and 51. This branch adds the unlock-dialog session
mode so the extension keeps running in user and unlock-dialog modes.
Only GNOME 50.1 has been exercised in the local integration tests.

## Validation

```sh
python3 tests/aod-session.py
python3 tests/aod-session.py --reference --source /path/to/installed/always-on-display
```

The second command optionally runs the same checks against a local AOD extension
as a behavior reference. Its source is read locally and is not bundled here.
Each run starts a separate headless compositor after isolating HOME, XDG paths,
D-Bus and settings in `/tmp`. It does not change the real desktop or use PAM.
Virtual mouse and keyboard input exercise actual compositor idle watches.
Power properties are fake objects inside that compositor.

Checks cover animation durations/easing, final brightness/background opacity,
absence of double dimming, shift radius, input restoration, the 10-second idle
return, password page protection, AC/battery transitions, balanced lock/unlock
signals, and cleanup/re-enable. These tests establish the programmed behavior;
the real display's appearance and interaction with other installed extensions
still need confirmation on the physical lock screen.

The test compiles schemas only in temporary directories. No build output needs
to be generated in the source checkout. No CI or release workflow is required.
