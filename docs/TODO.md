DONE: Profil ikona nic nedelá - měla by se objevit nabídka s: nastavení, preference, můj účet, statistiky a logout / změnit účet. Zatím tyto stránky drž jako plaehldery s komentářem. 
-- Nastavení: Umožnuje nastavit preferovaný jazyk, titulky, zvuk (zvukový výstup), přehrávač, a integrace (API, odhlášení, změny údajů). Pro každou položku vytvoř subsekci. Zde dej také nastavení výběru primárního a sekundárního jazyka pro přehrávání (subpoložka nastavení): např. primární Čeština (CZ), sekundární Angličtina (ENG), checkbox zda automaticky hledat titulky - pokud ano, pak možnost volit preferovaný jazyk pro priární a sekundární audio kanál, defaultně pro primární audio titulky Off, pro sekundární nastavit jazyk titulku stejný jako je primáírní audio. Tyto preference dej i do onboardingu. Umoni v hlavním nastaení znovu vynoceně spustit onboarding pomocí tlačítka. 
-- Preference: Uživatelské preference jako seznam kategorií a virtuální profil v podobě promptu který lze přepsat. Tento prompt by měl popisovat co má uživatel rád. 
-- Můj účet: Změna loginu, hesla, profil foto 
-- Statistiky: Kolik filmů, kolik hodin, nejoblíbenější atd
-- Logout/Změnit účet: Zpět na hlavní stránku přihlášení a odhlášení uživatele. Hlavní stránka by měla obsahovat 5 medailonků profilů. Pro přeínání profilu musíš appku přizpůsobit. 

DONE: V návaznosti na úpravu dláždic to by se mělo u dláždic vypsat jaký je dostupný jazyk, s tím že: 
- Primární a Sekundární jazyk má uživatel určen, viz Settings -> "Playback languages"
- Pokud není nalezena ani jedna varianta lokalizace audia, objeví se dostupný jediný jazyk (pokud nemá tiulky tak s vykřičníkem)
- Příklad:
  - Film je v CZ i ENG s titulky, UI : CZ, ENG (sub)
  - Film je jen ENG, ale s titulky, UI: ENG (sub)
  - Film je  v ENG bez titulku, UI: ENG
  - Film je jen v japonštině, ale má sub, UI: JAP (sub)
  - Film je jen japonsky, bez titulku, UI: JAP (!)

DONE: UI fix: Při kliknutí na "Find something" by se měl vyvolat efekt kdy buttonem projede odlesk ve tvaru šipky, a prohlížeč udělat scrolldown na výsledek. Při najetí myší na button by měl svítit všemi barvami, do měkka a ztracena. Znak šipky z vyhledávacího tlačítka odstraň a nahrad ho znakem ENTER. Při hledání se tlačítko změní ikonu na "stop" v kolečku, text "Find something" zmizí a tlačítko plynule přizpůsobí velikost jen ikoně stop, při klknutí na stop se proces vyhledávání zastaví a tlačítko se stejným plynulým způsobem  vrátí do výchozího stavu. U vyhledávácío procesu by měla u každého kroku běžet mini animace ať uživatel vidí že běží. Klidně tam vlož mezi jednotlivé kroky krátké pauzy at se efekty projeví a uživatel má dojem že to "plynule funguje". 

DONE: UI fix: Chyby a hlášení by se měli projevit jako plovoucí bubliny s překrytím na horní straně obrazovky, uprostřed. Kliknutí a položku v horním menubaru by mělo vyvolat efekt scrolldown, ne skok .Při najetí myší na dláždici by mělo UI vyvolat efekt mírné zvětšení dláždice + krátký zvuk "tik"

DONE: UI a workflow fix: Při iniciaci lokálního agenta by toto mělo být zaznamenáno a uživatel by na to měl být upozorněn nějakou vtipnout hláškou "Ouč, agent usl, musím ho vzbudit, počekej chvíli..."

