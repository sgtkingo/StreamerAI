# Stav implementace distribuce

Aktualizováno 2026-11-07. Cíl popisuje [deploy plán](DEPLOY_PLAN.md).
Změny jsou připravené v pracovním stromu; neprovádějí deployment Workeru,
publikování Pages/Releases ani změnu běžící instalace.

Upřesněný produktový cíl: server se dodává jako aplikace s jednoduchým
instalátorem, který připraví závislosti, služby, lokální přístup a nabídne
instalaci chybějící Ollamy/modelu. Archiv runtime je podklad pro sestavení
instalátoru, nikoli cílový postup pro běžného uživatele. Klientem je nyní jen
webový prohlížeč; instalace PWA nebo desktopového klienta není podmínkou.

| Oblast | Implementovaný výstup | Co ještě zbývá před stabilním vydáním |
| --- | --- | --- |
| Produkční runtime | Zkompilovaný JS server a web, produkční závislosti, Node 24.22.2 LTS, ověřené Caddy/FFmpeg/WinSW; bez pnpm/tsx za běhu. Windows sestavení ověřuje také skutečný Node ABI 137 a SQLite binding. | Veřejná distribuce FFmpeg vyžaduje dokončení kontroly licence a odpovídajících zdrojů; podpisy a čisté instalace zůstávají podmínkou vydání. |
| Distribuce | Skutečný grafický Windows `setup.exe` s vloženým úplným serverem, službami, lokálním HTTPS, zástupci a předáním vlastníka do prohlížeče. Linux má builder `.deb`, GTK průvodce a omezený systémový helper; ruční CI sestavuje obě platformy. | Windows je nepodepsaný Preview. Linuxový `.deb` se na této Windows stanici nesestavoval ani neinstaloval; viz [Windows](../packaging/setup/README.md) a [Linux](../packaging/setup/linux/README.md). |
| Lokální AI | Průvodce zjistí existující Ollamu a modely, nabídne chybějící runtime a doporučený model, zobrazí velikost a průběh. Stahuje jen po výběru uživatele, kontroluje pinned runtime a zachovává existující konfiguraci. Nastavení serveru umí nabídnout a sledovat stažení modelu. | Skutečná instalace Ollamy, ověření GPU a běh bez přihlášeného uživatele vyžadují acceptance na cílovém systému. Ovladače GPU se automaticky neinstalují. |
| Aktualizace serveru | Podepsaná metadata, prahové ověření Ed25519, expirace, platforma a ochrana proti replayi; staging | Supervizor s koordinací zálohy, nečinnosti, migrace a rollbacku; automatická aktivace není hotová. Nejde o plnou implementaci TUF. |
| Přístup zařízení | Volitelný režim `paired`, jednorázové převzetí správce, kód, schválení, cookie, odvolání, uzavření streamu | LAN HTTPS a CA bootstrap na skutečných klientech; mDNS, úplná rotace session a samostatné ověření bezpečnosti. |
| Offline server backup | Šifrovaný soubor, kontrola, obnova obou režimů identity a zotavení po přerušené obnově | Zatím CLI na zastaveném serveru a limit 256 MiB; grafický průvodce a velké streamované archivy. Viz [návod](OFFLINE_BACKUP.md). |
| Šifrovaná domácnost | UI/API aktivace, náhled, export/import a výměna recovery klíče; profily a povolené credentials | V1 má explicitní omezení; průběžné slučování více serverů a schválení přes `/account` nejsou dokončené. Viz [formát a rozsah](ENCRYPTED_HOUSEHOLD.md). |
| Cloud checkpoint | Oddělený opaque endpoint s vlastníkem a porovnáním revizí | Migrace `0009` a ověřené nasazení nové verze Workeru; žádná změna dosavadního cloudového účtu v tomto kroku. |
| Podpora | Náhled allowlist diagnostiky, offline soubor, předvyplněný GitHub Issue a Issue Forms | Soukromý bezpečnostní kontakt a triáž před veřejným vydáním; žádná automatická telemetrie. |
| Web | Lokální statický web v `site/`, manuální Pages workflow pro `sgtkingo/StreamerAI` | Publikování a ověření hostingu; download odkaz vede na skutečná Releases, nikoli na neexistující instalátory. |
| PWA | Nabídka aktivace, kontrola přehrávání a neuložených změn mezi spolupracujícími kartami | Přechod ze starého `autoUpdate` workeru a reálné prohlížečové acceptance. |

## Volitelné schvalování zařízení

Dosavadní výchozí nastavení zůstává `STREAMERAI_ACCESS_MODE=trusted-local`.
Aktivní instalace se nepřepíná. Pro kontrolovaný test na nové instalaci nastavte
`STREAMERAI_ACCESS_MODE=paired` a správný `STREAMERAI_WEB_ORIGIN`. Pro LAN je
vyžadována HTTPS adresa; HTTP je přípustné jen na localhostu. Nové instalátory
používají `https://localhost:8443` přes interní CA gateway a režim `paired`.
Existující explicitní nastavení při obnově respektují; běžící instalaci nemění.

