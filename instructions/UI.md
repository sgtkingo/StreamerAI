# StreamerAI interface

## Global navigation

- StreamerAI logo on the left.
- `Home` and `Library` are the primary routes.
- On Home, compact links such as `Continue`, `New`, `Trending`,
  `Top Rated`, and `For You` scroll smoothly to section anchors rather than
  opening separate catalog pages.
- A compact Seasonal/Cinematic selector immediately beside the profile medallion,
  with the setup/health entry on the right.
- Automatic seasonal, weather and day/night presentation derived from
  `DESIGN.md`; Cinematic retains the fixed black/white/red presentation.
- English is primary; Czech and German are alternative interface languages.

## Appearance, time and weather

Theme defaults to automatic seasonal composition for existing and new viewers.
The top bar and profile chooser offer only Seasonal and Cinematic. Seasonal
restores the remembered automatic/season/holiday choice when leaving Cinematic;
the compact toggle preserves weather and lighting preferences. Detailed Settings
offers Automatic, Spring, Summer, Autumn, Winter, Christmas and New Year's Eve,
plus independent Weather (`auto`, clear, cloudy, fog, rain, snow, storm) and
Lighting (`auto`, day, night) controls. A pinned base still follows automatic
weather and daylight unless those axes are overridden. The chooser uses its last
acknowledged local appearance; selecting a viewer activates that viewer's saved
appearance.

Manual weather and lighting previews work without location or forecast access.
Label them as appearance choices, separately from actual weather observations.
Fix current appearance in Settings captures the resolved season, weather effect
and day/night into those three controls, with neutral weather stored as clear.
The result remains fixed across calendar and forecast changes. The Fix button
shows a closed lock and pressed state while fixed, and an open lock otherwise;
pressing it again unlocks all three axes. Use automatic settings also resets all
three axes to auto and restores live composition.

Onboarding retains the full theme selection and previews its draft appearance
immediately, including weather, lighting and the ambient-motion checkbox.
Completing setup persists the choice on that viewer; leaving
setup without completing it removes the preview and restores the saved theme.
Changing Theme or ambient motion from Settings saves independently of playback
and taste preferences. A failed save restores the acknowledged preference and
provides a retry; rapid changes remain ordered.

Settings puts Theme in Appearance, then groups Local time and Weather atmosphere
in one device-settings section below. Use
subdued gray for motion/persistence notes, approximate-daylight guidance and
weather attribution, including its links. The local clock displays seconds and
ticks once per second only while visible, without restarting the ambient scene.
Time autodetection (`Autodetekce` in Czech) uses the device clock and
IANA timezone without requesting location permission. Disabling it enables
timezone and manual wall-time controls. Changing only the timezone preserves
the instant; a manual clock continues advancing after reload. Reject times
skipped by daylight saving and require an explicit UTC-offset choice when a
time occurs twice. The effective clock changes theme evaluation only; History
uses real stored instants formatted in the chosen zone.

Weather is optional and starts disabled. Selecting a searched city or explicitly
choosing Use my location enables weather for coarse coordinates rounded to two
decimal places. Explain that this approximate location is sent to Open-Meteo.
Never request geolocation as a side effect of time autodetection or infer a city
from the timezone. Denied location permission leaves city search available.
Place a location card immediately below Weather atmosphere, showing the place,
administrative address, country, subtle condition icon, actual observation and
freshness. Unknown metadata stays explicitly unavailable rather than inferred.
Keep the location timezone and provider/license attribution visible. Place the
44 px square crosshair button beside city search, with an accessible Use my
location label and loading state. Disabling weather clears its device cache.
Unavailable automatic weather leaves season, local-time styling and manual
appearance overrides usable, without interrupting navigation or playback.

Use location sunrise/sunset as absolute instants where available. When solar
data cannot describe the effective date, label day/night as approximate and use
07:00–19:00 in the selected zone. Manual dates never reinterpret current weather
as historical weather. Cinematic stops recurring weather requests and ambient
effects.