DONE: Aktuálně každý nový vyhledávací dotaz tvoří další položku v gobální chat relaci - mělo by to fungovat tak, že vyhledávání vždy vyvolá novou relaci. V aktuálně živé relaci by měl být možný chat se StreamerAI, za učelem diskuze nad výsledky, chat by se měl vždy doptat uživatele zda je to to, co si představoval a uživatel mu může odpovědět. Pokud uživatel bude mít námitky, agent upraví zadaní a pokusí se vyhledat něco co lépe odpovídá - v rámci relace. Tento chat dej jako plovoucí bublinu do spodní části obrazovky, která neinvazivně překrývá obsah a uživatel si ho může prohlížet. Po novém hledání by měla stránka vždy rolovat na "A considered shortlist"

DONE, přes tři tečky: Multisource vyhledávání a catching: Aktuálně vyhledávač hledá vždý jen jeden stream jako nejlepšího kandidáta - a z něj zjišťuje a páruje audio/titulky/formát obrazu atd. To je v pořádku. Ovšem, stream server může obsahovat více zdrojů - například v jiném jazyce, jiný obraz, jiné titulky. Je možné vytáhnout všechny tyto zdroje - bez duplicit, best candidates - a vytvořit znich entitu filmu která se předá dláždici i přehrávači? Tzn, uživatel uvídí že film má možnosti CZ, ENG, CZ (sub), 1080p, 4k, 720p ale ve skutečnosti to budou tři různé zdroje agregované do jedné entity? Přehrávač by měl samozřejmě také agregovat, a nabídnout výběr jazyky, subtitles - samozřejmě pokud je to třeba ENG jiný zdroj než CZE, musí se zdroj přepnout,reloadnout a pokračovat kde skončil předchozí. Zde vidím hlavní problém v tom, že různé zdroje mohou mít různou kvalitu. To by bylo vhodné nějak uživatelsky ošetřit, třeba přidat v přehrávači další ovládací prvek Quality (jako Subtitles a Audio) kde se uživatel může podívat a přenout kvalitu (1080p, 4k apod) dle dostpných zdrojů. Ano, uvědomuji si že zdroj - audio a titles bývají svázané,  to také zůstanou, jdde jen o agregaci a větší výběr pro uživtele. Možný by bylo vhodné jednolivé zdroje v rámci UI nějak baevně oddělit at je jasné že tato zvuk stopa patří k jinému zdroji, nebo, možná jednodušší řešení - u dláždice přidat "tři vertikální tečky" které nabídnou další alt zdroje
 a přehrávač nebude agregovat, bude přehrávat pouze ten jeden vybran uživatelem. Také bychom mohli zavést catchning už nalezeých záznamů a linků, aby je mohla appka znovu použít. Prozatím chci jen analýzu proveditelnosti a aktuální stav připravenosti.

DONE: Pojdme udělat two-stream vyhledání: rychlé a hluboké. 
Rychlé: Aplikace hledá pomcí API search a similarity, vybírá statisticky nelepího kandidáta. Žádná AI, okamžitý výsledek. Tohle uživateli ukážeme jako první výsledky ale zároven paralerně poběží hluboké hledání s porozumněním. 
Hluboké: Aktuální AI agent based vyhledáváním s kontextem a pozorumněním. Běží paralerně a obohatí výsledky o své nálezy. 
Duplicity nezobrazuj dvakrát, uživatel bude moct kliknout na tlačítko "Stop" aby zastavil hluboké hledání. 
Př dohledávání pomocí agenta a používání fůze "co našel agent a co databáze" zkus nastavit similarity práh trošku benevoletněji, at to najde více streamů. Toto nastavení se pak mělo objevit i jako uživatelské a jít s měnit. 

- Při najetí myší na dláždici by mohlo UI po dvou vteřinách začít odpočítávat zmenšujícím se symetrickým centrálním barem spuštění ukázky přímo v dláždici, defaultně mutnuté.

