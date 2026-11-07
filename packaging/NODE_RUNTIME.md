# Reproducible Windows Node runtime inputs

The production target is the exact Node **24.22.2 LTS** Windows x64 executable
and better-sqlite3 **12.11.1** native binding for Node ABI **137**. A development
Node25 installation uses ABI141 and its native binding must not be copied into
the Node24 server package.

Prepare the inputs on a Windows x64 build machine after installing the frozen
workspace dependencies:

```sh
node scripts/distribution/node-runtime.mjs --output dist/runtime-inputs/win-x64-node24
```

The committed `node-runtime.win-x64.lock.json` pins immutable official release
URLs, lengths and SHA-256 values. Node's executable hash comes from the exact
release's official `SHASUMS256.txt`; the SQLite archive hash comes from the
official GitHub release asset digest. The matching Node license is pinned too.
Only HTTPS requests and redirects to the explicit upstream host allowlist are
accepted. Downloads are bounded by pinned lengths and cached files are verified
again before reuse. Mismatched or partial files are never used.

The helper produces `node.exe`, `better_sqlite3.node`, `NODE.txt` and a
`runtime-inputs.json` provenance/smoke-test record in a new output directory.
The binding is extracted by reading only the exact named archive member; no
arbitrary archive paths are extracted. The verified Node runtime then opens an
in-memory SQLite database with the exact installed JavaScript wrapper and
prepared native binding, and verifies the returned Node version, ABI, platform
and SQL result. No global Node installation, environment settings, package
dependency, user data or host service is modified.

The release bundler must use the prepared target Node and this matching native
binding together, with the corresponding target-version license. Its own target
runtime smoke test remains required. These build inputs are not an Authenticode
signature, a completed installer acceptance test or permission to publish a
release; the generated record keeps `releaseReady: false`.
