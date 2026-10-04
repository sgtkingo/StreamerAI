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

- Proč vyhledávání "Naruto" nic nenajde, když na TMDB i Websharu je? 

- Pokud uživatel zadá např. "Něco co jsem neviděl" tak by si agent měl zažádat o seznam filmů které už uživatel viděl a vyhnout se jim. Pokud je konktextové okno malé, komprimovat. Má agent SOUL.md, SKILLS.md apod? 

- Měli bychom uživatelům umožnit stahovat obsah do své offline knihovny 

- Každý profil by měl mít oddělené data, i v rámci onboardingu

- Přehrávač nezobrazuje titulky, pro titulky přuprav napoj také nastavení v rámci 03 / Subtitles (velikost, barva, font). U přehrávače neslyším zvuk, dodělej funční Audio output v 02 / Audio a napoj ho na přehrávač.  Seriály by na konci měli automaticky začít odpočítávat přehrání dalšího dílu (5 sekund?), 

- Tlačítko Find při přejetí (hover) nemění barvy a mění skokově intenzitu záře místo toho aby ji měnilo pomalu, jakoby tepalo. 

- Je třeba připravit integrace na více zdrojů obsahu - zavést kontratky atd. 

- UI: Problém bude asi příliš mnoho animací a jejich překrývání se stop - Stop ted září a sálá duhově, místo jen bílou barvou (při přejetí hover by navíc mělo jen zářit bíle). Je třeba se podívat na starší commit kde vše fungovalo. 