- UI bude defaultně měnit hlavní téma dle sezony (jaro, léto, podzim, zima, Vánoce, Silvestr), včetně decetního živého pozadí, třeba padání rozmazaných barevných listů v pozadí. Téma by se také mělo měnit dle počasí (třeba déšť vyvolá kapky šplíchající na pozadí, rozmazanou mlhu) a denní doby - den/noc. Výsledné téma by tedy měla být fůze sezony, počasí a denní doby. Zamysli se nad implementací, napojení na veřejné počasí a zjištění lokálního času (přidej nastavení času do Settings, včetně tmezony a checkboxu "Autodekce").  Téma zasahne i stránku výběru profilu s medailonky. Uživvatel tohle bude moct změnit v nastavení "Theme" (roletka) a také na horním panelu, vedle profile medailonek. Další téma může být Cinemaic, což bude odpovídat aktuálnímu black/white/red. 

DONE: Seriály by měli mít po kliknuí detail a rozdělení do sérií a episod. Seriály by měli mít hloukové vyhledávání na pozadí, které přidá další episody, do té doby by měli svítit žlutě a psát "• searching..." - ale pokud užjsou první díly nalezeny, musí jít i tak přehrát. Aby bylo chování sjednoceno, filmy by měli také po kliknutí ukázat detail, jen nebude ukazovat rozdělení na série, ale bude místo toho napovídat třeba další podobné filmy, či pokud existují tak další díly ságy.

- DONE: přehrávač by měl dostat šipky "Next" a "Preview" které dovolí u sérií přehrát další, či předchozí díl.  

- DONE: Proč vyhledávání "Naruto" nic nenajde, když na TMDB i Websharu je? 

- DONE:  Pokud uživatel zadá např. "Něco co jsem neviděl" tak by si agent měl zažádat o seznam filmů které už uživatel viděl a vyhnout se jim. Pokud je konktextové okno malé, komprimovat. Má agent SOUL.md, SKILLS, MEMORY.md apod? 

- DONE: Připrav architekturu tak, aby bylo možné přidávat libovolné konektory zdrojů pro DB, streamy i titulky. Musíme mít pevně daný univerzální konktrakt na straně Streamer AI, který se bude přes adaptéry párovat na konkterétní zdroj. Takový adapter musí být dokonale zdokumentován a navržen čistě, aby mohla komunikata tvořit své vlastní a mergovat. Uzpůsob také workflow dohledávání a vyhledávání tak aby uměl pracovat z multi-source zdroji, a vybírál tedy z více zdrojů to nejlepší + stavěl alternativní streamy ze všeho co má k dispozici. Na to také navážeme malým UI prvkem - mimiaturní ikonou umístěnou v pravém horním rohu dláždice - v sekci s popisem, která bude symbolizovat původ zdroje - v případěš že jich bude více, tak se ikony budou překrývat za sebou s malým offsetem doleva, ale max 3 ikony zdrojů, pak do ztracena. Ikona zdroje by měla být i v rámci výběru zdroje přes tři tečky - u každého zdroje zvlášt v seznamu. Vizuál ikony získej z loga služby nebo jej vygeneruj, ikona by měla být jako soubor v repu který se načte. V návaznosti na to připrav PLACEHOLDERY na několik nových integrací, a uprav také onboarding a Settings tak aby je bylo možné vybrat:
Pro DB:
-- https://www.csfd.cz/ (ČSFD)

Pro streamy:
-- Lokální složka / disk 
-- FTP / FTPs
-- NAS připojení 

Pro titulky:
-- https://www.opensubtitles.org/ (opensubtitles)
-- https://www.titulky.com/ (Titulky.com)