The shared background appears behind onboarding, the chooser and application
chrome. Spring uses a lively green palette, with delicate willow twigs growing
from all four corners over about 16 seconds. Small light-green leaves and soft
silver-green catkins unfurl after their supporting stems. Keep the center clear,
scale back the corner foliage on compact screens and let it sway gently only
through the existing ambient clock. Preserve growth across weather, clock and
viewport changes. Disabled/reduced motion shows fully grown static sprigs.
Summer uses a brighter honey-yellow day palette and a warm sun in the upper-right
corner. Night has an ink-blue background with golden accents, crisp stars and a
phase-shaped moon. Compute the approximate lunar phase from the effective clock
locally using a mean synodic cycle; no forecast or network access is required.
This decorative phase does not imply astronomical moonrise/altitude accuracy.
Keep star positions stable across clock renders, with at most one short meteor
every 14–35 seconds (after an initial 5–10 second wait). Use the ambient clock
and all existing motion/playback guards; static mode retains sun, stars and moon
without meteors. Dim the sky under clouds, rain, storm, snow and especially fog.
Compact screens show fewer stars and smaller sun/moon elements.
Autumn occasionally sends an individual leaf in from either side: fast
wind sweeps alternate with gliding, one or two smooth loops and an off-screen exit.
Apparent depth smoothly changes its size, opacity, plane tilt and focus: distant
leaves are small and diffuse, nearby leaves larger and sharper behind frosted
glass. Blend cached focal-distance sprites instead of blurring every frame.
Keep at most two flying leaves on desktop and one on compact screens or alongside
glass weather. Motion guards apply; reduced motion uses static leaf silhouettes.
Christmas uses green, red and gold, colorful lights and decorative
falling snow. New Year's Eve uses navy, violet and gold, fireworks and decorative
falling snow. Festive snow remains visible as decoration independently of actual
or manually selected weather and never changes the reported weather condition.
The requested fireworks supersede the earlier prohibition on fireworks bursts;
use bounded, soft bursts without strobing or full-screen flashes. Rain lands on
the back of the glass: irregular refractive beads, slowly developing full-screen
condensation and sliding trails. Half of the beads remain stationary without trails;
the rest alternate fast slips with near-stops, occasionally steer sideways and
travel hundreds of pixels before evaporating. Their bounded wet trails follow the
actual bends in the path. Touching beads coalesce into a larger moving bead without
growing the particle pool. Rain gradually fogs the whole glass independently of
individual impacts. There are no localized impact fog patches or expanding rings.
Haze builds over tens of seconds with slow changes in humidity, pauses with the
simulation and survives viewport resizing. Reduced motion uses a static haze.
Around a third of normal rain impacts scatter two larger, rounder splash beads
from outside the parent bead's edge, scaled to its impact size. These move gently,
linger longer than storm spray and
evaporate through opacity without shrinking. Splash counts remain bounded even
when holiday effects are also active.
Storm uses dense, brief diagonal impacts from one shared wind direction with small
angular variations. Drops deform into long narrow shapes at contact and scatter
three tiny randomized splash beads, then fade in place without sliding or tails.
Random gusts sharply raise and lower impact density and force. A peak holds for
1–2 seconds, with a quick rise and fall and a longer, variable lull.
Already landed beads finish evaporating naturally; gusts reuse a bounded pool and
advance only with the ambient simulation, respecting all motion and playback guards.
Storm has no haze or impact condensation, including in static mode.
Storm also strikes the main Home composer: incoming drops share the wind angle,
hit its top and windward edge and rebound into five tiny spray beads. Keep spray
outside the input and button, use the same gust intensity and ambient clock,
and stop or hide it under the existing playback and motion guards. Bound the
local impact pool and follow the form dimensions on responsive layouts.
Isolated, contrasting lightning flashes have a quick bright crest and smooth afterglow;
motion and playback guards still apply. Snow lands, sticks briefly and creates bounded frost around the
edges. Lightning obeys every motion/pause guard and is absent in static mode.
Weather effects remain subordinate to readable surfaces, media artwork and semantic
status colors. Respect reduced motion and the ambient-motion checkbox with a
static treatment; pause particle work while hidden or during playback. Palette
changes crossfade gently, with immediate static changes under reduced motion.

## Conversational discovery header

The dominant control is a wide search/composer centered near the top of the
Home screen. It is more prominent than navigation, but remains visually calm:

- dark surface, thin low-contrast border, no shadow and no decorative gradient;
- large readable input with a subtle gray rotating/example placeholder;
- example copy: `Try “an autumn movie with Sandra Bullock”`;
- submit button and keyboard submit via Enter; multiline follow-ups use
  Shift+Enter for a new line;
- optional compact controls for voice input or clearing the conversation may be
  added later, but must not distract from text entry.

After the first request, the composer becomes the input for a continuing chat.
Previous user constraints and concise agent explanations appear in a restrained
conversation column. The results remain the visual focus; this must not become a
generic full-screen chat application.

## Default Home content

The page must never look like an empty search landing page. Directly below the
composer, render these sections in order when content exists:

1. **Continue Watching** — local progress, next episode and remaining time;
2. **New Releases** — recent validated releases from canonical feeds;
3. **Trending** — current canonical/search-assisted trends;
4. **Top Rated** — validated source ratings with a minimum-vote policy;
5. **Picks for You** — profile-aware validated recommendations.

