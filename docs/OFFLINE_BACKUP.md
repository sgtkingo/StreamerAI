# Offline záloha a obnova serveru

První implementace poskytuje lokální CLI pro Windows/Linux. Zálohu vytvoří,
ověří i obnoví bez síťového spojení. **Před exportem i obnovou zastavte službu
StreamerAI.** CLI a produkční server sdílejí zámek datového adresáře; otevřenou
instanci odmítne. Starší verze serveru bez tohoto zámku je také nutné zastavit.
Vyžaduje Node.js alespoň 24.7 s Argon2id.

Ze zdrojového projektu spustíte příkaz jako:

```powershell
node --import tsx apps/server/src/backup/cli.ts --help
```

V nativním balíku použijte jeho Node runtime a odpovídající `backup.mjs`.
Příklady níže používají zdrojový projekt; cesty nahraďte vlastními. Export automaticky
použije osmimístný Master PIN vybraného účtu ze šifrovaného místního trezoru.
U online účtu jej nejprve ověřte v aplikaci v nastavení účtu tlačítkem
„Verify Master PIN for backups“ nebo jím odemkněte profil. Pokud má server více
domácností s profily, přidejte `--account-id ID`; export obsahuje celý server.
Bez místně ověřeného Master PINu se export odmítne.

Při kontrole a obnově se zadává Master PIN platný v době vytvoření dané zálohy,
se skrytým výpisem, případně přes jednu řádku stdin. Starší zálohy s vlastní frází
zůstávají čitelné. PIN ani frázi nevkládejte do argumentů, URL nebo prostředí.
Offline export nekontaktuje cloud a používá poslední místně ověřený PIN.
Po změně online Master PINu proto nejprve ověřte nový PIN na domácím serveru.

```powershell
node --import tsx apps/server/src/backup/cli.ts export --data-dir "C:/ProgramData/StreamerAI/data" --key-file "C:/ProgramData/StreamerAI/keys/master.key" --output "D:/Backups/streamer-2026-11-04.streamerai-backup"
node --import tsx apps/server/src/backup/cli.ts inspect --input "D:/Backups/streamer-2026-11-04.streamerai-backup"
node --import tsx apps/server/src/backup/cli.ts restore --input "D:/Backups/streamer-2026-11-04.streamerai-backup" --target "C:/ProgramData/StreamerAI-restored" --mode new-server
```

Linuxový příklad:

```sh
node --import tsx apps/server/src/backup/cli.ts export --data-dir /var/lib/streamerai/data --key-file /var/lib/streamerai/keys/master.key --output /mnt/backups/streamer-2026-11-04.streamerai-backup
node --import tsx apps/server/src/backup/cli.ts restore --input /mnt/backups/streamer-2026-11-04.streamerai-backup --target /var/lib/streamerai-restored --mode new-server
```

Export nejprve zobrazí soubory a jejich velikosti, domácnosti, počty profilů a
vynechaný obsah. Obsahuje celou konzistentní SQLite databázi, šifrovaný vault a
master key potřebný k jeho obnově. Z nativního kořene stavu automaticky zahrne
`runtime.env` a `server.env`, pokud existují. Vlastní konfiguraci mimo tento
kořen přidejte například `--config-file .env`. Volitelně lze opakovat
`--media-file SOUBOR`, `--model-file SOUBOR` a `--installer-file SOUBOR`.
Soubory se kvůli záloze nestahují.

