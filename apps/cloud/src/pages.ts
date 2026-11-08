export const stylesheet = `
:root{font-family:system-ui,sans-serif;color:#f3f4f7;background:#11131a;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;padding:48px 20px}main{max-width:660px;margin:auto}
.brand{color:#a7a2ff;letter-spacing:.12em;font-weight:800}h1{font-size:2rem;margin:24px 0 12px}
p{line-height:1.6;color:#c8cbd6}a{color:#b9b3ff}section{margin-top:24px;padding:24px;background:#1c1f2b;border:1px solid #34384a;border-radius:16px}
label{display:block;margin:16px 0 8px}input,select,button{font:inherit;border-radius:10px;padding:12px 16px;max-width:100%}
input,select{background:#12151f;border:1px solid #656b85;color:inherit;width:100%}button{cursor:pointer;border:1px solid #8378f5;background:#7463e8;color:white;margin:12px 8px 0 0;font-weight:600}
button.secondary{background:transparent;border-color:#656b85}button:disabled{opacity:.5;cursor:wait}code{font:700 2rem ui-monospace,monospace;letter-spacing:.15em}
[hidden]{display:none!important}#message{min-height:1.5em;color:#d5ceff}li{margin:14px 0}small{display:block;color:#aeb3c8;line-height:1.5}.row{border-top:1px solid #34384a;padding:12px 0}footer{margin-top:32px;color:#aeb3c8;font-size:.85rem}
body[data-page="login"]{min-height:100dvh;background:#11131a;padding:40px 24px}
body[data-page="login"] main{max-width:560px}
body[data-page="login"] .brand{color:#a7a2ff;margin-bottom:48px}
body[data-page="login"] h1{font-size:clamp(28px,5vw,38px);letter-spacing:-.04em}
.login-card{padding:32px;background:#1c1f2b;border:1px solid #34384a;border-radius:20px}
.login-card .auth-label{font-size:13px;margin:0 0 14px;color:#b6b9c6}
.login-card button{width:100%;min-height:48px;margin:14px 0 0;background:#7463e8;color:#fff;border-color:transparent;border-radius:12px}
.login-card button:not(.google-button):hover:not(:disabled){background:#6553db}
.login-card .google-button{display:flex;align-items:center;justify-content:center;gap:12px;background:#fff;border:1px solid #dadce0;color:#1f1f1f;margin:0;border-radius:12px}
.login-card .google-button:hover{background:#f2f5fa}.google-button svg{flex-shrink:0}
.auth-divider{display:flex;align-items:center;gap:14px;margin:26px 0;color:#b6b9c6;font-size:12px}
.auth-divider::before,.auth-divider::after{content:"";height:1px;flex:1;background:#34384a}
.login-card .email-heading{font-size:16px;margin:0}.login-card label{font-size:14px}
.login-card .email-open{margin:0}
.login-card #verify-email:disabled{background:#494c5a;color:#c2c4cd;opacity:1;cursor:not-allowed}
.login-card #resend-email{background:transparent;border:1px solid #656b85}
.login-card #resend-email:hover:not(:disabled){background:#2a2d3c}
.login-card .change-email{display:block;width:fit-content;margin:18px auto 0;color:#b9b3ff;background:none;border:0;padding:0;min-height:0;text-decoration:underline;font-weight:400;cursor:pointer}
.login-card .change-email:hover:not(:disabled){background:none;color:#d5d1ff}
.login-card .auth-help{margin:16px 0 0;color:#c8cbd6;line-height:1.6}
.email-fields{margin-top:20px}
.login-card input{background:#12151f;border-color:#656b85;min-height:48px}
.login-card p{font-size:13px}.login-card p:empty{display:none}
.login-tip{margin:24px 0;padding:18px 20px;border:1px solid #34384a;border-radius:14px;color:#b6b9c6;font-size:13px;line-height:1.6;background:#ffffff03}
.login-tip h2{font-size:14px;font-weight:600;margin:0 0 8px;color:#d2d5df}.login-tip p{margin:0;color:inherit}
.account-uid{display:flex;align-items:center;gap:10px;flex-wrap:wrap;color:#aeb3c8;font-size:.85rem}.account-uid code{font:inherit;letter-spacing:0;overflow-wrap:anywhere;color:#e0e1eb}.account-uid button{margin:0;padding:5px 9px;font-size:.8rem}
.household-uid{display:block;margin:8px 0;font:400 .8rem system-ui,sans-serif;letter-spacing:0;overflow-wrap:anywhere;color:#aeb3c8}#households-list{display:grid;gap:12px}.operation-form select{width:100%;min-width:0}.operation-form input{min-width:0}#household-requests .approval-card{overflow-wrap:anywhere}
.account-uid .copy-uid{display:grid;place-items:center;width:36px;height:36px;padding:0;color:#c8cbd6;transition:color .2s,border-color .2s,background-color .2s}
.copy-uid:hover{color:#fff;border-color:#a7a2ff;background:#a7a2ff1a}.copy-uid svg{grid-area:1/1;width:18px;height:18px;transition:opacity .18s,transform .22s}.copy-uid__check{opacity:0;transform:scale(.6)}.copy-uid[data-copied="true"]{color:#8bdbab;border-color:#61ae80;background:#61ae801a}.copy-uid[data-copied="true"] .copy-uid__copy{opacity:0;transform:scale(.6)}.copy-uid[data-copied="true"] .copy-uid__check{opacity:1;transform:scale(1);animation:copy-uid-pop .32s ease-out}
@keyframes copy-uid-pop{50%{transform:scale(1.2)}}
.copy-uid-status{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}
@media(prefers-reduced-motion:reduce){.account-uid .copy-uid,.copy-uid svg{transition:none}.copy-uid[data-copied="true"] .copy-uid__check{animation:none}}
.email-approval__profiles label{display:flex;align-items:center;gap:10px;padding:10px 12px;margin:8px 0;border:1px solid #45495c;border-radius:9px}.email-approval__profiles input[type=checkbox]{width:auto;accent-color:#a7a2ff}
.operation-form{margin-top:20px;padding:18px;border:1px solid #34384a;border-radius:12px;background:#151823}.operation-form summary{cursor:pointer;font-weight:700}.operation-form summary:focus-visible{outline:3px solid #a7a2ff;outline-offset:4px}.operation-form p,.approval-note{font-size:.9rem}.operation-form button{margin-top:16px}.approval-list{display:grid;gap:10px;margin-top:16px}.approval-card{padding:16px;border:1px solid #34384a;border-radius:12px;background:#151823}.approval-card strong{display:block}.approval-card p{margin:6px 0;font-size:.88rem}.approval-card button{font-size:.85rem;padding:9px 12px}.profile-picks{display:grid;gap:8px;max-height:45vh;overflow:auto}.profile-pick{display:flex;gap:10px;align-items:center;padding:10px 12px;margin:0;border:1px solid #45495c;border-radius:9px}.profile-pick input{width:auto;max-width:none;accent-color:#a7a2ff}.profile-pick span{overflow-wrap:anywhere}.selection-error{color:#ffaaaa;font-size:.85rem}
button:focus-visible,input:focus-visible,summary:focus-visible{outline:3px solid #a7a2ff;outline-offset:4px}
.account-section h2{margin:0 0 8px;font-size:1.25rem}.account-section>.section-intro{margin:0 0 20px;font-size:.9rem;color:#aeb3c8}
.method-list{display:grid;gap:10px;margin-top:20px}.method-card,.device-row,.pairing-row{display:flex;align-items:center;gap:14px;padding:16px;border:1px solid #34384a;border-radius:12px;background:#151823}.method-icon{display:grid;place-items:center;flex:none;width:40px;height:40px;border-radius:10px;background:#25283a;font-size:18px;font-weight:700;color:#d8d5ff}.method-content,.device-info,.pairing-info{min-width:0;flex:1}.method-content strong,.device-info strong,.pairing-info strong{display:block}.method-content p,.device-info p,.pairing-info p{font-size:.85rem;margin:4px 0 0;color:#aeb3c8}.method-card button,.device-row button,.pairing-row button{flex:none;margin:0}.method-card button{padding:9px 12px;font-size:.85rem}.account-help{margin-top:18px}.account-link{display:inline-block;margin-top:20px}.device-list,.pairing-list{display:grid;gap:10px;margin-top:20px}.empty-state{color:#aeb3c8;font-size:.9rem;margin:0}.icon-button{display:grid;place-items:center;width:42px;height:42px;padding:0;background:transparent;border-color:#545970;color:#c8cbd6}.icon-button:hover{color:#ffb4b4;border-color:#e77e88;background:#7a273522}.icon-button svg{width:20px;height:20px}.danger-button{background:#a12d40;border-color:#a12d40}.danger-button:hover{background:#b7374b}.confirm-dialog{width:min(440px,calc(100% - 32px));padding:24px;background:#1c1f2b;color:#f3f4f7;border:1px solid #545970;border-radius:16px}.confirm-dialog::backdrop{background:#080910b8}.confirm-dialog h2{margin:0;font-size:1.25rem}.confirm-dialog p{margin:12px 0}.account-final-actions{display:flex;gap:8px;flex-wrap:wrap}.account-final-actions button{margin:12px 0 0}.dialog-actions{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap}.dialog-actions button{margin:8px 0 0}
.master-pin-entry{position:relative;width:min(100%,400px);border-radius:8px}.master-pin-entry:focus-within{outline:2px solid #a7a2ff;outline-offset:3px}.master-pin-entry__slots{display:grid;grid-template-columns:repeat(8,minmax(0,1fr));gap:6px}.master-pin-entry__slot{height:46px;display:grid;place-items:center;border:1px solid #656b85;border-radius:7px;background:#12151f;color:#f3f4f7}.master-pin-entry__input{position:absolute;inset:0;width:100%;height:100%;max-width:none;padding:0;opacity:0;cursor:text}.master-pin-entry__input:disabled{cursor:wait}
@media(max-width:500px){.method-card{flex-wrap:wrap}.method-card button{margin-left:54px}.account-section{padding:20px}}
@media(max-width:400px){body[data-page="login"]{padding:24px 16px}.login-card{padding:20px}}

`;

