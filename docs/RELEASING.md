# Vydání nové verze

Vydání je automatické. Stačí pushnout do `main` commit, jehož zpráva obsahuje
`(patch)`, `(minor)` nebo `(major)`. [Release workflow](../.github/workflows/release.yml)
pak zvedne verzi, otaguje `vX.Y.Z` a publikuje GitHub Release s:

| Soubor | K čemu |
| --- | --- |
| `StreamerAI-X.Y.Z-win-x64-setup.exe` | Instalátor pro Windows: server, aplikace pro PC, nebo obojí; umí upgrade |
| `StreamerAI-Client-X.Y.Z-win-x64-setup.exe` | Samostatná aplikace pro Windows (i pro její auto-update) |
| `StreamerAI-Client-X.Y.Z-android.apk` | Aplikace pro Android a Android TV |
| `streamerai-server-X.Y.Z-win-x64.zip` | Balíček pro automatickou aktualizaci serveru |
| `stable.json` | Podepsaná metadata aktualizací (Ed25519, platnost max. 31 dní) |
| `SHA256SUMS.txt` | Kontrolní součty |

Server, aplikace pro Windows i Android čtou
`https://github.com/sgtkingo/StreamerAI/releases/latest/download/stable.json`.

## Automatické zvýšení verze přes commity

| Značka v commitu | Příklad | Nová verze z 0.2.3 |
| --- | --- | --- |
| `(patch)` | `Fix TV playback (patch)` | 0.2.4 |
| `(minor)` | `Add Windows app updates (minor)` | 0.3.0 |
| `(major)` | `New household model (major)` | 1.0.0 |

- Rozhodují všechny commity v jednom pushi do `main` a vyhrává nejvyšší značka.
  Push bez značky nic nevydá (běží jen CI).
- Workflow nastaví verzi ve všech manifestech (server, web, aplikace, Android).
  Sekci `## Unreleased` v [RELEASE_NOTES.md](../RELEASE_NOTES.md) přesune pod
  `## vX.Y.Z (datum)` a založí novou prázdnou. Pak commitne
  `Release X.Y.Z (level) [skip ci]` a otaguje `vX.Y.Z`. `[skip ci]` zabrání
  smyčce. Po vydání si udělejte `git pull`.
- Do popisu GitHub Release se zkopíruje sekce vydané verze z `RELEASE_NOTES.md`,
  odkazy ke stažení a automaticky vygenerovaný seznam změn GitHubu.
- Ručně: Actions → Release → Run workflow. Lze zvolit úroveň, nebo zadat
  existující tag, který se sestaví a publikuje znovu (opravný běh).
- Pokud má `main` ochranu větve (branch protection), musí mít `github-actions[bot]`
  povolený push. Jinak workflow nedokáže commitnout zvýšenou verzi.

Během vývoje průběžně zapisujte změny pod `## Unreleased`.

## Nejrychleji: `scripts/Release.ps1`

```powershell
./scripts/Release.ps1 -SetupOnly                       # jednorázová příprava klíčů, secrets a environmentu
./scripts/Release.ps1 -Bump minor                      # vydání z main
./scripts/Release.ps1 -Bump patch -Message "Fix TV playback"
```

Skript při prvním spuštění vytvoří environment `release` omezený na větev `main`.
Vygeneruje podepisovací klíč aktualizací a Android keystore s náhodným heslem a
všechny secrets uloží přes `gh`. Klíče ukládá do `~/.streamerai-release` (tuto
složku zálohujte offline). Při vydání zkontroluje, že jste na aktuálním `main`,
a ukáže budoucí verzi a poznámky z `RELEASE_NOTES.md`. Pak spustí `pnpm check` a
`pnpm distribution:test` a po potvrzení pushne commit se značkou (případně
prázdný). Verzi a tag vytvoří až workflow. Potřebuje `git`, `node`, `pnpm`,
přihlášené `gh` a pro keystore JDK (`keytool`). `-SkipChecks` přeskočí testy,
`-Yes` přeskočí potvrzování.

## Jednorázová příprava ručně

