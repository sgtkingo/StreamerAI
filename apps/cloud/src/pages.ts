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
button:focus-visible,input:focus-visible,summary:focus-visible{outline:3px solid #a7a2ff;outline-offset:4px}
.account-section h2{margin:0 0 8px;font-size:1.25rem}.account-section>.section-intro{margin:0 0 20px;font-size:.9rem;color:#aeb3c8}
.method-list{display:grid;gap:10px;margin-top:20px}.method-card,.device-row,.pairing-row{display:flex;align-items:center;gap:14px;padding:16px;border:1px solid #34384a;border-radius:12px;background:#151823}.method-icon{display:grid;place-items:center;flex:none;width:40px;height:40px;border-radius:10px;background:#25283a;font-size:18px;font-weight:700;color:#d8d5ff}.method-content,.device-info,.pairing-info{min-width:0;flex:1}.method-content strong,.device-info strong,.pairing-info strong{display:block}.method-content p,.device-info p,.pairing-info p{font-size:.85rem;margin:4px 0 0;color:#aeb3c8}.method-card button,.device-row button,.pairing-row button{flex:none;margin:0}.method-card button{padding:9px 12px;font-size:.85rem}.account-help{margin-top:18px}.account-link{display:inline-block;margin-top:20px}.device-list,.pairing-list{display:grid;gap:10px;margin-top:20px}.empty-state{color:#aeb3c8;font-size:.9rem;margin:0}.icon-button{display:grid;place-items:center;width:42px;height:42px;padding:0;background:transparent;border-color:#545970;color:#c8cbd6}.icon-button:hover{color:#ffb4b4;border-color:#e77e88;background:#7a273522}.icon-button svg{width:20px;height:20px}.danger-button{background:#a12d40;border-color:#a12d40}.danger-button:hover{background:#b7374b}.confirm-dialog{width:min(440px,calc(100% - 32px));padding:24px;background:#1c1f2b;color:#f3f4f7;border:1px solid #545970;border-radius:16px}.confirm-dialog::backdrop{background:#080910b8}.confirm-dialog h2{margin:0;font-size:1.25rem}.confirm-dialog p{margin:12px 0}.dialog-actions{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap}.dialog-actions button{margin:8px 0 0}
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
    <h1>Přihlášení ke StreamerAI</h1><p>Přihlaste se a připojte domácí server nebo TV ke svému účtu.</p>
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
    <aside class="login-tip" aria-labelledby="login-tip-title"><h2 id="login-tip-title">Věděli jste, že?</h2><p>StreamerAI můžete používat také bez registrace. Otevřete svou domácí instalaci a zvolte pokračování s místním účtem. Zde spravujete online účet a párování zařízení.</p></aside>
  `
      : kind === "device"
        ? `
    <h1>Připojit zařízení</h1><p id="identity"></p>
    <section id="code-section"><form id="code-form"><label for="user-code">Kód z TV nebo domácího serveru</label>
      <input id="user-code" name="user_code" autocomplete="off" autocapitalize="characters" maxlength="16" placeholder="ABCD-EFGH" required>
      <button type="submit">Ověřit kód</button></form></section>
    <section id="approval" hidden><h2 id="device-name"></h2><p>Na svém zařízení ověřte stejný kód:</p><code id="display-code"></code>
      <p id="grant-description">Povolené zařízení získá přístup k profilům, knihovně, historii a rozkoukanosti vašeho účtu. Připojení platí 30 dní a můžete jej kdykoliv zrušit.</p>
      <p>Potvrďte pouze zařízení, které máte u sebe. Neschvalujte neočekávané žádosti ani kódy zaslané cizí osobou.</p>
      <button id="approve">Kód souhlasí, připojit</button><button id="deny" class="secondary">Zamítnout</button></section>
    <p><a href="/account">Spravovat účet a zařízení</a></p>
  `
        : `
    <h1>Váš účet StreamerAI</h1><p id="identity"></p>
    <p><a id="login-again" href="/login">Změnit účet</a></p>
    <section id="connections" class="account-section"><h2>Propojené účty</h2><p class="section-intro">Spravujte způsoby přihlášení ke svému účtu.</p>
      <div class="method-list"><div class="method-card"><span class="method-icon" aria-hidden="true">G</span><div class="method-content"><strong>Google</strong><p id="google-status"></p></div><button id="link-google" class="secondary" hidden>Propojit</button><button id="unlink-google" class="secondary" hidden>Odpojit</button></div>
      <div class="method-card"><span class="method-icon" aria-hidden="true">@</span><div class="method-content"><strong>E-mail</strong><p id="email-status"></p></div><button id="enable-email" class="secondary" hidden>Zapnout</button><button id="disable-email" class="secondary" hidden>Vypnout</button></div></div>
      <p id="email-feedback" role="status" aria-live="polite"></p>
      <form id="enable-email-form" hidden><label for="enable-email-otp">Osmimístný ověřovací kód</label><input id="enable-email-otp" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{8}" maxlength="8" required><button type="submit">Potvrdit e-mailové přihlášení</button></form>
      <small id="reauth-help" class="account-help" role="status" aria-live="polite" hidden>Pro změnu způsobů přihlášení je potřeba čerstvé ověření účtu. <a id="reauthenticate" href="/login">Přihlaste se znovu</a>.</small></section>
    <section class="account-section"><h2>Čekající párování</h2><p class="section-intro">Potvrďte pouze žádosti ze zařízení, které máte u sebe.</p><div id="pairings" class="pairing-list"></div><a class="account-link" href="/device">Zadat párovací kód ručně</a></section>
    <section class="account-section"><h2>Připojená zařízení</h2><div id="devices" class="device-list"></div><a class="account-link" href="/device">Připojit další zařízení</a></section>
    <section><h2>Převést profil</h2><p>Převod přenese knihovnu, historii a rozkoukanost. Cílový účet musí být již vytvořený a mít volné místo mezi pěti profily. PIN nastavíte znovu na cílovém serveru.</p>
      <form id="transfer-form"><label for="profile">Profil</label><select id="profile" required></select>
      <label for="target-email">E-mail cílového účtu</label><input id="target-email" type="email" autocomplete="email" required>
      <button type="submit">Požádat o převod</button></form><small>Požadavek platí 10 minut. Převod dokončí přihlášený vlastník cílového účtu.</small></section>
    <section><h2>Čekající převody</h2><div id="transfers"></div></section>
    <button id="signout" class="secondary">Odhlásit</button>
    <dialog id="confirm-dialog" class="confirm-dialog" aria-labelledby="confirm-title" aria-describedby="confirm-description"><h2 id="confirm-title"></h2><p id="confirm-description"></p><div class="dialog-actions"><button id="confirm-cancel" class="secondary" type="button">Zrušit</button><button id="confirm-action" class="danger-button" type="button"></button></div></dialog>
  `;
  return `<!doctype html><html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>StreamerAI — účet</title><link rel="stylesheet" href="/assets/auth.css"><script src="/assets/auth.js" defer></script></head><body data-page="${kind}"><main><div class="brand">STREAMER AI</div>${content}<p id="message" role="status" aria-live="polite"></p><footer>Přihlašovací údaje k mediálním službám zůstávají na domácím serveru.</footer></main></body></html>`;
}

export const browserScript = String.raw`
(() => {
  const el = (id) => document.getElementById(id);
  const message = (text, inline) => { el('message').textContent = inline ? '' : text; if(inline && el(inline))el(inline).textContent=text; };
  const errors = {
    unauthorized:'Přihlaste se prosím znovu.',invalid_or_expired_code:'Kód není platný nebo již vypršel.',
    profile_limit:'Cílový účet již má pět profilů.',target_account_unavailable:'Cílový účet není dostupný. Nejprve se na něm přihlaste.',
    transfer_changed:'Profil se mezitím změnil. Načtěte stránku a opakujte převod.',transfer_not_found:'Převod není dostupný nebo vypršel.',
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
    result.addEventListener('click',async()=>{result.disabled=true;try{await action();}catch(error){message(error.message);}finally{result.disabled=false;}});
    return result;
  }
  function row(container, text) {const div=document.createElement('div');div.className='row';const p=document.createElement('p');p.textContent=text;div.append(p);container.append(div);return div;}
  function confirmAction(title, description, actionLabel) {
    return new Promise(resolve=>{const dialog=el('confirm-dialog');el('confirm-title').textContent=title;el('confirm-description').textContent=description;el('confirm-action').textContent=actionLabel;
      let confirmed=false;const yes=()=>{confirmed=true;dialog.close();};const no=()=>dialog.close();const finish=()=>{el('confirm-action').removeEventListener('click',yes);el('confirm-cancel').removeEventListener('click',no);dialog.removeEventListener('close',finish);resolve(confirmed);};
      el('confirm-action').addEventListener('click',yes);el('confirm-cancel').addEventListener('click',no);dialog.addEventListener('close',finish);dialog.showModal();el('confirm-cancel').focus();});
  }
  const query=new URLSearchParams(location.search);
  const expectedAccount = query.get('account_id') || '';
  const accountQuery = /^[a-zA-Z0-9_-]{1,160}$/.test(expectedAccount) ? '?account_id='+encodeURIComponent(expectedAccount) : '';
  const rawCode=query.get('user_code') || '';
  const code=rawCode.replace(/[\s-]/g,'').toUpperCase();
  const safeCode=/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(code)?code:'';
  async function signIn() {
    const destination = safeCode ? '/device?user_code='+encodeURIComponent(safeCode) : '/account'+accountQuery;
    const data=await api('/api/auth/sign-in/social',{method:'POST',body:JSON.stringify({provider:'google',callbackURL:location.origin+destination,errorCallbackURL:location.origin+'/login'})});
    if (!data.url || new URL(data.url).origin!=='https://accounts.google.com') throw new Error('Nepodařilo se zahájit přihlášení.');
    location.assign(data.url);
  }
  async function account() {
    try {const data=await api('/v1/account');el('identity').textContent=data.name+' · '+data.email;return data;}
    catch(error){if(error.code==='unauthorized'){location.replace('/login'+(safeCode?'?user_code='+encodeURIComponent(safeCode):accountQuery));return null;}throw error;}
  }
  async function refreshPortal() {
    const [devices,profiles,transfers,pending]=await Promise.all([api('/v1/devices'),api('/v1/profiles'),api('/v1/transfers'),api('/v1/device/pending')]);
    el('devices').replaceChildren();
    if(!devices.devices.length){const p=document.createElement('p');p.className='empty-state';p.textContent='Zatím nemáte připojená zařízení.';el('devices').append(p);}
    devices.devices.forEach(device=>{
      const revoked=!!device.revoked_at;const expired=device.expires_at<=Date.now();
      const div=document.createElement('div');div.className='device-row';const info=document.createElement('div');info.className='device-info';const name=document.createElement('strong');name.textContent=device.name;const status=document.createElement('p');status.textContent=revoked?'Odpojeno':expired?'Přihlášení vypršelo':'Připojeno';info.append(name,status);div.append(info);
      const remove=button('',async()=>{if(!await confirmAction('Odebrat zařízení?', 'Zařízení „'+device.name+'“ ztratí přístup k tomuto účtu. Pro další použití ho budete muset znovu připojit.', 'Odebrat zařízení'))return;await api('/v1/devices/'+encodeURIComponent(device.id),{method:'DELETE'});await refreshPortal();});remove.className='icon-button';remove.setAttribute('aria-label','Odebrat zařízení '+device.name);remove.title='Odebrat zařízení';remove.innerHTML='<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6m4-6v6M5 7l1 13h12l1-13M9 7V4h6v3"/></svg>';div.append(remove);el('devices').append(div);
    });
    el('pairings').replaceChildren();
    if(!pending.pairings.length){const p=document.createElement('p');p.className='empty-state';p.textContent='Žádná žádost přiřazená k tomuto účtu. Nové zařízení nejprve otevřete přes QR kód nebo zadejte jeho kód.';el('pairings').append(p);}
    pending.pairings.forEach(pairing=>{const div=document.createElement('div');div.className='pairing-row';const info=document.createElement('div');info.className='pairing-info';const name=document.createElement('strong');name.textContent=pairing.device_name;const detail=document.createElement('p');detail.textContent=(pairing.purpose==='pin-reset'?'Obnovení PINu · ':'Připojení zařízení · ')+'Platí do '+new Date(pairing.expires_at).toLocaleTimeString('cs-CZ',{hour:'2-digit',minute:'2-digit'});info.append(name,detail);const review=document.createElement('a');review.href='/device';review.textContent='Ověřit kód';review.setAttribute('aria-label','Ověřit kód zařízení '+pairing.device_name);div.append(info,review);div.append(button('Zamítnout',async()=>{if(!await confirmAction('Zamítnout žádost?', 'Žádost zařízení „'+pairing.device_name+'“ bude zamítnuta.', 'Zamítnout'))return;await api('/v1/device/pending/'+encodeURIComponent(pairing.id)+'/decision',{method:'POST',body:JSON.stringify({approve:false})});await refreshPortal();},true));el('pairings').append(div);});
    el('profile').replaceChildren();profiles.profiles.forEach(profile=>{const option=document.createElement('option');option.value=profile.id;option.textContent=profile.name;el('profile').append(option);});
    el('transfers').replaceChildren();
    if(!transfers.transfers.length)row(el('transfers'),'Žádné čekající převody.');
    transfers.transfers.forEach(transfer=>{
      const div=row(el('transfers'),transfer.profile_name+' · '+transfer.source_email+' → '+transfer.target_email);
      if(transfer.incoming)div.append(button('Přijmout profil',async()=>{await api('/v1/transfers/'+encodeURIComponent(transfer.id)+'/accept',{method:'POST',body:'{}'});message('Profil byl převeden. Na domácím serveru spusťte synchronizaci.');await refreshPortal();}));
    });
  }
  async function init() {
    if(document.body.dataset.page==='login'){
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
        location.assign(safeCode?'/device?user_code='+encodeURIComponent(safeCode):'/account'+accountQuery);
      }catch(error){message(error.message,'login-feedback');setBusy(false);el('login-otp').focus();}});
      return;
    }
    const currentAccount=await account();if(!currentAccount)return;
    if(expectedAccount && currentAccount.id!==expectedAccount)throw new Error('V prohlížeči je přihlášen jiný účet než v domácí instalaci. Přihlaste se znovu ke stejnému účtu, který chcete propojit.');
    const reauthenticate=el('reauthenticate');if(reauthenticate && /^[a-zA-Z0-9_-]{1,160}$/.test(currentAccount.id))reauthenticate.href='/login?account_id='+encodeURIComponent(currentAccount.id);
    if(document.body.dataset.page==='account'){
      function clearMethodFeedback(){el('reauth-help').hidden=true;message('','email-feedback');}
      function methodError(error, fallback){el('reauth-help').hidden=error.code!=='reauth_required';message(error.code==='reauth_required'?'':(fallback||error.message),'email-feedback');}
      async function methods(){const state=await api('/v1/account/email-login');el('email-status').textContent=state.enabled?'Přihlášení je aktivní':state.available?'Přihlášení není aktivní':'Momentálně nedostupné';el('enable-email').hidden=!state.available||state.enabled;el('disable-email').hidden=!state.enabled;el('link-google').hidden=state.googleLinked;el('unlink-google').hidden=!state.googleLinked;el('google-status').textContent=state.googleLinked?'Účet je propojen':'Účet není propojen';}
      await methods();
      el('enable-email').addEventListener('click',async()=>{const target=el('enable-email');const label=target.textContent;target.disabled=true;target.textContent='Odesílám kód…';clearMethodFeedback();try{await api('/v1/account/email-login/code',{method:'POST',body:'{}'});el('enable-email-form').hidden=false;el('enable-email-otp').focus();message('Ověřovací kód byl odeslán na e-mail tohoto účtu.','email-feedback');}catch(error){methodError(error);}finally{target.disabled=false;target.textContent=label;}});
      el('enable-email-form').addEventListener('submit',async(event)=>{event.preventDefault();const target=event.target.querySelector('button');target.disabled=true;clearMethodFeedback();try{await api('/v1/account/email-login/confirm',{method:'POST',body:JSON.stringify({otp:el('enable-email-otp').value.trim()})});el('enable-email-form').hidden=true;el('enable-email-otp').value='';await methods();message('E-mailové přihlášení je aktivní pro tento účet. Vaše profily zůstávají na stejném účtu.','email-feedback');}catch(error){methodError(error);}finally{target.disabled=false;}});
      el('link-google').addEventListener('click',async()=>{el('link-google').disabled=true;clearMethodFeedback();try{const data=await api('/api/auth/link-social',{method:'POST',body:JSON.stringify({provider:'google',callbackURL:location.origin+'/account'+accountQuery})});if(!data.url||new URL(data.url).origin!=='https://accounts.google.com')throw new Error('Propojení se nepodařilo zahájit.');location.assign(data.url);}catch(error){methodError(error);el('link-google').disabled=false;}});
      async function removeMethod(target,path,title,description,success){if(!await confirmAction(title,description,'Odebrat'))return;target.disabled=true;clearMethodFeedback();try{await api(path,{method:'DELETE'});await methods();message(success,'email-feedback');}catch(error){methodError(error,error.code==='email_unavailable'?'E-mailové přihlášení teď není dostupné. Google nelze bezpečně odpojit.':undefined);}finally{target.disabled=false;}}
      el('unlink-google').addEventListener('click',()=>removeMethod(el('unlink-google'),'/v1/account/google-login','Odpojit Google?', 'K tomuto účtu se už nebudete moci přihlašovat přes Google.','Google byl odpojen.'));
      el('disable-email').addEventListener('click',()=>removeMethod(el('disable-email'),'/v1/account/email-login','Vypnout e-mailové přihlášení?', 'K tomuto účtu se už nebudete moci přihlašovat e-mailovým kódem.','E-mailové přihlášení bylo vypnuto.'));
      await refreshPortal();
      el('transfer-form').addEventListener('submit',async(event)=>{event.preventDefault();try{await api('/v1/transfers',{method:'POST',body:JSON.stringify({profileId:el('profile').value,targetEmail:el('target-email').value})});message('Požadavek byl vytvořen. Cílový účet jej musí potvrdit do 10 minut.');await refreshPortal();}catch(error){message(error.message);}});
      el('signout').addEventListener('click',async()=>{try{await api('/api/auth/sign-out',{method:'POST',body:'{}'});location.assign('/login');}catch(error){message(error.message);}});
      return;
    }
    el('user-code').value=safeCode;
    let verifiedCode='';
    async function verify(){const value=el('user-code').value;let data;try{data=await api('/v1/device/verify?user_code='+encodeURIComponent(value));await api('/v1/device/claim',{method:'POST',body:JSON.stringify({user_code:data.user_code})});}catch(error){if(error.code==='reauth_required'){location.assign('/login?user_code='+encodeURIComponent(value));return;}throw error;}verifiedCode=data.user_code;el('display-code').textContent=data.user_code;el('device-name').textContent=(data.purpose==='pin-reset'?'Obnovit PIN · ':'')+data.device_name;if(data.purpose==='pin-reset'){el('grant-description').textContent='Schvalujete reset PINu profilu „'+data.profile_name+'“ na tomto domácím serveru. Původní PIN bude možné nahradit. Toto oprávnění platí pouze 5 minut.';el('approve').textContent='Kód souhlasí, povolit reset PINu';}el('approval').hidden=false;el('code-section').hidden=true;message('');}
    el('code-form').addEventListener('submit',event=>{event.preventDefault();verify().catch(error=>message(error.message));});
    async function approve(allow){el('approve').disabled=true;el('deny').disabled=true;try{await api('/v1/device/approve',{method:'POST',body:JSON.stringify({user_code:verifiedCode,approve:allow})});el('approval').hidden=true;message(allow?'Žádost byla schválena. Vraťte se k TV nebo domácímu serveru.':'Žádost byla zamítnuta.');}catch(error){if(error.code==='reauth_required'){location.assign('/login?user_code='+encodeURIComponent(verifiedCode));return;}message(error.message);el('approve').disabled=false;el('deny').disabled=false;}}
    el('approve').addEventListener('click',()=>approve(true));el('deny').addEventListener('click',()=>approve(false));
    if(safeCode)await verify();
  }
  init().catch(error=>message(error.message));
})();
`;