export function page(
  kind: "login" | "device" | "account",
  emailAvailable = false,
): string {
  const content =
    kind === "login"
      ? `
    <h1>Přihlášení ke StreamerAI</h1><p>Přihlaste se a připojte domácí server ke svému účtu.</p><p id="delete-success" role="status" hidden>Váš online účet byl smazán. Místní data zůstala na domácích serverech.</p><p id="merge-success" role="status" hidden>Účty byly sloučeny. Přihlaste se ke společnému účtu.</p>
    <section class="login-card"><div role="group" aria-label="Přihlášení přes třetí stranu"><p class="auth-label">S vaším stávajícím účtem</p><button id="google" class="google-button"><svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20"><path fill="#4285F4" d="M21.6 12.23c0-.71-.06-1.39-.18-2.05H12v3.88h5.38a4.6 4.6 0 0 1-2 3.02v2.51h3.24c1.9-1.75 2.98-4.33 2.98-7.36Z"/><path fill="#34A853" d="M12 22c2.7 0 4.96-.9 6.62-2.41l-3.24-2.51c-.9.6-2.05.96-3.38.96-2.6 0-4.8-1.76-5.59-4.12H3.07v2.59A10 10 0 0 0 12 22Z"/><path fill="#FBBC05" d="M6.41 13.92a6 6 0 0 1 0-3.84V7.49H3.07a10 10 0 0 0 0 9.02l3.34-2.59Z"/><path fill="#EA4335" d="M12 5.96c1.47 0 2.79.5 3.82 1.49l2.87-2.87A9.6 9.6 0 0 0 12 2a10 10 0 0 0-8.93 5.49l3.34 2.59C7.2 7.72 9.4 5.96 12 5.96Z"/></svg><span>Pokračovat přes Google</span></button></div><div class="auth-divider"><span>nebo e-mailem</span></div>
    ${
      emailAvailable
        ? `<button id="email-open" class="email-open" type="button" aria-expanded="false" aria-controls="email-fields">Pokračovat e-mailem</button><p class="auth-help">Přihlaste se pomocí jednorázového kódu zaslaného na váš e-mail.</p><div id="email-fields" class="email-fields" hidden><h2 class="email-heading">Přihlášení přes e-mail</h2><form id="email-form"><label for="login-email">E-mail</label>
      <input id="login-email" type="email" autocomplete="email" placeholder="vas@email.cz" maxlength="320" required>
      <button id="send-email" type="submit">Poslat přihlašovací kód</button></form>
      <form id="otp-form" hidden><label for="login-otp">Osmimístný kód z e-mailu</label><input id="login-otp" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{8}" maxlength="8" required>
      <button id="verify-email" type="submit" disabled>Přihlásit</button><button id="resend-email" type="button" disabled>Poslat nový kód</button><button id="change-email" class="change-email" type="button">Jiný e-mail</button></form>
      <p id="login-feedback" role="status" aria-live="polite"></p>
      <p>Kód platí 10 minut. Pokud jste dosud používali Google, přihlaste se přes Google a e-mailové přihlášení nejprve zapněte ve správě účtu.</p></div>`
        : "<p>E-mailové přihlášení zatím není dostupné.</p>"
    }
      </section>
    <aside class="login-tip" aria-labelledby="login-tip-title"><h2 id="login-tip-title">Věděli jste, že?</h2><p>StreamerAI můžete používat také bez registrace. Na domácím serveru založte domácnost bez cloudu. Zde spravujete online účet a vlastnictví připojených domácností. Televize a další zařízení se párují přímo s domácím serverem.</p></aside>
  `
      : kind === "device"
        ? `
    <h1>Připojit domácí server</h1><p id="identity"></p>
    <section id="code-section"><form id="code-form"><label for="user-code">Kód z domácího serveru</label>
      <input id="user-code" name="user_code" autocomplete="off" autocapitalize="characters" maxlength="16" placeholder="ABCD-EFGH" required>
      <button type="submit">Ověřit kód</button></form></section>
    <section id="approval" hidden><h2 id="device-name"></h2><p>Na svém zařízení ověřte stejný kód:</p><code id="display-code"></code>
      <p id="grant-description">Povolené zařízení získá přístup k profilům, knihovně, historii a rozkoukanosti vybrané domácnosti. Připojení platí 30 dní a můžete jej kdykoliv zrušit.</p>
      <p>Potvrďte pouze zařízení, které máte u sebe. Neschvalujte neočekávané žádosti ani kódy zaslané cizí osobou.</p>
      <button id="approve">Kód souhlasí, připojit</button><button id="deny" class="secondary">Zamítnout</button></section>
    <p><a href="/account">Spravovat účet a domácnosti</a></p>
  `
        : `
    <h1>Váš účet StreamerAI</h1><p id="identity"></p><div class="account-uid"><span>UID účtu:</span><code id="account-uid"></code><button id="copy-account-uid" class="secondary copy-uid" type="button" aria-label="Kopírovat UID účtu" title="Kopírovat UID účtu"><svg class="copy-uid__copy" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg><svg class="copy-uid__check" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4.5 4.5L19 7"/></svg></button><span id="copy-account-uid-status" class="copy-uid-status" role="status" aria-live="polite"></span></div>
    <p><a id="login-again" href="/login">Změnit účet</a></p>
    <section id="connections" class="account-section"><h2>Propojené účty</h2><p class="section-intro">Spravujte způsoby přihlášení ke svému účtu.</p>
      <div class="method-list"><div class="method-card"><span class="method-icon" aria-hidden="true">G</span><div class="method-content"><strong>Google</strong><p id="google-status"></p></div><button id="link-google" class="secondary" hidden>Propojit</button><button id="unlink-google" class="secondary" hidden>Odpojit</button></div>
      <div class="method-card"><span class="method-icon" aria-hidden="true">@</span><div class="method-content"><strong>E-mail</strong><p id="email-status"></p></div><button id="enable-email" class="secondary" hidden>Zapnout</button><button id="disable-email" class="secondary" hidden>Vypnout</button></div></div>
      <p id="email-feedback" role="status" aria-live="polite"></p>
      <form id="enable-email-form" hidden><label for="enable-email-otp">Osmimístný ověřovací kód</label><input id="enable-email-otp" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{8}" maxlength="8" required><button type="submit">Potvrdit e-mailové přihlášení</button></form>
      <small id="reauth-help" class="account-help" role="status" aria-live="polite" hidden>Pro změnu způsobů přihlášení je potřeba čerstvé ověření účtu. <a id="reauthenticate" href="/login">Přihlaste se znovu</a>.</small></section>

    <section id="households" class="account-section"><h2>Domácnosti</h2><p class="section-intro">Každá domácnost patří jednomu domácímu serveru a má vlastní profily, data a Master PIN. Zařízení, PINy a správce spravujte přímo na příslušném serveru.</p><div id="households-list" class="device-list"></div><a class="account-link" href="/device">Připojit domácí server</a><button id="refresh-households" class="secondary" type="button">Obnovit domácnosti</button></section>
    <section id="requests" class="account-section"><h2>Žádosti ke schválení</h2><p class="section-intro">Převod vlastnictví domácnosti, převod profilu a sloučení vždy potvrzuje cílový vlastník.</p><div id="household-requests" class="approval-list"></div></section>
    <section class="account-section"><h2>Správa domácností</h2>
      <details class="operation-form"><summary>Převést vlastnictví domácnosti</summary><form id="household-owner-form"><label for="owner-household">Domácnost</label><select id="owner-household" required></select><label for="household-target-account">E-mail nebo UID nového vlastníka</label><input id="household-target-account" maxlength="320" required><button type="submit">Požádat o převod</button></form></details>
      <details class="operation-form"><summary>Převést profil mezi domácnostmi</summary><p>Přenese se synchronizovaná knihovna, historie, rozkoukanost a nastavení profilu. Přihlašovací údaje ke službám zůstávají v původní domácnosti. Před převodem synchronizujte oba servery.</p><form id="household-profile-form"><label for="profile-household">Zdrojová domácnost</label><select id="profile-household" required></select><label for="household-profile">Profil</label><select id="household-profile" required></select><label for="profile-target-household">UID cílové domácnosti</label><input id="profile-target-household" maxlength="36" required><button type="submit">Požádat o převod profilu</button></form></details>
      <details class="operation-form"><summary>Sloučit domácnosti</summary><p>Cílová domácnost smí obsahovat nejvýše pět profilů. Šifrované zálohy a místní přihlašovací údaje vyžadují dokončení importu na domácím serveru; schválení je samo nepřepíše.</p><form id="household-merge-form"><label for="merge-household">Zdrojová domácnost</label><select id="merge-household" required></select><label for="merge-target-household">UID cílové domácnosti</label><input id="merge-target-household" maxlength="36" required><button type="submit">Požádat o sloučení</button></form></details>
    </section>
    <p id="operation-reauth" role="status" hidden>Pro tuto akci je potřeba nové ověření. <a id="operation-reauth-link" href="/login">Přihlaste se znovu</a>.</p>
    <div class="account-final-actions"><button id="signout" class="secondary">Odhlásit</button><button id="delete-account" class="danger-button" type="button">Smazat účet</button></div>
    <p id="delete-reauth-help" role="status" hidden>Pro smazání účtu je třeba nové ověření. <a id="delete-reauthenticate" href="/login">Přihlaste se znovu</a>.</p>
    <dialog id="confirm-dialog" class="confirm-dialog" aria-labelledby="confirm-title" aria-describedby="confirm-description"><h2 id="confirm-title"></h2><p id="confirm-description"></p><div class="dialog-actions"><button id="confirm-cancel" class="secondary" type="button">Zrušit</button><button id="confirm-action" class="danger-button" type="button"></button></div></dialog>
    <dialog id="profiles-dialog" class="confirm-dialog" aria-labelledby="profiles-title" aria-describedby="profiles-description"><h2 id="profiles-title"></h2><p id="profiles-description"></p><div id="profiles-list" class="profile-picks"></div><p id="profiles-count" class="approval-note" role="status"></p><p id="profiles-error" class="selection-error" role="alert" hidden>Vyberte alespoň jeden a nejvýše pět profilů.</p><div class="dialog-actions"><button id="profiles-cancel" class="secondary" type="button">Zrušit</button><button id="profiles-confirm" type="button">Potvrdit výběr</button></div></dialog>
  `;
  return `<!doctype html><html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>StreamerAI — účet</title><link rel="stylesheet" href="/assets/auth.css"><script src="/assets/auth.js" defer></script></head><body data-page="${kind}"><main><div class="brand">STREAMER AI</div>${content}<p id="message" role="status" aria-live="polite"></p><footer>Přihlašovací údaje k mediálním službám zůstávají na domácím serveru.</footer></main></body></html>`;
}