1. **Podepisovací klíč aktualizací** (Ed25519, stačí jeden):

   ```sh
   pnpm release:key --private-key ~/streamerai-keys/update-signing.pem
   gh secret set STREAMERAI_UPDATE_SIGNING_KEY --env release < ~/streamerai-keys/update-signing.pem
   ```

   Skript odmítne zapsat privátní klíč do repozitáře a veřejný klíč uloží do
   `packaging/update-trust.json` (platnost 3 roky). Tento soubor commitněte.
   Privátní klíč si zálohujte offline: bez něj nepůjde vydat aktualizaci, kterou
   nainstalované servery a aplikace přijmou. Před vypršením trust souboru je nutné
   vydat verzi s novým (rotovaným) klíčem (`--replace`).

2. **Android keystore** (každá aktualizace APK musí být podepsaná stejným klíčem):

   ```sh
   keytool -genkeypair -v -keystore streamerai-release.jks -alias streamerai \
     -keyalg RSA -keysize 4096 -validity 10000
   base64 -w0 streamerai-release.jks | gh secret set STREAMERAI_ANDROID_KEYSTORE_BASE64 --env release
   gh secret set STREAMERAI_ANDROID_KEYSTORE_PASSWORD --env release
   gh secret set STREAMERAI_ANDROID_KEY_ALIAS --env release   # streamerai
   gh secret set STREAMERAI_ANDROID_KEY_PASSWORD --env release
   ```

   Keystore zálohujte offline. Stejný klíč lze později použít pro Google Play
   (Play App Signing, „upload key“).

3. V GitHubu vytvořte environment `release` (Settings → Environments) a v
   *Deployment branches and tags* povolte jen `main`. Secrets uložte do něj, ne
   do repozitáře. Povinné schválení (*Required reviewers*) je volitelné: každé
   vydání pak čeká na kliknutí „Approve“.

## Co workflow ověřuje

Trust soubor musí obsahovat platný klíč a nový tag nesmí existovat. Workflow pak
sestaví Windows (server, aplikaci, kombinovaný setup) a Android (podepsané APK),
podepíše `stable.json`, ověří ho proti trust souboru a vytvoří release. Když build
selže, tag a commit s verzí už existují. Po opravě spusťte workflow ručně s tímto
tagem, nebo vydejte další `(patch)`.

Pokud za 31 dní nevyjde nová verze, [refresh workflow](../.github/workflows/refresh-update-metadata.yml)
jednou týdně přepodepíše `stable.json` posledního vydání (stejné soubory, vyšší
sekvence), aby ho servery nepovažovaly za prošlé.

## Jak se aktualizace dostane k uživateli

- **Server (Windows):** zkontroluje novou verzi každých 6 hodin a ve výchozím
  nastavení ji na pozadí stáhne a ověří. Vlastník v `/admin` uvidí připomínku
  (i v přehrávači). Může nainstalovat hned, nechat si připomenout zítra, nebo v
  Administrace → Updates zapnout noční instalaci (02:00–05:00, jen když nikdo
  nesleduje). Instalaci provede služba `StreamerAIUpdater`. Když se nová verze
  nespustí, vrátí předchozí verzi i databázi.
- **Aplikace pro Windows:** stáhne a ověří nový instalátor a nabídne restart,
  jinak se nainstaluje při zavření aplikace.
- **Android:** jednou denně nabídne aktualizaci. Systém se zeptá na potvrzení a
  přijme jen APK podepsané stejným klíčem.
- **Linux / Docker:** zatím ručně (nový `.deb`, nový image).

## Známá omezení

- Windows instalátory nejsou podepsané Authenticode, takže SmartScreen zobrazí
  varování. Integritu aktualizací chrání podpis Ed25519, varování ale ne. Řešení:
  Azure Trusted Signing nebo SignPath (pro open source zdarma).
- Klient pro Android ověřuje SHA-256 z `stable.json` a podpis APK systémem, ale
  ne Ed25519 podpis metadat (Android API 26 Ed25519 nemá).
- Upgrade přes Setup a nasazení updateru zatím neprošly akceptací na čistém
  Windows (instalace 0.1.0 → upgrade → automatická aktualizace → rollback).
