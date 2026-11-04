# Plán komunitní databáze zdrojů

Stav návrhu: 3. 11. 2026. Cílem je využít hodnocení správnosti zdrojů k
rychlejšímu a spolehlivějšímu párování titulů mezi instalacemi Streameru.
Komunitní databáze zatím není implementovaná. Návrh počítá s postupným
zavedením a ověřením na malé skupině uživatelů.

## Co existuje dnes

- Uživatel může dát palec nahoru nebo dolů konkrétnímu přiřazení souboru k filmu
  nebo epizodě. Každý profil má vlastní hlas; počty se zobrazují profilům
  téhož účtu a skóre ovlivňuje pořadí jeho zdrojů.
- Hlas je určen identitou profilu, titulu, poskytovatele a kandidáta a případně
  číslem série a epizody. Cloud Sync tyto údaje přenáší jako soukromý stav
  účtu. Přenos neobsahuje přímé odkazy na přehrávání.
- Vypnutí Source correctness feedback je nastavení konkrétního profilu:
  palce skryje, nové hlasy odmítne a uložené hlasy v jeho řazení ignoruje.
- Mezi účty se hlasy nesdílejí, žádný komunitní dotaz ani komunitní skóre dnes
  neexistuje. Současný Cloud Sync sám o sobě není souhlasem uživatele se
  zveřejněním nebo komunitním využitím historie hodnocení.

Detaily současného chování jsou v [ACCOUNTS.md](ACCOUNTS.md) a datový kontrakt
v [source-feedback.ts](../packages/contracts/src/source-feedback.ts).

## Cílové chování

Streamer se při hledání zdrojů může zeptat komunitní služby na známá přiřazení
pro titul, případně konkrétní epizodu a poskytovatele. Odpověď obsahuje jen
identifikátory a agregované hodnocení potřebné k nalezení kandidátů. Místní
konektor pak kandidáta samostatně dohledá a ověří u poskytovatele s vlastním
přihlášením uživatele.

Komunitní záznam je nápověda, nikoli důkaz dostupnosti nebo přehratelnosti.
Pokud komunita záznam nemá, označí jej záporně, služba je nedostupná nebo
identifikátor přestal platit, Streamer pokračuje vlastním hledáním. Tím může
objevit i zdroj, který komunita dosud nezná. Přehrávání stále vyžaduje místní
kontroly a čerstvé přehrávací oprávnění.

## Jak využít palce

1. **V rámci účtu:** zachovat současné individuální hlasy profilů, lokální
   součty a možnost hlas přepnout nebo odebrat.
2. **Příspěvek účtu:** pro komunitní agregaci předběžně započíst nejvýše jeden
   hlas účtu pro dané přiřazení, aby více profilů jedné domácnosti automaticky
   neznamenalo více nezávislých hlasů. Pokud si profily odporují, navrhuje se
   účet nezapočítat až do vyřešení rozporu. Toto pravidlo je rozhodnutí k
   potvrzení před pilotem, nikoli stávající chování.
3. **Komunitní hodnocení:** uchovávat počty kladných a záporných příspěvků a
   jejich stáří; rozlišovat „žádné údaje“ od negativního hodnocení. Pořadí
   navrhnout tak, aby zohledňovalo počet nezávislých účtů a míru nejistoty:
   jeden palec nesmí mít stejnou vypovídací hodnotu jako mnoho shodných hlasů.
   Konkrétní výpočet a prahy nejdřív ověřit na testovacích datech.
4. **Přednost vlastního účtu:** vlastní hodnocení a ruční výběr uživatele musí
   zůstat srozumitelné a mít přednost před komunitní nápovědou. Komunitní
   hodnocení se nesmí vydávat za osobní hlas ani bez vysvětlení změnit jeho
   barvu. Způsob zobrazení komunitních počtů nebo míry důvěry vyřešit až po
   ověření pilotu; současná malá čísla představují pouze účetní součty.
5. **Oprava hlasu:** změna nebo odebrání hlasu musí změnit i příspěvek účtu;
   při opětovné synchronizaci se nesmí obnovit staré hodnocení. Vypnutí
   stávajících palců pro jeden profil je oddělené od nastavení sdílení účtu.

Palec posuzuje správnost přiřazení titulu nebo epizody, nikoli kvalitu videa,
jazyk, funkčnost účtu u poskytovatele ani aktuální dostupnost souboru.

## Co může komunitní služba ukládat

Navržená minimální identita záznamu:

