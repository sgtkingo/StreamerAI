# Player implementation

The player receives one verified source and a short-lived playback grant. It
does not merge audio or subtitle tracks across different files. The selected
profile's `PlaybackPreferences` supplies language priorities, preferred audio
output and subtitle appearance.

## Audio

`GET /playback/grants/:id/manifest` lists the selected file's audio tracks.
`GET /playback/grants/:id/media` maps the chosen track into fragmented MP4 and
transcodes it to AAC. Sources with more than two channels (2.1, 5.1 or 7.1)
are downmixed to stereo for predictable browser playback; the Audio menu still
identifies the source track's original channel layout. The player applies the
saved output device with `HTMLMediaElement.setSinkId` when available. If the
browser cannot select devices or the saved device has disappeared, playback
falls back to the system default and shows a notice. Device IDs may differ
between browsers and machines; the setting remains per profile.

Settings → 02 / Audio enumerates outputs already exposed to the page. Where
supported, the browser's native speaker picker grants access to a selected
output. Opening the output selector performs discovery. Without a native
speaker picker, that action may ask for temporary microphone permission,
enumerates devices, and immediately stops the microphone stream; the browser
may still expose only the system default. The small adjacent refresh button
repeats discovery. “Test audio output” plays a soft two-note cue through the
currently selected sink using the same routing API as video. The selected
output ID is saved per profile. If no audio track is
present in the manifest, the player advises choosing another source. If
autoplay is refused, the player asks for a manual Play click.

## Subtitles

Embedded text subtitles are converted server-side to WebVTT in short,
overlapping windows around the current playback position. Seeking requests a
new window instead of converting the entire film. FFmpeg limits input reading
to a ten-second window with two seconds of overlap; its segment-relative cue
times are shifted to absolute title time in the player using the response's
`X-Streamer-Subtitle-Offset` header.
A valid window with no cues (for example, a silent intro) is not an error; the
player simply renders nothing until a later window contains dialogue. Each
request has a bounded processing time, and the player reports an error if
conversion actually fails. A user may also
load a local SRT, VTT, ASS or SSA file in the player. The client parses the
selected WebVTT text and renders cues in its own overlay above the controls.
It compares cue times to the absolute title position, including the `start`
offset used for resume and seek. This avoids native caption placement beneath
the controls and keeps captions synchronized after a media-stream restart.

Settings → 03 / Subtitles stores preferred subtitle languages, automatic
selection and size/color/font. These style fields apply to embedded and local
subtitles. The player reports an unreadable or unavailable track and lets the
viewer choose another. Bitmap subtitle tracks are not exposed by the current
media probe; external subtitle-provider search is not implemented yet.

## Series autoplay

The player lists available episodes in season/episode order. At the end of an
episode it re-fetches the series detail if no next episode was known, then
shows a cancellable five-second countdown when a later playable episode is
found. “Play now” starts immediately. A failed next-episode preparation shows
an error without replaying the completed episode.

Tests cover cue timing after seeking, output-device routing, saved subtitle
appearance, and a next episode discovered only after the current one ends.
The grant endpoints continue to log fixed diagnostic codes without provider
URLs or credentials.
