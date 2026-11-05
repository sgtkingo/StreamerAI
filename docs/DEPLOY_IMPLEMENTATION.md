# Stav implementace distribuce

Aktualizováno 2026-11-05. Cíl popisuje [deploy plán](DEPLOY_PLAN.md).
Změny jsou připravené v pracovním stromu; neprovádějí deployment Workeru,
publikování Pages/Releases ani změnu běžící instalace.

| Oblast | Implementovaný výstup | Co ještě zbývá před stabilním vydáním |
| --- | --- | --- |
| Produkční runtime | Zkompilovaný JS server, workspace balíčky a produkční závislosti; bez pnpm/tsx za běhu, Node 24.7+ | Plná ověřená binární sada gateway/FFmpeg a licence, podpisy a čisté Windows/Linux instalace. |
| Distribuce | Přenositelný balík, kontrola obsahu, prototypy Windows služeb a Linux/systemd, platformní CI | Prototypy služeb nejsou finální podepsané instalátory; viz [packaging](../packaging/README.md). |
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
vyžadována HTTPS adresa; HTTP je přípustné jen na localhostu. Nové nativní
prototypy používají `https://localhost:8443` přes interní CA gateway.

Při prvním startu vznikne v datovém adresáři `installation-bootstrap.key`.
Vlastník jej přečte přímo na hostiteli a zadá do uvítací obrazovky. Klíč se
nepíše do logů a po použití se odstraní. Další zařízení žádá o přístup a vlastník
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
Připravené lokální ZIP soubory s příponou `runtime-prototype` nejsou plné
instalátory a neobsahují chybějící FFmpeg/Caddy/WinSW binární distribuci.
Tato pracovní stanice ověřuje Windows; skutečné Linux/systemd, Docker,
Authenticode a browser/TV acceptance jsou samostatné kroky.

Ověření tohoto kroku: server 430 testů + samostatný test offline přístupu po
obnově, web 388, cloud 66, databáze 18, kontrakty 32 a distribuce 10; celkem
945 úspěšných testů. Dalších 13 integračních testů vyžaduje skutečný FFmpeg
nebo Ollama runtime a zůstává vypnutých. Typecheck všech workspace balíčků,
ESLint a formát změněných souborů prošly. Celorepozitářový formát obsahuje
starší neshody v nesouvisejících souborech; `docs/TODO.md` má také již existující
trailing whitespace. Tyto poznámky a nesouvisející implementaci tento krok nepřepisuje.

Produkční web byl kvůli zamčenému staršímu `apps/web/dist/sw.js` sestaven
do nového `dist/deploy-review-web` a balík dostal tuto explicitní cestu přes
`--web-directory`. Nebyl ověřen v interaktivním prohlížeči: v této relaci není
dostupný browser execution nástroj; chování UI ověřují komponentové testy.