- kanonický identifikátor titulu a podle potřeby číslo série a epizody;
- identifikátor poskytovatele a **ověřeně sdílitelný** identifikátor kandidáta;
- agregované počty a čas aktualizace, případně verzi formátu identifikátoru;
- interní informaci potřebnou pro odebrání nebo přepočet příspěvku účtu, bez
  zveřejnění identity hlasujících ostatním uživatelům.

Nepřenášet přímé přehrávací odkazy, tokeny, hesla, cesty k lokálním souborům,
obsah médií ani názvy profilů. Identifikátor kandidáta není automaticky
bezpečný jen proto, že nejde o URL: u každého konektoru se musí ověřit jeho
stabilita, globální použitelnost, citlivost a možnost opětovného dohledání.
Například identifikátory lokálních souborů mohou být vázané na instalaci;
`local-files` do sdílení nezařazovat bez samostatně navržené bezpečné identity.
Pokud poskytovatel nemá vhodný identifikátor, konektor se do komunitní výměny
nezapojí. Ověřit také pravidla a oprávnění pro zamýšlené použití údajů
jednotlivých poskytovatelů.

Pseudonymizace není anonymita: přiřazení titulu a hlasu může vypovídat o
zájmech uživatele. Před pilotem určit účel, dobu uchování, ochranu malých
součtů, přístup správce a postup výmazu včetně odvozených agregátů.

## Souhlas a ovládání

- Před prvním odesláním přidat samostatnou, srozumitelnou volbu účtu pro
  komunitní přispívání. Popsat přenášené údaje, jejich účel, jak se projevuje
  vypnutí a jak lze příspěvky odstranit. Předběžně navrhujeme **výchozí stav
  vypnuto**; stávající per-profile přepínač palců nemění význam.
- Samostatně rozhodnout, zda bude možné komunitní výsledky pouze číst bez
  přispívání, a jak tuto volbu zobrazit. Zohlednit, že i samotný dotaz může
  prozradit hledaný titul. Přenos používat pouze podle zvolené preference.
- Historické hlasy zpětně nepublikovat automaticky. Nabídnout jejich případné
  jednorázové zahrnutí až po výslovné volbě a jasném vysvětlení.
- Při odvolání souhlasu zastavit nové příspěvky a nabídnout odstranění dříve
  odeslaných příspěvků včetně přepočtu agregátů. Navrhnout zpracování
  offline zařízení, fronty, opakovaných požadavků a výmazu účtu.

## Topologie a první doporučená varianta

Pro první pilot navrhujeme **centrální službu** s jednoduchým verzovaným API a
odděleným komunitním úložištěm. Stávající Cloudflare Worker a D1 jsou možným
základem, protože již řeší účty a synchronizaci; vhodnost pro očekávaný objem,
limity, provozní náklady a oddělení soukromých dat je ale potřeba změřit.
Neznamená to automatický přístup komunity k existujícím záznamům Cloud Syncu.

Centrální bod usnadní připojení klientů, aktualizaci agregátů a odebrání
příspěvků. Zároveň vytváří závislost na provozovateli a vyžaduje ochranu proti
zneužití, pravidla provozu a plán výpadku. Komunitní dotazy nesmí blokovat
vlastní vyhledávání ani přehrávání.

P2P/torrent nebo blockchain nyní neimplementovat. P2P by navíc vyžadovalo
objevování uzlů, řešení nedostupnosti a otravy dat, správu identity a složitý
výmaz kopií; blockchain činí opravu a odstranění dat zvlášť obtížnými. Tyto
varianty lze znovu vyhodnotit po pilotu, pokud centrální služba přestane
vyhovovat. Veřejný protokol a konektor služby navrhnout odděleně od UI a
vyhledávací logiky, aby šla topologie později změnit.

## Postup zavedení

### 1. Ověřit identitu a datový model

- Zmapovat poskytovatele: jak vzniká `candidateId`, zda je stabilní mezi účty a
  instalacemi, zda jej lze dohledat bez přímého odkazu a jak se řeší změna ID.
- Navrhnout verzi identity zdroje, filmů, epizod a konfliktních přiřazení;
  stanovit pravidla pro expirované nebo odstraněné zdroje.
- Na testovacích datech ověřit agregaci profilů na účet, změny a odebrání
  hlasů, konflikt dvou profilů a oddělení dat různých účtů.
- Dodat návrh souhlasu, výmazu a ošetření citlivých dotazů. Žádná reálná
  uživatelská historie se v této etapě komunitně neposílá.

**Výstup:** schválený kontrakt a seznam poskytovatelů vhodných pro pilot.

### 2. Soukromý pilot sběru

