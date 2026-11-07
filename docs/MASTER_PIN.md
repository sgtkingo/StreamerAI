# Master PIN and profile recovery

Each account uses an eight-digit Master PIN. Welcome offers backup import below
the privacy note. New local households choose and confirm a new PIN only after
selecting “Start setup”; importing a PIN-protected backup asks for its existing
PIN instead. A fresh local household adopts that verified backup PIN after a
successful restore, without generating or asking for a replacement. An existing
account's Master PIN is preserved. New online owners choose their PIN in the hosted portal before
approving their first home server. Existing local households without a Master
PIN choose one on their next visit. Local and online Master PINs can be changed
in Security by providing the current PIN and confirming the new PIN. An online
change requires a connection to the cloud account.

The Master PIN is the default option when opening a protected profile. The
four-digit profile PIN remains available. Either PIN can authorize a change or
removal of that profile's PIN. Master PIN failures share a persistent account
lockout across profiles and browser sessions: five failures block further Master
PIN attempts for five minutes. Profile PIN lockouts remain independent.

The cloud stores a salted PBKDF2-SHA256 verifier with 600,000 iterations and a
random version, never a recoverable PIN. Existing online accounts receive a
random verifier lazily; the owner can choose a known PIN using reset in
`/account`. The hosted browser derives both chosen PINs and legacy initialization
verifiers before sending only the salt, hash and version to the Worker. This
preserves the 600,000-iteration format while avoiding the production Workers
limit of 100,000 native PBKDF2 iterations. Legacy initialization only fills an
empty legacy record and cannot overwrite a chosen PIN or bypass new-account
setup. Resetting an online Master PIN in the account portal requires a fresh
browser session. Changing it from a paired home server requires a proof derived
from the current PIN and the current verifier version. A separate secret verifier
is kept in the cloud and is never returned to paired servers. Existing cloud
accounts without this change verifier must confirm their current PIN once in the
account portal; this enrollment does not change the PIN. The Worker checks an
HMAC proof and performs a conditional update, without receiving either PIN.

The home server caches this verifier in its encrypted secret vault. Entering the
correct Master PIN also saves that PIN in the vault for automatic offline backup
encryption. The PIN is not returned to the application browser. On verification,
an online server refreshes the verifier first and discards any cached backup PIN
if the version changed. Without network access, the last cached verifier remains
usable. Online changes take effect locally when the server reconnects and checks
the Master PIN; an offline server cannot learn a remote reset immediately.

An eight-digit PIN has less entropy than a long passphrase. Household downloads and cloud copies use Argon2id (64 MiB, three passes, one lane) with a fresh salt to wrap an independent 256-bit household key. The encrypted payload uses authenticated AES-256-GCM. No separate printable recovery key is created or requested. A file always needs the Master PIN that protected it; resetting an online account PIN does not decrypt older files made with the previous PIN. The server keeps the last verified PIN in its encrypted vault to make future local and cloud backups automatically. See [encrypted household backups](ENCRYPTED_HOUSEHOLD.md).

“Forgot PIN? Verify account” sends a request through the already signed-in
account's cloud credential. It never starts device pairing. The owner approves
the named profile and home server in the account portal. Approval requires fresh
browser authentication and can be consumed only by the initiating device. The
home server additionally binds it to the initiating local session, account,
profile, PIN version and five-minute expiry. An approval allows one PIN change;
switching sessions, changing the PIN, disabling sync or expiry prevents reuse.
Local accounts and accounts with synchronization disabled see a muted explanation
instead of the account reset action. The Master PIN remains usable locally.

Deployment requires cloud D1 migration `0010_account_pins.sql` before publishing
the updated Worker, plus the matching home server and web application. The
migration backfills existing identities and installs a trigger for new ones.
