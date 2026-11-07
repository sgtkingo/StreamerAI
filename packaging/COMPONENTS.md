# Prepared installer components

End users must receive one setup application. They do not find or install Node,
FFmpeg, Caddy or a Windows service wrapper themselves. The release builder prepares
those inputs before creating a setup executable.

On the target Windows or Linux x64 build machine, using Node **24.22.2 LTS**:

```sh
node scripts/distribution/components.mjs --output dist/components/win-x64
```

This reads the committed platform-specific `component-lock.win-x64.json` or
`component-lock.linux-x64.json`, downloads only exact
release assets, checks their length and SHA-256, and extracts explicitly named
members to `bin/` alongside `notices/`. ZIP entries are selected by exact name;
Linux tar members are streamed to fixed output files with `tar -xOf`, never
extracted to paths supplied by the archive. No downloaded executable is run and no
host service is installed. Cached assets are verified again before reuse.
External redirects are limited to the GitHub asset hosts. Failed/mismatched
downloads are removed and never used as setup inputs. The generated
`components.json` records provenance and hashes of the extracted files.

The default locks pin Node 24.22.2 LTS and its license, matching the release CI
target; installed native dependencies must be built for that Node ABI and the
target OS.
Windows files must not be copied into a Linux package. Linux asset provenance
is pinned, but systemd, glibc/shared-library and clean-machine acceptance require
actual target Linux testing.

The core sources are Caddy's official release, WinSW's official release, and the
FFmpeg project's linked BtbN build publisher. Caddy/BtbN hashes were read from
the official GitHub release asset metadata. WinSW 2.12.0 has no published asset
digest in that API, so its lock records a hash observed after an official HTTPS
download, with that provenance explicitly stated. Updating the lock requires
review; the installer never switches to `latest` automatically.

The selected FFmpeg build includes libx264 and is GPLv3. The included license
text is not by itself the full corresponding-source distribution. Before a
public release, prepare and review corresponding build/dependency source access
and notices for the actual binary build. A prepared component directory is not
an Authenticode signature, license clearance, security review or clean-machine
acceptance; `releaseReady` remains false. This internal review step does not
publish or distribute components to users.

Ollama is intentionally not part of these core assets. The optional AI setup
flow detects an existing runtime/model and offers installation only when needed;
its separately pinned installer and model download require explicit user choice.