- DONE: Měli bychom uživatelům umožnit stahovat obsah do své offline knihovny. Tuto knihovnu implementuj jako součást integrace Local folder or drive: tzn součást tohoto tasku je i  obecna integrace konektoru Local folder or drive. Tento konektor by měl umožnovat připojit více složek / disků, které bude rekurzivně async prohledávat a obohacovat Library. Nastavení by mělo sočívat v přidání / odebírání složek, a filtraci dle formátů (třeba mkv, avi, mp4, defaultně vše on). 

- DONE: Po zavření přehrávače se někdy možnost skrolování zasekne.  Černé pozadí pod křížkem Close v kartě by měl začínát více v roku, at jde plynule z úplně černé. Zelený symbol stažení by u dláždice měl být bez fajfky - prostě původní download ikona ale jen zelená, v kartě ji nech tak. Po dokončení stahování titulu by se ikona měla změnit na červený trash a další kliknutím by měl být titul smazán (po potvrzení uživatelem). 

- DONE:U nastavení 06 / Agent adapters - AI agent chce uživatel jasně vidět název modelu na který je napojen - dej ho do vniřního bloku který se týká agenta (místo "Local AI"). "Local AI
On-device recommendations and interpretation." je rudundatní informace. Tlačítko "Check local agent" přsun do bloku s agentem, a přejmenuj ho na "Check agent a dej mu ikonu terčíku se středem". Místo tlačítka "Check local agent" dej na jeho místo tlačítko "Discover local agents" které spustí explicití hledání dalších agentů, ikona radaru. V Add-more nepiš "All listed services in this group are already added." ale spíše "Sorry, no more agents found." - barvu světle šedá. Save settings by měl zároven zavřít celé settings.

- DONE: UI vylepěšení: StreamerAI search chat by měl mít otevřené zadávání pro rychlou odpověď, tzn input box kde může hned uživatel napsat co by chtěl jinak. Tento input se vloží do chatu a vyvolá agenta, ale UI chat neotevře, aby nerušil focus uživatele (chat otevřít půjde pouze ručně uživatelem, kliknutím na hlavní tělo). Udělej rámeček chatboty asymetrický a obly, aby se dole rozšířil pro větší prostor na "fast reply" field. Při přemýšlení se bude ikona hvězdy v zavřeném okně agenta protočívat. "fast reply" field by měl lehce zářit narůžovělu duhou ve vizuálu agenta, by na sebe upozonil. 

- DONE: Bot se chová zvláštně, při hledání "complete sci-fi series " nic nenajde (ani opakovaně) ale pokud mu řeknu "try again" nebo "why?" tak už ano. Není v prvním hledání nějaký blok? Špatný systém prompt? Došlu totiž k integraci skillu "najdi něco co jsem neviděl", nesouvisí to? Velmi často ted dostávám "
I found some ideas, but none could be validated reliably. Is this what you had in mind? Tell me what to change." Dokáže bot použít web-search?  

- DONE: Každý profil by měl mít oddělené data, i v rámci onboardingu - hlavně api konektory.

- Měli bychom vylepšit catchování 

- DONE: Přehrávač nezobrazuje titulky, pro titulky přuprav napoj také nastavení v rámci 03 / Subtitles (velikost, barva, font). U přehrávače neslyším zvuk, dodělej funční Audio output v 02 / Audio a napoj ho na přehrávač.  Seriály by na konci měli automaticky začít odpočítávat přehrání dalšího dílu (5 sekund?), 

- DONE: Tlačítko Find při přejetí (hover) nemění barvy a mění skokově intenzitu záře místo toho aby ji měnilo pomalu, jakoby tepalo. Problém bude asi příliš mnoho animací a jejich překrývání se stop - Stop ted září a sálá duhově, místo jen bílou barvou (při přejetí hover by navíc mělo jen zářit bíle). Je třeba se podívat na starší commit kde vše fungovalo. 

- DONE:Je třeba připravit integrace na více zdrojů obsahu - zavést kontratky atd. 