- Implementovat opt-in účtu, oddělený příspěvkový kanál, odvolání souhlasu a
  odstranění příspěvků. Navrhnout frontu a idempotentní synchronizaci včetně
  změny hlasu a offline zařízení. Nezaměňovat ji s běžným Cloud Syncem.
- Na omezené skupině měřit úplnost a stabilitu identifikátorů a konzistenci
  agregací. Testovat opakované doručení, více instalací jednoho účtu,
  výpadky, změnu hlasu, výmaz a pokusy o manipulaci.
- Výsledky zatím nepoužívat k řazení ani výběru zdrojů. Ověřit, že žádosti o
  přímé linky, lokální cesty a další nepovolené údaje nejsou součástí payloadu.

**Výstup:** ověřený sběr a možnost smazání bez vlivu na existující vyhledávání.

### 3. Stínové dotazy a měření

- Při povoleném použití komunity zkusit omezený dotaz pro titul a poskytovatele;
  navržené kandidáty ověřit lokálním konektorem. Současně zachovat běžné
  vyhledávání i při záporné nebo prázdné komunitní odpovědi.
- Ve stínovém režimu porovnat návrhy komunity se stávajícím výsledkem, aniž by
  měnily pořadí zobrazení nebo automatický výběr. Měřit úspěšnost dohledání,
  zastaralost ID, chybné shody, latenci a dodatečné dotazy poskytovatelům.
- Ověřit timeout, limity, cache, výpadek služby a případy, kdy je komunitní
  informace nesprávná nebo zastaralá. Určit vlastníky měření a hranice pro
  přechod do další etapy; nesbírat zbytečnou historii dotazů.

**Výstup:** srovnání přínosu a chybovosti oproti současnému vyhledávání.

### 4. Omezené použití při řazení

- Teprve po vyhodnocení pilotu a nastavení prahů použít komunitní skóre jako
  další vysvětlitelný signál pro řazení místně ověřených kandidátů.
- Zachovat přednost ručního výběru a vlastního hodnocení; negativní komunita
  ani absence záznamu nikdy nesmí zabránit místnímu hledání prvního objevu.
- Prověřit manipulaci hlasy, účty vytvořené pro ovlivnění skóre, opakované
  hlasy jedné domácnosti a náhlé změny hodnocení. Jeden hlas na účet sám o
  sobě nezaručuje nezávislost účtů.
- Umožnit funkci komunitního řazení rychle vypnout bez dopadu na lokální
  palce, knihovnu, přehrávání nebo soukromý Cloud Sync.

**Výstup:** omezené nasazení s měřitelným přínosem a možností návratu k
dosavadnímu řazení. Automatické přijímání komunitních výsledků bez místního
ověření není součástí této etapy.

## Odhad zásahu a otevřená rozhodnutí

| Oblast | Předběžný zásah | Důvod |
| --- | --- | --- |
| Současné palce a účty | Střední | Souhlas, změny a odvolání příspěvků, agregace profilů na účet. |
| Konektory zdrojů | Střední až vysoký | Stabilita a dohledatelnost identifikátorů se liší podle poskytovatele. |
| Cloud a databáze | Vysoký | Nové oddělené úložiště, agregace, škálování, limity, výmaz a obrana proti zneužití. |
| Vyhledávání a řazení | Střední až vysoký | Timeouty, lokální ověření, fallback, měření chyb a zachování ruční volby. |
| Nastavení a UI | Střední | Jasný souhlas, oddělení osobních a komunitních údajů, případné zobrazení důvěry. |
| P2P varianta | Vysoký až velmi vysoký | Objevování uzlů, replikační protokol, integrita a výmaz distribuovaných dat. |

Časový odhad zatím není spolehlivý: závisí především na identifikátorech a
omezeních poskytovatelů, výsledku pilotu, požadované ochraně soukromí a počtu
podporovaných konektorů. Nejprve dokončit etapu 1 a podle jejích výsledků
odhadnout konkrétní implementaci.

Před pilotem rozhodnout zejména:

1. Souhlas s přispíváním a případným zpětným využitím starých hlasů; samostatná
   volba pro čtení komunitních výsledků.
2. Přesné pravidlo pro protichůdné hlasy profilů a pro jeden příspěvek účtu.
3. Kteří poskytovatelé a které identifikátory jsou vhodní ke sdílení.
4. Minimální počet příspěvků pro zveřejnění počtu a pro vliv na řazení,
   pravidla expirace, správy zneužití a výmazu.
5. Provozovatele služby, oddělení od účtového syncu, limity a financování.
