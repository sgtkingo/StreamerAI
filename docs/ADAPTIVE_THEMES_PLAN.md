# Adaptive themes: implementation plan

Status: adaptive-theme implementation and the control/festive-visual follow-up
are implemented and verified. Latest automated and browser checks are recorded
in [`VALIDATION.md`](VALIDATION.md#glass-weather-and-appearance-layout-checks-2026-10-21),
alongside earlier checks, unrelated workspace failures and hardware limits.
Branch: `feature/adaptive-theme`, based on `main` at `f3e7342`.
Prepared: 2026-10-20.
Control and festive-visual specification updated: 2026-10-21.

The runtime now includes appearance contracts and profile persistence, the pure
calendar/daylight/weather resolver, an advancing IANA/manual clock, validated
device storage, a bounded Open-Meteo adapter, shared controls and an ambient
renderer. The current follow-up limits the top bar and chooser to Seasonal and
Cinematic, expands Settings with independent weather/lighting overrides and
Fix current appearance, and adds Christmas lights/snow plus New Year
fireworks/snow. Onboarding retains detailed theme choices and previews of all
three appearance axes. Cinematic preserves the previous palette.

The glass-weather refinement adds irregular refractive rain beads, gradually
developing full-screen condensation, peripheral splashes scaled to the impact bead,
and long sliding paths with fast slips, near-stops, bends and bead coalescence.
Rain haze develops independently of impacts, with no localized fog patches or rings.
Dense, wind-driven
storm impacts from a shared angle, narrow impact deformation and three tiny splash
beads per impact, without sliding, tails, fog or condensation. Lightning has a
brighter crest and a smooth afterglow. Snow sticks with edge frost. Appearance
contains Theme, with Local time and Weather atmosphere grouped in one section below.
Fix is a lock toggle, the
clock ticks per second locally within Settings, and the weather location card
shows supplied city metadata and real observation freshness separately from
manual visual previews. A square crosshair control sits beside city search.

## Intended behavior

Make automatic composition the default, labeled `Seasonal` in the compact
top-bar and chooser control. Compose its appearance from three independent
inputs: the local calendar season or holiday, current weather at a configured
location, and day/night. Apply the result to the application chrome and the
profile-selection screen, including medallions and the create-profile dialog.
Keep film artwork and availability, warning and error semantics readable.

The new request supersedes the monochrome-only chrome rules in
[`instructions/DESIGN.md`](../instructions/DESIGN.md) and
[`instructions/UI.md`](../instructions/UI.md) for adaptive themes. Those rules
continue to describe `Cinematic`, which preserves the current black/white/red
appearance. Update those specifications when implementing this plan.

| Choice or action              | Behavior                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Seasonal                      | Compact top-bar/chooser choice; restore the remembered automatic, season or holiday selection.                 |
| Cinematic                     | Current fixed appearance; ambient effects and recurring weather requests are disabled.                        |
| Automatic                     | Detailed selector: calendar season/holiday + automatic weather + automatic daylight unless separately pinned. |
| Spring, Summer, Autumn, Winter | Pin the seasonal base; weather and lighting retain their independent choices.                                 |
| Christmas, New Year's Eve      | Pin the festive base, including decorative snow and lights or fireworks.                                      |
| Manual weather or lighting    | Override only that appearance axis, without requiring location or forecast access.                            |
| Fix current appearance        | Pin the resolved base, weather effect and period through the three existing preference axes.                  |
| Use automatic settings        | Reset season, weather and lighting to automatic composition.                                                  |

The top bar immediately beside the profile medallion and the chooser offer only
Seasonal/Cinematic. Keep the complete season/holiday selector in Settings and
onboarding, alongside weather, lighting and ambient-motion choices. Toggling
Cinematic remembers the last Seasonal selection and restores it when returning.
Selection applies immediately; pending or failed profile saves have a clear state
and can be retried. Fix current appearance captures `resolvedTheme.id`, weather
effect (`none` becomes `clear`) and day/night into explicit preferences. It does
not create a separate locked snapshot. Use automatic settings resets all three
axes to `auto`.
New labels follow the interface locale, including Czech `Autodetekce` for the
automatic-time checkbox.

## Current integration points

| Existing code                                          | Required change                                                                                                                       |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/App.tsx`                                 | Wrap the entire exported App with the shared provider, covering loading, onboarding, chooser and AppShell. Tests render App directly. |
| `apps/web/src/components/AppShell.tsx`                 | Group Theme and avatar as right-side actions; preserve the responsive topbar grid. Expose playback activity to the ambient layer.     |
| `apps/web/src/components/ProfilePages.tsx`             | Add Appearance, Time and Weather sections; synchronize their state with the quick selector.                                           |
| `apps/web/src/components/ProfileChooser.tsx`           | Use shared tokens/background; preserve medallion focus and create-profile interactions.                                               |
| `apps/web/src/styles.css`                              | Extend existing CSS variables; replace theme-relevant hardcoded colors and opaque backgrounds that would hide the ambient layer.      |
| `apps/web/src/components/LibraryPage.tsx`              | Format history timestamps in the selected timezone, without changing stored instants.                                                 |
| `packages/contracts/src/onboarding.ts`                 | Extend viewer and update schemas with validated appearance preferences and backward-compatible defaults.                              |
| `apps/server/src/services/streamer-core.ts`            | Extend profile creation, public serialization and preference patching; preserve unrelated preferences on setup reruns.                |
| `apps/server/src/app.ts`, `apps/web/src/api/client.ts` | Wire profile-independent environment endpoints and injected weather transport/clock.                                                  |

Existing `profiles.preferences_json` can store appearance preferences without a
SQLite schema migration. Theme, timezone and weather context remain separate
from catalog and playback providers.

## Composition rules

Create a pure `resolveTheme()` function with explicit inputs: mode, effective
instant, IANA timezone, optional location, normalized weather snapshot, and motion
preferences. Return palette tokens, seasonal motif, weather effect, brightness
and animation budget. Keep fetches, timers and storage outside this function.

1. Resolve `Cinematic` first. It uses the current palette and no new ambient layer.
2. Resolve the seasonal base. In Automatic, evaluate the calendar in the effective
   timezone. Initial holiday windows are December 20–30 for Christmas and
   December 31–January 1 for New Year's Eve, inclusive. Holidays take precedence.
   Keep these product defaults in one calendar configuration.
3. Outside holidays, use meteorological seasons: March–May spring, June–August
   summer, September–November autumn, December–February winter in the northern
   hemisphere. Reverse them for a configured southern-hemisphere location;
   default to northern seasons when location is unavailable. Holiday dates remain
   calendar-based in either hemisphere.
4. A manual daylight override pins day or night without changing the device clock
   or timezone and is not labeled approximate. Otherwise apply day/night
   brightness and contrast without making daytime an unreadable bright overlay.
   With valid solar data for the effective date/location, use
   sunrise/sunset. Use fresh `is_day` for polar cases where those times are absent.
   Without usable data, use a documented approximate 07:00–19:00 day interval in
   the selected timezone. Show the approximation in Settings.
5. A manual weather override selects clear, cloudy, fog, rain, snow or storm even
   without a location or usable observation. It changes appearance only. In auto,
   use fresh normalized real weather. Apply its tint, haze and particles without
   replacing the seasonal base. Ordinary winter does not imply snowfall;
   Christmas and New Year's Eve add decorative snow independently of the weather
   axis, without fabricating a real snow condition.
6. Bound visual complexity: one dominant weather effect and a sparse seasonal
   motif. Rain/snow suppress ordinary decorative particles and fog lowers their
   visibility; festive snow and lights/fireworks share the same total budget.
   Crossfade state changes over approximately 1 second; reduced motion switches
   immediately to a static rendering.

| Base           | Subtle visual direction                                   |
| -------------- | --------------------------------------------------------- |
| Spring         | Muted green and blossom tones; sparse blurred petals.     |
| Summer         | Warm, restrained amber; slowly drifting light/bokeh.      |
| Autumn         | Copper and burgundy; blurred colored leaves.              |
| Winter         | Cool blue-gray; quiet crystal-like highlights.            |
| Christmas      | Green, red and gold; colorful lights and decorative falling snow. |
| New Year's Eve | Navy, violet and gold; bounded fireworks and decorative falling snow. |

Examples to review: autumn + rain + night, spring + fog + day, winter + clear +
day, Christmas + clear + night, and New Year's Eve + overcast + night. The explicit
request for fireworks replaces the earlier no-fireworks rule. Use soft bounded
bursts without strobing and share the particle budget with decorative snow and
weather effects. The later glass-weather refinement adds refractive rain impacts
and trails, denser storm impacts with irregular smooth lightning glows, and
sticking snowflakes with bounded edge frost. Lightning is a storm effect only
and stops under every motion/pause guard.

## Settings and persistence

Separate preferences belonging to a viewer from context belonging to the device.

- **Profile appearance:** `appearance: { mode, ambientMotion, seasonalMode,
  weatherOverride, daylightOverride }`, persisted through the existing profile
  PATCH endpoint. Defaults are `mode: "auto"`, `ambientMotion: true` and `"auto"`
  for the three added fields. Keep the existing mode union backward compatible.
  Older pinned records infer `seasonalMode` from their non-Cinematic mode;
  weather and lighting overrides default to `auto`. `seasonalMode` remembers the
  non-Cinematic choice. Define a separate partial appearance PATCH schema without
  defaults and merge it with existing appearance on the server. Updating one axis
  preserves the other axes and disabled `ambientMotion`. Fix current appearance
  writes explicit mode, weather and lighting choices; automatic settings resets
  those three axes, preserving motion and unrelated preferences.
- **Device context:** a validated, versioned browser record containing time mode,
  manual-clock anchor, timezone, weather enablement and selected coarse location.
  Label these Settings sections as applying to this device. Device context must
  never inherit the server/container timezone or location.
- **Chooser appearance:** a separate local record containing only the last
  successfully applied appearance choice, with Automatic as the initial value.
  A chooser change saves locally; selecting a profile activates its stored
  appearance and updates the chooser record. Switching out of a profile uses
  that record without implicitly selecting a viewer or copying profile data.
- **Failure handling:** profile state remains server-authoritative. Serialize or
  coalesce rapid appearance patches, ignore replies for a previous active profile,
  and keep the acknowledged baseline separate from the latest desired choice.
  Roll back a failed optimistic change only if it still owns the displayed value;
  an older failure must not undo a newer queued choice. Do not let an open Settings draft
  overwrite a newer topbar choice. Device-setting validation/storage failures
  leave a usable in-memory configuration and report unsaved changes.

Update the local appearance record only after a profile save succeeds. Validate
old/corrupt browser records and unsupported enum values; fall back safely. Listen
for storage changes so two tabs do not display inconsistent device settings.
After profile saves, broadcast an invalidation keyed by profile ID; tabs viewing
that profile refetch authoritative preferences. Concurrent tabs use the server's
last accepted write, then reconcile after local pending saves finish. A chooser-record storage event
updates only a chooser, never the preference of a different active profile.
Do not persist raw precise geolocation or a location trail.

### Time

Settings shows the effective local date/time and timezone. `Autodetekce` is checked
by default: use the device clock and
`Intl.DateTimeFormat().resolvedOptions().timeZone`; validate the zone and use UTC
if unavailable. This API exposes the runtime's timezone independently of a
location permission. [MDN: resolvedOptions](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/DateTimeFormat/resolvedOptions)

When unchecked, enable an IANA timezone selector and manual date/time fields,
initially populated from the effective clock. Keep the selected zone if the user
only wants to correct time; preserve the instant when changing the zone alone.
Store a UTC anchor plus the real instant when it was set. The application clock
continues advancing from that anchor, including after reload. Rechecking
Autodetekce immediately returns to the device clock and detected timezone.

Convert manual wall time using a dedicated, tested timezone utility; do not parse
`datetime-local` with the browser's implicit timezone. Reject nonexistent DST
times, and ask the user to choose the UTC offset for ambiguous repeated times.
Use monotonic elapsed time while the page is active and reconcile on resume.
Recompute theme at minute boundaries, on focus/visibility changes, at calendar
boundaries and when the detected timezone changes.

The manual clock affects theme evaluation and the Settings clock. It never changes
the OS clock, server clock, playback timing, release eligibility, cache TTL or
stored history timestamps. The selected zone formats visible event timestamps
using their actual instants. Manual dates outside the weather solar-data window
use the documented approximate day/night rule; do not apply the provider's
current `is_day` to a different simulated instant. Weather stays current, not
historical, when the appearance clock is adjusted.

### Location and weather

Weather is optional. Enable it by selecting a city in Settings or explicitly
choosing `Use my location`; show that the approximate location is sent to the
weather provider. Never infer a city from timezone or silently use an IP-location
service. Without a location, Automatic still provides season and day/night.

Time autodetection never requests geolocation. Browser geolocation requires a
secure context and user permission, so manual city selection is also essential
for home-server HTTP deployments. [MDN: Geolocation API](https://developer.mozilla.org/en-US/docs/Web/API/Geolocation_API)

Use a one-shot position request after the explicit action, not continuous tracking.
Round coordinates to two decimal places before storage or transmission. Denial,
timeout or unavailable geolocation leaves city search usable. Show the city and
timezone independently, so manually choosing a distant zone is understandable.
Disabling weather cancels requests and clears location/weather cache on the device.

## Weather adapter and API

Choose Open-Meteo for the initial self-hosted integration. Its forecast API has
current conditions, WMO weather codes, `is_day`, and daily sunrise/sunset. Request
Unix timestamps and convert with the application's IANA zone rather than applying
a fixed UTC offset across DST. [Open-Meteo forecast documentation](https://open-meteo.com/en/docs)

Implemented optional endpoints, available before profile selection:

- `GET /api/v1/environment/locations?q=...&language=...`: debounce city search,
  return a small validated list of labels, coordinates and IANA zones. The
  provider supplies city search and timezone metadata.
  [Open-Meteo geocoding documentation](https://open-meteo.com/en/docs/geocoding-api)
- `GET /api/v1/environment/weather?latitude=...&longitude=...`: normalize the
  response to condition, precipitation intensity, cloud cover, observed/fetched
  instants, current day flag, solar intervals and freshness. Include attribution.

Use a fixed-origin server adapter, following `provider-http.ts` error conventions.
Request `current=weather_code,is_day,precipitation,cloud_cover`,
`daily=sunrise,sunset`, `forecast_days=2`, `timezone=auto`, `timeformat=unixtime`.
Group codes into clear/cloudy/fog/rain/snow/storm; unknown codes yield neutral
weather. Validate required values, handle missing solar times independently, and
never expose unvalidated upstream responses or raw upstream error bodies.
Match solar intervals to the calendar date in the weather location's IANA zone
and compare absolute instants; changing the display zone must not reinterpret
sunrise/sunset. Keep the provider location zone separate from the display zone.

Keep this environmental adapter separate from catalog, streaming and agent
providers. It needs no Ollama access, setup prerequisite or full connector-family
expansion. Add injectable fetch and real clock dependencies to `createApp()`.

Bound input lengths, coordinate ranges, response sizes and timeouts (5 seconds).
Do not accept arbitrary upstream URLs. Start with a 256-entry in-memory LRU,
15-minute weather TTL, in-flight request deduplication and a bounded city-search
cache. Use an installation-wide upstream request budget and concurrency cap;
weather and geocoding have separately bounded queues. Optional client quotas must
use only configured trusted-proxy identity, never arbitrary forwarded headers.
Return fresh/stale/unavailable explicitly, evaluating condition age from its real
observed instant even after a successful HTTP response. Retain conditions for at
most 2 hours, then use neutral weather. Solar intervals can outlive that condition
TTL while valid for their location/date. Honor 429 retry timing and share bounded
failure backoff with jitter across clients/tabs to prevent repeated failed calls.

Refresh at most once per 15 minutes while visible, and on resume only when stale.
Abort/ignore responses for a replaced location; use real time for freshness.
Stop recurring requests in Cinematic, when weather is disabled or while offline.
Keep a last validated device snapshot for startup/offline rendering. Weather
errors appear quietly in Settings, without repeated global toasts or blocking
profile selection, navigation, discovery or playback. Audit logging so neither
coordinates nor upstream query strings appear in error logs.

The free service is for noncommercial use and has rate limits; the home-server
use case fits that initial choice. Commercial distribution needs a suitable
provider plan or replacement adapter. [Open-Meteo terms](https://open-meteo.com/en/terms)
Display provider credit and a license link in Weather settings; attribution is
required. [Open-Meteo attribution requirements](https://open-meteo.com/en/pricing)

## Rendering and accessibility

Add one shared `AmbientBackground` below all content, with `aria-hidden`,
`pointer-events: none` and no focusable children. Use a Canvas 2D particle layer
for leaves, petals, snow, festive lights, fireworks and refractive glass impacts,
plus a bounded CSS haze
layer. Cache blurred particle sprites; avoid per-frame full-screen blur and React
state updates. No animation framework, video background or WebGL is needed.

Start with at most 40 particles on desktop and 16 on compact screens, a device
pixel-ratio cap of 1.5 and a 30 fps ceiling. Pause animation on hidden pages and
while video is playing. `prefers-reduced-motion`, the Ambient motion checkbox,
and slow-frame detection select a static treatment while retaining the palette.
Christmas and New Year's Eve retain a static festive treatment with decorative
snow and lights or fireworks when motion is disabled; festive animation remains
within the shared particle and frame-rate budgets.
Verify actual frame cost and tune these initial budgets on a desktop and a phone.

Theme tokens cover page/surface colors, borders, primary/secondary text, focus,
accent and ambient opacity. Preserve semantic status colors and poster treatment.
Keep readable surfaces behind text, menus and dialogs. Ensure the root layer is
visible through intentional background areas, without putting effects over cards,
controls or the player. Update runtime browser `theme-color`; keep the PWA
installation splash stable. Check contrast for every base in both day and night.

## Implementation sequence

1. **Contracts and persistence:** add `appearance.ts` and `environment.ts` to
   contracts; extend profile schema/defaults, serialization and PATCH handling.
   Preserve existing JSON fields and onboarding behavior. Add browser-record
   validation and a shared appearance update action.
2. **Clock and deterministic resolver:** implement `theme/clock.ts`, calendar
   configuration and `theme/resolve-theme.ts`; cover timezone and fusion rules
   before adding effects. Provide injected clocks and reproducible fixtures.
3. **Weather service:** implement `integrations/open-meteo-client.ts`,
   `services/environment-weather.ts`, `routes/environment.ts`, API contracts and
   client methods. Exercise normalization, caching and failure behavior with
   mocked HTTP responses.
4. **Shared UI state and controls:** add `ThemeProvider`, `ThemeSelect` and an
   appearance/environment Settings component. Integrate App, AppShell, chooser,
   profile switching and timestamp formatting. Make asynchronous saves consistent.
5. **Visuals:** extract theme tokens, add seasonal palettes and the bounded ambient
   renderer. Review named fusion examples and a Cinematic baseline on desktop,
   tablet and mobile; tune contrast and performance.
6. **Release verification and docs:** update UI/design/profile/API/integration
   documentation, run `pnpm check`, and record browser acceptance with provider
   failures, denied location, reduced motion and playback active.

Steps 1–2 establish the model. Weather work can then run alongside initial UI
controls using shared fixtures; final visual verification follows their integration.

## Acceptance checks

- Existing and new profiles start in automatic Seasonal composition unless they
  have a saved choice. The top bar and chooser expose only Seasonal/Cinematic;
  Settings and onboarding retain detailed season/weather/lighting choices.
  Reload, profile switching, logout and chooser appearance follow the stated
  persistence rules; changing Theme never changes unrelated profile preferences.
- Settings and quick selectors stay synchronized, including rapid changes,
  delayed failures, two tabs and switching profiles during a pending request.
  Patching only the mode preserves `ambientMotion: false`.
- Manual weather and day/night previews work without location permission or a
  forecast. Fix current appearance remains stable across calendar and weather
  changes; automatic settings restores all three automatic axes. Cinematic
  toggling restores the remembered Seasonal choice.
- Test all season/holiday boundaries, December/January rollover, leap day,
  opposite hemispheres, day/night transitions, missing solar data and polar cases.
- Test browser/server timezone disagreement, manual IANA zones, DST gaps and
  duplicates, manual-clock advancement, midnight and resuming from sleep.
- Test rain/fog/snow/clear/unknown codes, malformed/oversized upstream responses,
  timeouts, 429 backoff, cache expiry, deduplication, eviction and location races.
- Disabled/denied/unavailable geolocation, city search and unavailable weather
  preserve usable season/day-night styling. No automatic permission prompt occurs.
- Cinematic visually matches the existing black/white/red interface. Adaptive
  themes cover chooser, topbar, Settings and dialogs, with legible semantic states.
- Christmas has colorful lights and decorative snow; New Year's Eve has bounded
  fireworks and decorative snow even with clear weather. Decorative snow never
  changes the real condition. Reduced motion retains a static festive treatment.
- Verify keyboard labels/focus, 320 px layout, reduced motion, no intercepted
  clicks, paused hidden-page/playback animation and bounded frame work. Test that
  weather outages do not block playback or discovery.
- Extend `apps/server/tests/profiles.test.ts`, add focused environment/resolver
  tests, and extend `apps/web/src/App.test.tsx` plus Settings/provider interaction
  coverage. Use deterministic fixtures for logic and actual browser review for
  layering, contrast and motion; avoid animation snapshots as a substitute.

Runtime implementation and feature validation are present on this branch.
The acceptance list remains the regression checklist. See `VALIDATION.md` for
the passing feature checks, browser coverage, existing unrelated workspace
failures and the remaining real-device performance limit.