- DONE:U serálů (i filmů) budeme potřebovat multivariatní vyhledávání, např hledat díly sérii ne jen podle S01E01, 1 + název ale i jen 1. / 1 Problém může být že řeba S02E05 bude v databázi jako díl 15. Také bychom měli připustit nalezení a hledání jen konkterétního dílu seriálu,  třeba S02E05. Uprav vyhledávání tak aby tohle fungovalo.

DONE: Subtitles vyvolávájí Loading subtitles - to není UI přívětívé a navíc se titulky nenačtou v některých případech. Nechápu jaktože titulk dělají takvý problém. Přijde mi že po seek se zase načítají odznovu a zas  časují. Jaktože to ve VLC jde bez problému a okamžitě?  

DONE: - Měli bychom uživatelům umožnit stáhnout komplet celý seiál (všechny dostupné episody, synchronně one-by-one) stejně jako film - tlačítko download na kartě. 

DONE: - Návrh optimalizace: Pokud je nějaký titul Unavaible (i díl seriálu), dohledávání už nebude automatické ale jen na vyžádání uživatelem. U filmu přes Check tlačítko jako nyní, u seriálu Try find more episodes pro vechny díly (jako nyní) nebo kliknutím na tlačíto "Try again" přímo u konkterétního Unavaible dílu (UI pro kartu i seznam episod). Ušetříme tím opakované dotazy na server. Co si o tom myslíš? 

Měli bychom udělat optimalizaci inteligentní, zavedeme dva mechanismy:
- Priority: Jak moc prioritní je pro uživatele tento titul? Jak moc se má systém snažit o dohledání? Priorita je buď nízká nebo vysoká, defaultně je u všech titulů nízká, na vysokou se nastaví jen v případě, že uživatel buď: ručně klikl na "priority" tlačítko (ikona) v kartě titulu, nebo systém vyhodnotí titul jako prioritní tím že s ním uživatel často interaguje (často ho otevírá, pouští třeba další díly serier atd. )

- Namátkovost: Tituly které mají low priority se pokusí dohledat pouze při vytvoření (sekvence více dotazů pro zamezení selhání kvůli případnému konfliktu či selhání serveru), poté se titul uspí a namátkově prohledá třeba jen jednou denně v náhodný čas (náhodný čas je důležitý pro minimalizaci konfliktů). 

Eventy které vyvolají okamžité dohledání a kontrolu dostupnosti, i u Unavaible titulů: 
- Ruční akce uživatele
- Pokus o přehrání dalšího dílu v sérii (přehrávač zkusí dohledat i případný chybějící díl v serii)
- Pokus o masové stažení všech dílů v serii / session (při stahování se pokusí mass download znovuzzkontrolovat dostupnost u nedostupných)

- DONE: Možná bychom mohli Season 0 považovat jako nepovinnou (vybledlá šedá) a nezapočítavat ji do statistik, vyhodnocování počtu dílů / dostupných sérií ani ji nepriorizovat při dohledání (až na posledním místě). Většinou je to jen bonusový obsah.

- DONE: U alternativních zdrojů by měl zdroj šedě obsahovat reálný název souboru

- DONE: Potřebujeme dodělat konektory pro remote agenty: ChatGPT, Claude, Geminy, Grok, Kimi, DeepSeek... Nabízejí se dvě možnosti: API a MCP. Bylo by dobré kdyby StreamerAI uměl obě varianty.
 U MCP bych rád tento hybrdní mod:
Implement a hybrid StreamerAI agent architecture that supports both:
1. MCP Server mode
   - StreamerAI exposes its capabilities as MCP tools to external hosts such as Codex, Claude Code, Cursor, etc.
   - Example tools:
     - search_media()
     - inspect_media()
     - get_subtitles()
     - start_playback()
     - stop_playback()
2. Embedded Local Agent mode
   - StreamerAI can itself use a locally authenticated coding/AI agent as its reasoning backend.
   - Supported providers initially:
     - Codex via codex app-server / SDK where possible
     - Claude Code via its non-interactive/programmatic CLI mode
   - Do NOT read, copy, or manage provider OAuth/API credentials directly.
   - Authentication remains owned by the installed local CLI/tool.