Při prvním startu vznikne v datovém adresáři `installation-bootstrap.key`.
Instalátor předá jednorázové převzetí správce přímo do prohlížeče; fragment
`#setup` se před odesláním odstraní z adresy a klíč se neukládá do prohlížeče.
Při ručním nasazení lze klíč přečíst na hostiteli a zadat do uvítací obrazovky.
Klíč se nepíše do logů a po použití se odstraní. Další zařízení žádá o přístup a vlastník
v Nastavení opíše jeho osmiznakový kód. V Nastavení lze jeho přístup odvolat.
Cloudové přihlášení a oprávnění domácnosti zůstávají další vrstvou.

Párovací cookie má maximální platnost 90 dní a 30 dní neaktivity. Obnovu
ztraceného či expirovaného owner přístupu lze připravit místním nástrojem na
zastaveném serveru:

```sh
node apps/server/dist/installation-recovery.js --reset-owner --data-dir /absolute/server/data
```

Nástroj se v tomto kroku nespouští na uživatelských datech. Při ručním spuštění
odvolá relace zařízení a vytvoří nový setup klíč; profily a vault zachová.
V režimu `paired` zatím není zpřístupněný současný interní MCP/CLI bridge:
nepřidáváme výjimku obcházející schválení zařízení. V dosavadním režimu se jeho
chování nemění. Řízené propojení vyžaduje samostatné bezpečnostní posouzení.

## Praktická obnova a přenos

Úplný offline soubor vytváří `apps/server/src/backup/cli.ts`, v distribuovaném
balíčku `backup.mjs`. Obnova je dostupná bez internetu a bez původního serveru;
vyžaduje předem dostupný runtime, soubor a jeho frázi. Kvůli konzistentnosti je
nutné službu zastavit. Obnova nového serveru odstraňuje staré párování a obnovuje
credentials pod novým lokálním klíčem. Obnova náhrady původního serveru zachová
identitu, ale revokuje staré account/cloud session. Synchronizace zůstane
pozastavená, dokud se nevyřeší vlastnictví a případné novější změny.

Menší šifrovaný export domácnosti se ovládá v Nastavení schváleného vlastníka;
při prvním onboardingu je dostupný i náhled/import. Legacy plaintextový sync
se po aktivaci nepoužívá. Vlastník musí uložit recovery klíč odděleně od souboru.
Žádné uživatelské údaje se bez výslovné akce neodesílají do cloudu.

## Distribuční artefakty a ověření

Způsob sestavení a podepsaného stagingu uvádí [packaging README](../packaging/README.md).
Finální lokální Windows kandidát je v `dist/installers/`, včetně SHA-256 a
`setup-build.json`. Obsahuje Node, SQLite, web, server, FFmpeg, Caddy a WinSW;
Ollama a model jsou samostatné volitelné downloady. Staré runtime prototypy,
pracovní sestavení a cache se po dokončení odstraní. Zdrojové kódy a data zůstávají.

Windows setup ověřují testy skutečné kompilace, vloženého archivu, odmítnutí
pozměněného obsahu, neinstalačního vykreslení průvodce a PowerShell syntaxe/dry-run.
Linux helper a balíček mají testy sestavení stromu a bezpečných pevných operací.
Serverové testy zahrnují vlastnická oprávnění lokálního AI nastavení; webové testy
zahrnují nabídku modelu a jednorázové předání správce v React StrictMode.
Ověření: server 439, web 393, cloud 66, databáze 18, kontrakty 32 a distribuce 28;
celkem 976 úspěšných testů. Typecheck workspace balíčků, ESLint a kontrola formátu
prošly. Přímo v přibaleném Node 24.22.2 / ABI 137 prošlo také vytvoření produkční
aplikace se SQLite, šifrovaným úložištěm, převzetím správce a kontrolou souhlasu
pro stažení modelu, bez síťového stahování a bez instalace služeb.

Původní Windows Preview bylo na této stanici spuštěno a zanechalo běžící službu
serveru a zastavenou gateway. Caddy nedokázal načíst neuzavřenou cestu
`C:\Program Files` v Caddyfile. Nový instalační EXE obsahuje opravený konfigurační
soubor a při opakování rozpracované instalace ověřuje otisk původního souboru,
opravuje jen definici gateway a spouští ji. Opravený soubor prošel validací
instalovaným Caddy a nový EXE self-testem; skutečné dokončení instalace čeká na
opětovné spuštění průvodce s potvrzením Windows UAC. Linux/systemd, Authenticode
a instalace, restart i odinstalace na čistých Windows/Linux systémech jsou
samostatné podmínky veřejného vydání.
Windows a Linux průvodci nyní používají červenobílou značku aplikace a samostatné
obrazovky s výsledkem, čitelným popisem, strojovým kódem a akcí pro opakování.
Windows EXE má vloženou vícerozměrnou ikonu; náhledy voleb, úspěchu a chyby lze
vykreslit bez instalace.
13 integračních testů vyžaduje skutečný FFmpeg nebo Ollama runtime a zůstává
vypnutých. Chování webu ověřují komponentové testy; v této relaci není dostupný
nástroj pro interaktivní browser acceptance. Grafický Windows průvodce lze
bez instalace vykreslit příkazem `--preview-image` a jeho výstup se kontroluje
vizuálně. Žádná služba na pracovní stanici se tím nespouští.