Use a stale-while-revalidate experience: cached validated tiles appear
immediately, a small freshness indicator shows background refresh, and a
provider error does not erase the previous section.

Section navigation updates the URL fragment and scrolls with the header offset.
It must preserve keyboard focus, respect reduced-motion preferences and support
direct links such as `/#trending`.

## Progressive discovery state

Do not show a blank spinner. Display the bounded pipeline as understandable
steps without revealing chain-of-thought:

1. `Understanding your request`
2. `Finding possible titles`
3. `Validating metadata`
4. `Checking your streaming source`
5. `Ranking verified matches`

Partial candidate names are not displayed before validation. Errors are scoped
to the affected provider and preserve any already validated results.

## Result layout

### Best match

- One large, colorful cinematic tile using validated artwork.
- Title, year, type, source rating, short reason for the match and a prominent
  Play action when available.
- A small `Best match` label and a freshness/availability indicator.
- Alternate formats, languages and files remain behind a three-dot menu.
- Show **Play** as the primary action and **Add to Library** as the secondary
  action. If saved, replace the latter with a non-ambiguous `In Library` state.

### Available to stream

- A responsive grid or horizontal row of smaller colorful tiles.
- Each tile shows poster, title, year, rating with source, type and a compact
  availability/format summary.
- Hover/focus reveals genres, principal cast, one-line description and the
  recommendation reason.
- Play chooses the best compatible deterministic variant; alternate verified
  variants are available under the three-dot menu.
- Every card exposes **Add to Library** without requiring playback.

### Found, not currently available

- Separate section after all playable results.
- Artwork is grayscale with reduced contrast, while text remains accessible.
- No Play affordance. Show `Not found on Webshare` and the last check time.
- Allow **Add to Library**, `Check again`, or a new conversational refinement.
- Never use color alone to communicate unavailability.

Every rating must include a compact source label such as `TMDB 74%` or
`ČSFD 81%`. A StreamerAI relevance percentage, if present, is labeled
`Match`, not `Rating`.

## Series compound tiles

A series is represented by a stacked/compound tile:

- layered poster treatment or a subtle card stack signals multiple seasons;
- summary displays verified coverage such as `5 seasons · 42/50 episodes`;
- expanding the tile reveals season rows and episode availability;
- a fully available season is colorful, a partial season mixes available and
  grayscale episode states, and a missing season is grayscale;
- `Play next` appears only when the next episode has a verified playable file;
- tile primary action is `Play` only when S01E01 is verified and starts that
  exact episode; otherwise it is `Episodes` and opens the season guide;
- format and language alternatives remain selectable per season or episode.

On mobile, the compound tile opens a full-width detail sheet. On desktop it may
expand inline or open a focused detail panel.

All title tiles open a detail view on poster, title or Details action. Films use
the same detail shell without season rows; instead they show similar films or
other saga entries only when those suggestions have been deterministically
validated. Series details group episodes by season. Episodes already verified
for playback remain actionable while a background deep search is looking for
the remaining episodes. Pending episodes have a yellow indicator and the text
`• searching...`; a failed lookup can be retried without hiding ready episodes.

## Library page

Library is a true route and contains all titles that were explicitly saved or
have started playback.

- Default view uses compact poster tiles grouped or filtered by `Saved`,
  `In progress`, and `Completed`.
- Additional filters include Movies, Series, availability, genre, year and
  profile.
- Continue/Play Next is primary for in-progress entries.
- Saved unavailable items remain grayscale and may be rechecked.
- A series card shows next episode and verified coverage.
- Empty states point back to the Home composer instead of suggesting a full
  provider catalog exists.

### Watch History

Watch History is secondary to Library and appears in a collapsible side panel on
desktop. On mobile it opens as a dedicated sheet/page. It contains a
chronological list with poster thumbnail, title/episode, timestamp, progress and
completion state.

History controls include filtering, resuming, removing one event and clearing a
profile's history. Destructive actions require confirmation and explain whether
learned preference signals are also removed.

## Responsive and accessible behavior

- Desktop keeps the centered composer and cinema-wide result canvas.
- Tablet uses two-column supporting tiles.
- Mobile uses one column; the search/composer remains near the top and results
  preserve the Best → Available → Unavailable order.
- Home section links collapse into an accessible horizontal list or menu;
  Library remains directly reachable.
- The Library history side panel becomes a dedicated full-width sheet/page.
- All hover information is also available through keyboard focus and touch.
- Tiles have visible focus states, descriptive accessible names and minimum
  touch targets.
- Grayscale unavailable tiles retain WCAG-compliant text contrast and explicit
  status text.
- Reduced-motion mode disables animated placeholder transitions and card-stack
  motion.