export const browserScript = String.raw`
(() => {
  const el = (id) => document.getElementById(id);
  const message = (text, inline) => { el('message').textContent = inline ? '' : text; if(inline && el(inline))el(inline).textContent=text; };
  const errors = {
    household_scope_required:'Nejprve připojte domácí server ke konkrétní domácnosti.',
    household_scope_forbidden:'Toto připojení patří jiné domácnosti.',
    household_conflict:'Domácnost již patří jinému účtu.',
    household_request_changed:'Data domácnosti se změnila. Synchronizujte servery a vytvořte novou žádost.',
    household_request_unavailable:'Žádost již není dostupná nebo vypršela.',
    household_merged:'Tato domácnost již byla sloučena.',
    transfer_data_conflict:'Cílová domácnost obsahuje odlišná data stejného profilu. Dokončete import na domácím serveru.',
    local_pin_management:'PINy spravujte na svém domácím serveru.',
    master_pin_setup_required:'Nejprve nastavte osmimístný Master PIN.',
    master_pin_initialization_required:'Obnovte stránku pro dokončení zabezpečení účtu a zopakujte připojení zařízení.',
    invalid_master_pin_verifier:'Master PIN se nepodařilo připravit. Obnovte stránku a zkuste to znovu.',
    master_pin_unavailable:'Master PIN je dočasně nedostupný. Zkuste to znovu.',
    unauthorized:'Přihlaste se prosím znovu.',invalid_or_expired_code:'Kód není platný nebo již vypršel.',
    profile_limit:'Cílový účet již má pět profilů.',target_account_unavailable:'Cílový účet není dostupný. Nejprve se na něm přihlaste.',
    transfer_changed:'Profily se mezitím změnily. Načtěte stránku a zkuste to znovu.',transfer_not_found:'Převod není dostupný nebo vypršel.',merge_not_found:'Žádost o sloučení není dostupná nebo vypršela.',merge_changed:'Účty nebo profily se mezitím změnily. Vytvořte novou žádost.',merge_email_conflict:'Oba účty mají aktivní přihlášení různými e-maily. Toto sloučení zatím není dostupné.',
    rate_limited:'Příliš mnoho pokusů. Zkuste to za chvíli znovu.',browser_sign_in_required:'Pro tuto akci se přihlaste ke svému účtu.',reauth_required:'Pro tuto akci se prosím znovu přihlaste ke svému účtu.',
    email_unavailable:'E-mail se teď nepodařilo odeslat. Zkuste to později nebo použijte Google.',invalid_otp:'Kód není platný nebo již vypršel. Vyžádejte nový kód.',invalid_email:'Zadejte platnou e-mailovou adresu.',
    last_sign_in_method:'Poslední způsob přihlášení nelze odebrat. Nejprve přidejte jiný.',method_not_connected:'Tento způsob přihlášení už není aktivní.'
  };
  async function api(path, options = {}) {
    const response = await fetch(path, { credentials:'same-origin',signal:AbortSignal.timeout(20000),...options,
      headers:{'Content-Type':'application/json',...(options.headers || {})} });
    const data = await response.json();
    if(response.status===429){const seconds=Number(response.headers.get('retry-after'));const error=new Error(Number.isFinite(seconds)&&seconds>0?'Příliš mnoho pokusů. Další pokus bude možný přibližně za '+Math.ceil(seconds/60)+' min.':'Příliš mnoho pokusů. Zkuste to za chvíli znovu.');error.code='rate_limited';error.retryAfter=Number.isFinite(seconds)&&seconds>0?Math.ceil(seconds):0;throw error;}
    if(data.error==='auth_unavailable')throw new Error('Přihlášení je dočasně nedostupné. Zkuste to prosím znovu.');
    if (!response.ok) { const error = new Error(errors[data.error] || 'Akci se nepodařilo dokončit.'); error.code=data.error; throw error; }
    return data;
  }
  function button(label, action, secondary = false) {
    const result=document.createElement('button'); result.textContent=label;
    if (secondary) result.className='secondary';
    result.addEventListener('click',async()=>{result.disabled=true;try{await action();}catch(error){operationError(error);}finally{result.disabled=false;}});
    return result;
  }
  function row(container, text) {const div=document.createElement('div');div.className='row';const p=document.createElement('p');p.textContent=text;div.append(p);container.append(div);return div;}
  function confirmAction(title, description, actionLabel) {
    return new Promise(resolve=>{const dialog=el('confirm-dialog');el('confirm-title').textContent=title;el('confirm-description').textContent=description;el('confirm-action').textContent=actionLabel;
      let confirmed=false;const yes=()=>{confirmed=true;dialog.close();};const no=()=>dialog.close();const finish=()=>{el('confirm-action').removeEventListener('click',yes);el('confirm-cancel').removeEventListener('click',no);dialog.removeEventListener('close',finish);resolve(confirmed);};
      el('confirm-action').addEventListener('click',yes);el('confirm-cancel').addEventListener('click',no);dialog.addEventListener('close',finish);dialog.showModal();el('confirm-cancel').focus();});
  }
  function chooseProfiles(title, description, profiles, requiredId) {
    return new Promise(resolve=>{
      const dialog=el('profiles-dialog');const list=el('profiles-list');list.replaceChildren();el('profiles-title').textContent=title;el('profiles-description').textContent=description;el('profiles-error').hidden=true;
      profiles.forEach(profile=>{const label=document.createElement('label');label.className='profile-pick';const input=document.createElement('input');input.type='checkbox';input.value=profile.id;input.checked=profiles.length<=5 || profile.id===requiredId;input.disabled=profile.id===requiredId;const name=document.createElement('span');name.textContent=profile.name+(profile.ownerLabel?' · '+profile.ownerLabel:'');label.append(input,name);list.append(label);});
      const chosen=()=>Array.from(list.querySelectorAll('input:checked')).map(input=>input.value);
      const update=()=>{el('profiles-count').textContent='Vybráno '+chosen().length+' z nejvýše 5 profilů.';el('profiles-error').hidden=true;};
      let value=null;const yes=()=>{const ids=chosen();if((profiles.length&&!ids.length)||ids.length>5){el('profiles-error').hidden=false;return;}value=ids;dialog.close();};const no=()=>dialog.close();const finish=()=>{list.removeEventListener('change',update);el('profiles-confirm').removeEventListener('click',yes);el('profiles-cancel').removeEventListener('click',no);dialog.removeEventListener('close',finish);resolve(value);};
      list.addEventListener('change',update);el('profiles-confirm').addEventListener('click',yes);el('profiles-cancel').addEventListener('click',no);dialog.addEventListener('close',finish);update();dialog.showModal();el('profiles-cancel').focus();
    });
  }
  const query=new URLSearchParams(location.search);
  const expectedAccount = query.get('account_id') || '';
  const accountQuery = /^[a-zA-Z0-9_-]{1,160}$/.test(expectedAccount) ? '?account_id='+encodeURIComponent(expectedAccount) : '';
  const rawCode=query.get('user_code') || '';
  const code=rawCode.replace(/[\s-]/g,'').toUpperCase();
  const safeCode=/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(code)?code:'';
  const rawApproval=query.get('approval')||'';
  const approval=/^(transfer|merge)\.[0-9a-f-]{36}$/i.test(rawApproval)?rawApproval:'';
  const intent=['accept','decline'].includes(query.get('intent'))?query.get('intent'):'';
  const approvalQuery=approval?'?approval='+encodeURIComponent(approval)+(intent?'&intent='+intent:''):'';
  const accountDestination='/account'+(accountQuery&&approvalQuery?accountQuery+'&'+approvalQuery.slice(1):approvalQuery||accountQuery);
  let approvalOpened=false;
  let portalAccount=null;
  function operationError(error){if(error.code==='reauth_required'&&el('operation-reauth')){el('operation-reauth').hidden=false;message('');el('operation-reauth-link').focus();}else message(error.message);}
  function sentMessage(result){return result.emailStatus==='sent'?'Žádost byla vytvořena a oznámení odesláno e-mailem.':'Žádost byla vytvořena, ale e-mail se nepodařilo odeslat. Druhý vlastník ji najde ve svém účtu.';}
  async function signIn() {
    const destination = safeCode ? '/device?user_code='+encodeURIComponent(safeCode) : accountDestination;
    const data=await api('/api/auth/sign-in/social',{method:'POST',body:JSON.stringify({provider:'google',callbackURL:location.origin+destination,errorCallbackURL:location.origin+'/login'})});
    if (!data.url || new URL(data.url).origin!=='https://accounts.google.com') throw new Error('Nepodařilo se zahájit přihlášení.');
    location.assign(data.url);
  }
  async function account() {
    try {const data=await api('/v1/account');el('identity').textContent=data.name+' · '+data.email;return data;}
    catch(error){if(error.code==='unauthorized'){location.replace('/login'+(safeCode?'?user_code='+encodeURIComponent(safeCode):(approvalQuery||accountQuery)));return null;}throw error;}
  }

  async function refreshHouseholdProfiles() {
    const id=el('profile-household').value;el('household-profile').replaceChildren();
    if(!id)return;
    const data=await api('/v1/households/'+encodeURIComponent(id)+'/profiles');
    data.profiles.forEach(profile=>{const option=document.createElement('option');option.value=profile.id;option.textContent=profile.name;el('household-profile').append(option);});
  }
  async function refreshPortal() {
    const [data,requests]=await Promise.all([api('/v1/households'),api('/v1/household-requests')]);
    el('households-list').replaceChildren();
    if(!data.households.length){const p=document.createElement('p');p.className='empty-state';p.textContent='Zatím nemáte připojenou domácnost. Přihlaste cloudový účet na svém domácím serveru.';el('households-list').append(p);}
    for(const household of data.households){
      const card=document.createElement('div');card.className='approval-card';const name=document.createElement('strong');name.textContent=household.name;const id=document.createElement('code');id.className='household-uid';id.textContent=household.id;const status=document.createElement('p');status.textContent=household.mergedInto?'Sloučeno do '+household.mergedInto:household.hasBackup?'Šifrovaná záloha · '+new Date(household.lastBackupAt).toLocaleString('cs-CZ'):'Bez aktuální cloudové zálohy';card.append(name,id,status);
      if(!household.mergedInto){card.append(button('Odpojit server',async()=>{if(!await confirmAction('Odpojit server od cloudu?','Místní domácnost i uložené cloudové zálohy zůstanou zachovány. Server se přestane synchronizovat, dokud jej znovu nepřipojíte.','Odpojit'))return;await api('/v1/households/'+encodeURIComponent(household.id)+'/connection',{method:'DELETE'});message('Připojení domácího serveru bylo odvoláno.');await refreshPortal();},true));}
      const resets=await api('/v1/households/'+encodeURIComponent(household.id)+'/pin-resets');
      for(const reset of resets.requests){const line=document.createElement('div');line.className='row';const text=document.createElement('p');text.textContent='Ověření vlastnictví · '+reset.profile_name+' · '+reset.device_name;line.append(text);for(const approve of [true,false])line.append(button(approve?'Povolit obnovu':'Zamítnout',async()=>{if(!await confirmAction('Ověření vlastnictví domácnosti',reset.profile_name+' · '+reset.device_name,approve?'Povolit':'Zamítnout'))return;await api('/v1/households/'+encodeURIComponent(household.id)+'/pin-resets/'+encodeURIComponent(reset.id)+'/decision',{method:'POST',body:JSON.stringify({approve})});await refreshPortal();},!approve));card.append(line);}
      el('households-list').append(card);
    }
    for(const key of ['owner-household','profile-household','merge-household']){const select=el(key),previous=select.value;select.replaceChildren();data.households.filter(h=>!h.mergedInto).forEach(h=>{const option=document.createElement('option');option.value=h.id;option.textContent=h.name+' · '+h.id;select.append(option);});if([...select.options].some(o=>o.value===previous))select.value=previous;}
    await refreshHouseholdProfiles();
    el('household-requests').replaceChildren();
    if(!requests.requests.length){const p=document.createElement('p');p.className='empty-state';p.textContent='Žádné čekající žádosti.';el('household-requests').append(p);}
    for(const request of requests.requests){const div=row(el('household-requests'),({'ownership-transfer':'Převod vlastnictví','profile-transfer':'Převod profilu',merge:'Sloučení domácností'}[request.kind]||request.kind)+' · '+request.source_name+' → '+(request.target_name||request.target_email));div.className='approval-card';const expiry=document.createElement('small');expiry.textContent='Platí do '+new Date(request.expires_at).toLocaleString('cs-CZ');div.append(expiry);if(request.requiresLocalImport){const p=document.createElement('p');p.textContent='Schváleno. Dokončete import šifrované domácnosti na cílovém domácím serveru.';div.append(p);}else if(request.incoming){for(const approve of [true,false])div.append(button(approve?'Schválit':'Zamítnout',async()=>{if(!await confirmAction(approve?'Schválit žádost?':'Zamítnout žádost?',request.source_name+' → '+(request.target_name||request.target_email),approve?'Schválit':'Zamítnout'))return;const result=await api('/v1/household-requests/'+encodeURIComponent(request.id)+'/decision',{method:'POST',body:JSON.stringify({approve})});message(result.requiresLocalImport?'Schváleno. Dokončete import na cílovém domácím serveru.':'Žádost byla zpracována.');await refreshPortal();},!approve));}}
  }
  async function init() {
    if(document.body.dataset.page==='login'){
      if(query.get('account_deleted')==='1')el('delete-success').hidden=false;
      if(query.get('merged')==='1')el('merge-success').hidden=false;
      el('google').addEventListener('click',()=>{el('google').disabled=true;signIn().catch(error=>{message(error.message);el('google').disabled=false;});});
      el('email-open')?.addEventListener('click',()=>{el('email-fields').hidden=false;el('email-open').setAttribute('aria-expanded','true');el('email-open').hidden=true;el('login-email').focus();});
      let email='';
      let resendTimer;
      let initialTimer;
      let resendDeadline=0;
      let busy=false;
      function updateResend(){const target=el('resend-email');const remaining=Math.max(0,Math.ceil((resendDeadline-Date.now())/1000));target.disabled=busy||remaining>0;target.textContent=remaining>0?'Poslat nový kód za '+(remaining>60?Math.ceil(remaining/60)+' min':remaining+' s'):'Poslat nový kód';if(remaining<=0)clearInterval(resendTimer);}
      function cooldown(seconds){clearInterval(resendTimer);resendDeadline=Date.now()+seconds*1000;updateResend();if(seconds>0)resendTimer=setInterval(updateResend,1000);}
      function initialCooldown(seconds){clearInterval(initialTimer);const deadline=Date.now()+seconds*1000;const tick=()=>{const remaining=Math.max(0,Math.ceil((deadline-Date.now())/1000));el('send-email').disabled=remaining>0;el('send-email').textContent=remaining>0?'Zkusit znovu za '+(remaining>60?Math.ceil(remaining/60)+' min':remaining+' s'):'Poslat přihlašovací kód';if(!remaining)clearInterval(initialTimer);};tick();if(seconds>0)initialTimer=setInterval(tick,1000);}
      function updateVerify(){el('verify-email').disabled=busy||!/^\d{8}$/.test(el('login-otp').value);}
      function setBusy(value){busy=value;el('login-otp').disabled=value;el('change-email').disabled=value;updateVerify();updateResend();}
      async function sendCode(address,isResend){const target=el('send-email');let retryAfter=0;target.disabled=true;target.textContent='Odesílám kód…';setBusy(true);message('','login-feedback');try{
        await api('/api/auth/email-otp/send-verification-otp',{method:'POST',body:JSON.stringify({email:address,type:'sign-in'})});
        email=address;el('email-form').hidden=true;el('otp-form').hidden=false;el('login-otp').value='';message('Pokud je přihlášení k adrese '+email+' dostupné, přijde nový kód. Zkontrolujte i Spam a použijte nejnovější přihlašovací kód.','login-feedback');cooldown(60);
      }catch(error){message(error.message,'login-feedback');retryAfter=error.retryAfter||0;if(isResend&&retryAfter)cooldown(retryAfter);}
      finally{if(!isResend&&retryAfter)initialCooldown(retryAfter);else{target.disabled=false;target.textContent='Poslat přihlašovací kód';}setBusy(false);if(!el('otp-form').hidden)el('login-otp').focus();}}
      el('email-form')?.addEventListener('submit',event=>{event.preventDefault();if(!busy&&!el('send-email').disabled)void sendCode(el('login-email').value.trim(),false);});
      el('resend-email')?.addEventListener('click',()=>{if(!busy&&Date.now()>=resendDeadline)void sendCode(email,true);});
      el('change-email')?.addEventListener('click',()=>{if(busy)return;clearInterval(resendTimer);el('otp-form').hidden=true;el('email-form').hidden=false;el('login-otp').value='';message('','login-feedback');el('login-email').focus();});
      el('login-otp')?.addEventListener('input',()=>{updateVerify();if(!busy&&/^\d{8}$/.test(el('login-otp').value))el('otp-form').requestSubmit();});
      el('otp-form')?.addEventListener('submit',async(event)=>{event.preventDefault();const otp=el('login-otp').value;if(busy||!/^\d{8}$/.test(otp))return;setBusy(true);message('','login-feedback');try{
        await api('/api/auth/sign-in/email-otp',{method:'POST',body:JSON.stringify({email,otp})});
        location.assign(safeCode?'/device?user_code='+encodeURIComponent(safeCode):accountDestination);
      }catch(error){message(error.message,'login-feedback');setBusy(false);el('login-otp').focus();}});
      return;
    }
    const currentAccount=await account();if(!currentAccount)return;
    if(expectedAccount && currentAccount.id!==expectedAccount)throw new Error('V prohlížeči je přihlášen jiný účet než v domácí instalaci. Přihlaste se znovu ke stejnému účtu, který chcete propojit.');
    const reauthenticate=el('reauthenticate');if(reauthenticate && /^[a-zA-Z0-9_-]{1,160}$/.test(currentAccount.id))reauthenticate.href='/login?account_id='+encodeURIComponent(currentAccount.id);
    const deleteReauthenticate=el('delete-reauthenticate');if(deleteReauthenticate && /^[a-zA-Z0-9_-]{1,160}$/.test(currentAccount.id))deleteReauthenticate.href='/login?account_id='+encodeURIComponent(currentAccount.id);
    if(document.body.dataset.page==='account'){
      portalAccount=currentAccount;
      el('account-uid').textContent=currentAccount.id;
      if(approvalQuery)el('login-again').href='/login'+approvalQuery;
      let copyResetTimer;
      el('copy-account-uid').addEventListener('click',async()=>{const target=el('copy-account-uid');const status=el('copy-account-uid-status');clearTimeout(copyResetTimer);delete target.dataset.copied;target.title='Kopírovat UID účtu';status.textContent='';try{await navigator.clipboard.writeText(currentAccount.id);void target.offsetWidth;target.dataset.copied='true';target.title='UID účtu zkopírováno';status.textContent='UID účtu bylo zkopírováno.';copyResetTimer=setTimeout(()=>{delete target.dataset.copied;target.title='Kopírovat UID účtu';status.textContent='';},2000);}catch{message('UID můžete označit a zkopírovat ručně.');}});
      el('operation-reauth-link').href='/login?account_id='+encodeURIComponent(currentAccount.id)+(approvalQuery?'&'+approvalQuery.slice(1):'');
      el('signout').addEventListener('click',async()=>{try{await api('/api/auth/sign-out',{method:'POST',body:'{}'});location.assign('/login');}catch(error){message(error.message);}});
      el('delete-account').addEventListener('click',async()=>{if(!await confirmAction('Smazat účet?', 'Tím trvale smažete online účet, připojená zařízení a cloudové profily, knihovnu a historii. Místní data na domácích serverech zůstanou zachována. Akci nelze vrátit zpět.', 'Smazat účet'))return;const target=el('delete-account');target.disabled=true;el('delete-reauth-help').hidden=true;message('');try{await api('/v1/account',{method:'DELETE'});location.replace('/login?account_deleted=1');}catch(error){if(error.code==='reauth_required')el('delete-reauth-help').hidden=false;else message(error.message);target.disabled=false;}});
      function clearMethodFeedback(){el('reauth-help').hidden=true;message('','email-feedback');}
      function methodError(error, fallback){el('reauth-help').hidden=error.code!=='reauth_required';message(error.code==='reauth_required'?'':(fallback||error.message),'email-feedback');}
      async function methods(){const state=await api('/v1/account/email-login');el('email-status').textContent=state.enabled?'Přihlášení je aktivní':state.available?'Přihlášení není aktivní':'Momentálně nedostupné';el('enable-email').hidden=!state.available||state.enabled;el('disable-email').hidden=!state.enabled;el('link-google').hidden=state.googleLinked;el('unlink-google').hidden=!state.googleLinked;el('google-status').textContent=state.googleLinked?'Účet je propojen':'Účet není propojen';}
      await methods();
      el('enable-email').addEventListener('click',async()=>{const target=el('enable-email');const label=target.textContent;target.disabled=true;target.textContent='Odesílám kód…';clearMethodFeedback();try{await api('/v1/account/email-login/code',{method:'POST',body:'{}'});el('enable-email-form').hidden=false;el('enable-email-otp').focus();message('Ověřovací kód byl odeslán na e-mail tohoto účtu.','email-feedback');}catch(error){methodError(error);}finally{target.disabled=false;target.textContent=label;}});
      el('enable-email-form').addEventListener('submit',async(event)=>{event.preventDefault();const target=event.target.querySelector('button');target.disabled=true;clearMethodFeedback();try{await api('/v1/account/email-login/confirm',{method:'POST',body:JSON.stringify({otp:el('enable-email-otp').value.trim()})});el('enable-email-form').hidden=true;el('enable-email-otp').value='';await methods();message('E-mailové přihlášení je aktivní pro tento účet. Vaše profily zůstávají na stejném účtu.','email-feedback');}catch(error){methodError(error);}finally{target.disabled=false;}});
      el('link-google').addEventListener('click',async()=>{el('link-google').disabled=true;clearMethodFeedback();try{const data=await api('/api/auth/link-social',{method:'POST',body:JSON.stringify({provider:'google',callbackURL:location.origin+'/account'+accountQuery})});if(!data.url||new URL(data.url).origin!=='https://accounts.google.com')throw new Error('Propojení se nepodařilo zahájit.');location.assign(data.url);}catch(error){methodError(error);el('link-google').disabled=false;}});
      async function removeMethod(target,path,title,description,success){if(!await confirmAction(title,description,'Odebrat'))return;target.disabled=true;clearMethodFeedback();try{await api(path,{method:'DELETE'});await methods();message(success,'email-feedback');}catch(error){methodError(error,error.code==='email_unavailable'?'E-mailové přihlášení teď není dostupné. Google nelze bezpečně odpojit.':undefined);}finally{target.disabled=false;}}
      el('unlink-google').addEventListener('click',()=>removeMethod(el('unlink-google'),'/v1/account/google-login','Odpojit Google?', 'Odpojíte všechna propojená přihlášení přes Google. K tomuto účtu se už nebudete moci přihlašovat přes Google.','Google byl odpojen.'));
      el('disable-email').addEventListener('click',()=>removeMethod(el('disable-email'),'/v1/account/email-login','Vypnout e-mailové přihlášení?', 'K tomuto účtu se už nebudete moci přihlašovat e-mailovým kódem.','E-mailové přihlášení bylo vypnuto.'));
      await refreshPortal();

      el('refresh-households').addEventListener('click',()=>refreshPortal().catch(operationError));
      el('profile-household').addEventListener('change',()=>refreshHouseholdProfiles().catch(operationError));
      for(const [formId,sourceId,endpoint,makeBody] of [
        ['household-owner-form','owner-household','ownership-transfer',()=>({targetAccountId:el('household-target-account').value.trim()})],
        ['household-profile-form','profile-household','profile-transfers',()=>({profileId:el('household-profile').value,targetHouseholdId:el('profile-target-household').value.trim()})],
        ['household-merge-form','merge-household','merge',()=>({targetHouseholdId:el('merge-target-household').value.trim()})]
      ])el(formId).addEventListener('submit',async(event)=>{event.preventDefault();const submit=event.target.querySelector('button[type=submit]');submit.disabled=true;el('operation-reauth').hidden=true;try{await api('/v1/households/'+encodeURIComponent(el(sourceId).value)+'/'+endpoint,{method:'POST',body:JSON.stringify(makeBody())});message('Žádost byla vytvořena. Cílový vlastník ji potvrdí ve svém účtu.');await refreshPortal();}catch(error){operationError(error);}finally{submit.disabled=false;}});
      return;
    }
    el('user-code').value=safeCode;
    let verifiedCode='';
    async function verify(){const value=el('user-code').value;let data;try{data=await api('/v1/device/verify?user_code='+encodeURIComponent(value));await api('/v1/device/claim',{method:'POST',body:JSON.stringify({user_code:data.user_code})});}catch(error){if(error.code==='reauth_required'){location.assign('/login?user_code='+encodeURIComponent(value));return;}throw error;}verifiedCode=data.user_code;el('display-code').textContent=data.user_code;el('device-name').textContent=(data.purpose==='pin-reset'?'Obnovit PIN · ':'')+data.device_name;if(data.purpose==='pin-reset'){el('grant-description').textContent='Schvalujete reset PINu profilu „'+data.profile_name+'“ na tomto domácím serveru. Původní PIN bude možné nahradit. Toto oprávnění platí pouze 5 minut.';el('approve').textContent='Kód souhlasí, povolit reset PINu';}el('approval').hidden=false;el('code-section').hidden=true;message('');}
    el('code-form').addEventListener('submit',event=>{event.preventDefault();verify().catch(error=>message(error.message));});
    async function approve(allow){el('approve').disabled=true;el('deny').disabled=true;try{await api('/v1/device/approve',{method:'POST',body:JSON.stringify({user_code:verifiedCode,approve:allow})});el('approval').hidden=true;message(allow?'Žádost byla schválena. Vraťte se k domácímu serveru.':'Žádost byla zamítnuta.');}catch(error){if(error.code==='reauth_required'){location.assign('/login?user_code='+encodeURIComponent(verifiedCode));return;}message(error.message);el('approve').disabled=false;el('deny').disabled=false;}}
    el('approve').addEventListener('click',()=>approve(true));el('deny').addEventListener('click',()=>approve(false));
    if(safeCode)await verify();
  }
  init().catch(error=>message(error.message));
})();
`;