Target architecture:
StreamerAI ├── MCP Server │   └── StreamerAI tools ├── AgentRouter │   ├── CodexProvider │   ├── ClaudeProvider │   └── future providers └── LocalAgentHost └── manages persistent local agent processes / sessions
Requirements:
- Keep MCP tools provider-agnostic.
- Define a common AgentProvider interface, e.g.:
  - startSession()-
  - sendMessage()
  - streamEvents()
  - cancel()
  - closeSession()
- Prefer persistent sessions instead of spawning a new CLI process for every prompt.
- Support streamed responses/events.
- Support cancellation and process cleanup.
- Preserve agent session/thread identifiers.
- Keep StreamerAI business logic independent from Codex/Claude-specific protocols.
- Never expose StreamerAI secrets or direct media URLs unnecessarily to the agent.
- Add configuration such as:
agent: mode: local | api | disabled provider: codex | claude
- Detect whether the selected local provider is installed and authenticated.
- Return a clear capability/status response if unavailable.
- Avoid shell command concatenation; use structured process spawning.
- Add timeouts, lifecycle management, logs, and tests.
- Design the provider abstraction so additional agents can be added later.
Important architectural property:
The same StreamerAI MCP tools must work regardless of whether they are called by:
- external Codex/Claude via MCP,
- or StreamerAI's own embedded local agent.
First inspect the existing repository and reuse current abstractions where possible. Then implement the smallest clean architecture that establishes this bidirectional integration without coupling StreamerAI to one AI vendor.
At completion provide:
- files changed,
- resulting architecture,
- provider interfaces,
- MCP integration,
- Codex integration,
- Claude integration,
- security boundaries,
- tests executed,
- known limitations.

Zajsti aby agenti využívali různé rulesety pro kontrolu úrovně sofitikovanosti vyhledávání, jak jsme již řešili a implementovali. 
Také bychom měli zajistit aby v případě více dostupných agentů, byl aktivní vždy jen jeden, dle preferencí uživatele. 

Proved analýzu nasazení a proveditelnost.

Zkontroluj integraci a napoj ji na Settings a Onboarding. U MCP i API je důležitá jednoduchost a přehlednost pro uživatele. Výběr modelů by měl být automatický (voleny by měli být lehké/rychlé levné modely, jako třeba Terra - Light nebo Medium). Uživatel by měl míát možnost kontroly nad úrovni přemýšlení modelu i nad jeho výběrem: v základu jen posuvník mezi "Speed" (no reasoning) a "Quality" (High Reasoning), expert režim otevře konkterétní výběr konkterétního dostupného modelu a modu.

- Databáze se ted staví per-user: co kdyby si uživatelé uměli sdílet DB?  Tzn, když už uživatel ověří že je to správný zdroj, měla by se tato informace nasdílet i zbytku. Taková komuniktní DB

- Hellspy adapter jako stream source

- DONE: "Local folder or drive" nenamountuje lokální složku, třeba "D:\Download" - hlásí "Open StreamerAI on the home server to use Select folder, or enter the server path manually." - při lokálním nasazení to bude OK

- Musíme zjistit proč "some scify from space with spaceships" a "some scify from space" vyhazuje hned instatně (bez uvažování, zdá se) pokaždé to samé - Spider-Man: Brand New Day - což ení správné chování. Až na opravný dotaz to agent opraví. Také zda je posuvník intenzity přemýšlení opavdu napojený na vybraný model a zda něco ovlivuje - také máme nekonzistenci, v Onboardingu když vyberu lokální Ollamu, tak mi posvník umožní vybrat jen "
No reasoning" a "High reasoning", v Setting ale posuvník umožnuje u téhož modelu vbírat i Light a Balanced. 