Zálohový soubor má autentizovaný verzovaný manifest s SHA-256, délkami a verzí
databáze. Celý obsah včetně názvů souborů a klíče vaultu šifruje AES-256-GCM
náhodným klíčem. Ten je zabalen samostatným AES-256-GCM klíčem odvozeným z fráze
pomocí Argon2id (64 MiB, t=3, p=1; náhodná 16bajtová sůl). Používá se
[implementace Node.js](https://nodejs.org/docs/latest-v24.x/api/crypto.html#cryptoargon2algorithm-parameters-callback).
Bez fráze nelze zálohu obnovit. Fráze ani klíče se nevypisují do výstupu CLI.

Export nevytváří nezašifrovanou kopii databáze na disku: SQLite serializuje
konzistentní obraz do paměti včetně potvrzených WAL stránek. Hotový šifrovaný
soubor před publikováním znovu odemkne a ověří. Existující soubor nikdy nepřepíše.
Atomické publikování používá hard link na stejném disku; cílový filesystem musí
podporovat hard links (například NTFS/ext4). Na FAT/exFAT nejprve vytvořte zálohu
na podporovaném lokálním disku a hotový soubor zkopírujte na USB. Přenos a čtení
z FAT/exFAT omezené nejsou.

Obnova pracuje s **kořenem stavu instalace** obsahujícím `data/`, `keys/` a
`runtime.env`. Původní plochý `data` adresář lze exportovat; jeho přímé přepsání
obnovou není podporováno, obnovte jej do nového kořene stavu. `--mode replace`
zachová serverovou identitu a master key; vyžaduje `--source-retired`, tedy
potvrzení vyřazení původního serveru. `--mode new-server` vytvoří novou identitu,
přegeneruje master key a odstraní párování zařízení. Profily, PIN verifiery,
vazby domácností a přenositelné provider credentials zachová v obou režimech.

Pro přepsání již existujícího **kompatibilního kořene stavu** je potřeba
`--overwrite`. Před přepsáním se ověří a uloží samostatná šifrovaná rollback
záloha; původní adresář se zachová vedle cíle jako `.rollback-…`.
Neznámý/neúplný adresář odmítne. Špatná fráze, poškozený soubor nebo
nepodporované budoucí schéma cílový server nepřepíšou.

Celý soubor se autentizuje před extrakcí, kontrolují se délky, kontrolní součty,
bezpečné přenositelné cesty, integrita SQLite a odemknutí vaultu. Migrace
proběhnou na oddělené kopii. Pracovní adresář má na Linuxu režim 0700 a soubory
0600; na Windows se jeho ACL omezí na aktuálního uživatele, SYSTEM a správce.
Teprve poté se adresáře přepnou; při selhání se vrátí původní. Pro dokončení
vyčištění po násilném ukončení procesu slouží:

```powershell
node --import tsx apps/server/src/backup/cli.ts recover --target "C:/ProgramData/StreamerAI-restored"
```

`recover` odmítne živý proces, ověří cesty žurnálu, při chybějícím cíli vrátí
původní adresář a odstraní nedokončený staging. Na SSD nelze zaručit fyzické
smazání pracovních kopií; pro citlivá data používejte šifrovaný disk.

Po obnově jsou zneplatněné staré browser sessions i cloudové tokeny. Cloud sync
zůstává pozastavený v každé domácnosti, jeho outbox i lokální historie zůstávají
zachované pro kontrolované pozdější navázání. Databáze má značku offline obnovy
pro lokální obnovení přístupu vlastníka. Zdrojové účty se nepřevádějí na jiné
domácnosti. Lokální cesty a důvěru HTTPS klientů je potřeba ověřit na cíli;
credentials poskytovatelů se síťově nekontrolují, některé mohou expirovat.

První formát načítá obsah do paměti a omezuje součet souborů na **256 MiB**.
Obnovený `runtime.env` používá režim `paired` a loopback listener. Správce tak
nejprve lokálně převezme přístup a zvolí obnovenou domácnost; i dříve cloudově
vlastněné profily lze otevřít offline bez nového online přihlášení. LAN origin
a HTTPS je nutné před dalším sdílením znovu ověřit.
Pro velké mediální knihovny a modely je potřeba navazující streamovaný formát.
Cache, logy, binární runtime a privátní CA se automaticky nezálohují. U vlastní
konfigurace jsou obnovené originály pod `extras/` k ruční kontrole; aktivují se
jen známá neprivilegovaná nastavení hostu, portu, logování a inference. Cesty
dat/vaultu/klíče se přepíší na nový cíl. Webový průvodce, plánované zálohy,
retence a automatické mapování médií nejsou součástí tohoto CLI.

Automatické testy pokrývají skutečný SQLite/vault roundtrip více domácností,
PINy, oba režimy identity, rotaci vaultu, stav WAL, neplatné fráze, změnu i
zkrácení souboru, nebezpečné a kolidující cesty, nepodporované schéma, běžící
server, rollback po chybě přepnutí a úklid přerušené obnovy. Testy nejsou
náhradou za ověření instalačních artefaktů a fyzického přenosu mezi OS.
