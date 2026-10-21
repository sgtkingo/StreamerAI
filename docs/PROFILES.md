# Viewer profiles and account placeholders

StreamerAI has up to five local viewer profiles per installation. Profile
selection is a landing screen with five medallion slots. Choosing a profile
scopes Home, discovery, Library and History to its ID. Creating a profile does
not overwrite the original `default` viewer. A newly created profile opens
onboarding immediately; if setup is interrupted, selecting its medallion
resumes onboarding. On a fresh installation the first viewer sees onboarding
before the profile chooser. The profile record is stored in
the existing SQLite `profiles` table; playback-language, taste and appearance
settings use its `preferences_json` field, including a per-profile completion
marker. No separate appearance table or database migration is required.

The avatar menu opens Settings, Preferences, My account and Statistics, plus
Log out / Switch profile. Here, **log out means leaving the active viewer and
returning to the chooser**. It is not a security boundary: authentication,
passwords and photo uploads are intentionally placeholders. Do not treat a
profile as an authenticated account or expose this service publicly on that
assumption.

Settings saves interface locale, appearance and playback language/subtitle
preferences per viewer. The player prefers the configured primary audio,
then secondary audio, then the first track. When automatic subtitles are
enabled it selects matching embedded text subtitles according to the chosen
audio track. External subtitle search and output-device selection are not
implemented yet and are labelled accordingly. Preferences saves genres and a
free-form taste prompt; injecting that prompt into the agent is future work.

The onboarding profile step includes playback-language settings, the full theme
selection and independent weather/lighting previews. Appearance changes preview
the full onboarding immediately; completing setup saves them on that viewer,
while canceling removes the preview and restores the
saved appearance. Running onboarding again from Settings edits the selected
profile and preserves its separate taste prompt. Connection settings remain
installation-wide.

## Appearance and device context

Every profile exposes `appearance: { mode, ambientMotion, seasonalMode,
weatherOverride, daylightOverride }`. New and missing preferences default to
`{ "mode": "auto", "ambientMotion": true, "seasonalMode": "auto",
"weatherOverride": "auto", "daylightOverride": "auto" }`.
Modes are `auto`, `cinematic`, `spring`, `summer`, `autumn`, `winter`,
`christmas` and `new-year`; the mode union remains backward compatible.
`seasonalMode` remembers the last non-Cinematic mode. Older records with a pinned
mode infer that remembered choice; the other new fields default to `auto`.

The top-bar control beside the medallion and the chooser offer only **Seasonal**
and **Cinematic**. Seasonal uses the remembered seasonal choice; toggling
Cinematic preserves that choice and the weather/lighting preferences. Settings
provides the detailed automatic/season/holiday selector, weather choices
`auto`, `clear`, `cloudy`, `fog`, `rain`, `snow`, `storm`, and lighting choices
`auto`, `day`, `night`. Manual weather is a visual override and works without a
location, forecast or geolocation permission. It does not change actual weather
observations, the device clock or the selected timezone.

**Fix current appearance** captures the resolved season, weather effect and
day/night as explicit choices. A neutral weather effect is stored as `clear`.
These three axes then stay fixed across calendar and forecast changes, without
storing a separate theme snapshot. **Use automatic settings** resets all three
axes to `auto` and resumes calendar/weather/daylight composition. Changes save
immediately through partial profile PATCHes. Updating one axis preserves the
other axes, a disabled `ambientMotion` setting and unrelated JSON preferences.
Failed saves retain an acknowledged baseline and a retry action; changes are
serialized and responses for a departed profile do
not replace the current viewer's appearance.

The chooser has a separate browser record containing only its last successfully
applied appearance, without a profile ID or other profile data. Choosing a
viewer activates the saved profile preference; leaving the viewer returns to
the chooser record. Other tabs reconcile device changes and invalidate the
affected profile after acknowledged appearance writes.

Time autodetection, IANA timezone, advancing manual-clock anchor, weather
enablement and coarse location are device context in a validated versioned
browser record. They are not inherited from the server timezone or copied from
another viewer. The manual clock changes the appearance clock, never server
time, playback timing, release eligibility, cache freshness or stored History
instants. Visible History timestamps use the chosen display zone.

Weather starts disabled and requires city selection or an explicit one-shot
location action. Coordinates are rounded to two decimal places before storage
and requests. Clearing weather removes location and the cached snapshot from
the device. Without automatic weather, Seasonal still combines calendar season
and local day/night, or uses the selected visual overrides. Christmas includes
colorful lights and decorative snow; New Year's Eve includes bounded fireworks
and decorative snow. Festive snow is decoration and does not imply measured
snowfall. Reduced motion retains static atmosphere; hidden pages and playback
pause animation. Cinematic retains the previous appearance and stops ambient
animation and recurring weather requests. See
[`ADAPTIVE_THEMES_PLAN.md`](ADAPTIVE_THEMES_PLAN.md) for composition, clock and
rendering details.
