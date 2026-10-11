# Availability search priority

Search priority belongs to a viewer profile and a title. New titles start at
`low`. The star button on a card toggles `high` priority. Three detail opens
within seven days, four playback starts within thirty days, or starts of two
different episodes within thirty days also promote a title. Turning the star
off resets those interaction counts, so a later pattern of use can promote it
again.

Initial discovery still makes its bounded provider searches. A transient media
provider error gets up to three additional attempts, spaced by 300, 600 and
1200 milliseconds. Successful searches with no matching file are not repeated
immediately.

After that first discovery, automatic checks are scheduled per profile. Low
priority titles receive a randomized next check in 18–30 hours; high priority
titles in 90–150 minutes. The next time is stored locally, survives server
restarts, and is claimed before work starts. A timer processes up to two due
titles each minute, putting high priority titles first and rotating profiles.
Available movies and local files do not need a recurring source search. Series
guides continue to refresh on their schedule so newly published episodes can
appear. Opening a dormant unavailable title reads its status without
starting a new provider search.

Explicit retries bypass the schedule. Setting high priority triggers a check
immediately. Lowering priority cancels a running series episode search and
stops its progress animation. Preparing playback of a specific episode retries
its lookup if known files fail. Starting a series or season download checks unavailable
episodes before selecting files, while continuing with available episodes if
one lookup fails.

When playback reaches the end of an episode or the viewer presses Next, the
player shows which episode it is checking. It verifies the known file first,
then searches for a replacement if needed. If that episode cannot be played,
the player explains the skip and starts a five-second countdown for the next
verified episode. Checking and the countdown share one Up next dialog. The
Play now button shows moving dots during checking and a five-second fill during
the countdown. During the availability checks before a batch download, the
download button shows an animated preparation ring around its download icon.
