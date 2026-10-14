const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const $ = selector => document.querySelector(selector);
export async function apiRequest(path, options = {}, retry = true) {
  const response = await fetch(path, {headers:{'Content-Type':'application/json'},...options});
  let result;
  try { result = await response.json(); } catch { throw new Error('The server returned an unreadable response. Please try again.'); }
  if (response.status === 401 && retry && !path.startsWith('/api/auth/')) {
    try { await apiRequest('/api/auth/refresh',{method:'POST',body:'{}'},false); return apiRequest(path,options,false); } catch {}
  }
  if (!response.ok) throw Object.assign(new Error(typeof result.error === 'string' ? result.error : 'The operation could not be completed.'),{status:response.status,setupRequired:result.setupRequired});
  return result;
}
function lockChrome() {
  document.querySelectorAll('[data-view], #scanBtn, #exportBtn').forEach(node => node.disabled = true);
  $('#modeBadge').textContent = 'PRIVATE WORKSPACE';
}
export function renderAccountGate(error, retry) {
  if (error.status !== 401 && !error.setupRequired) return false;
  lockChrome();
  const setup = error.setupRequired;
  $('#view').innerHTML = `<section class="page-heading"><div><div class="eyebrow">${setup ? 'Your organization' : 'Private by design'}</div><h1 class="page-title">${setup ? 'A workspace for <em>your business.</em>' : 'Welcome back <em>to ATLAS.</em>'}</h1><p class="lead">${setup ? 'Create an organization before reviewing the business and its research questions.' : 'Sign in with your verified account to see your organization’s evidence.'}</p></div></section><div class="account-layout"><section class="panel"><form id="accountForm" class="form-grid"><div id="accountError" class="error-message hidden wide" role="alert"></div>${setup ? '<div class="field wide"><label for="organizationName">Organization name</label><input id="organizationName" required maxlength="120" autocomplete="organization"/></div>' : '<div class="field wide"><label for="accountEmail">Email address</label><input id="accountEmail" type="email" required maxlength="320" autocomplete="username"/></div><div class="field wide"><label for="accountPassword">Password</label><input id="accountPassword" type="password" required maxlength="1024" autocomplete="current-password"/></div>'}<div class="wide"><button class="btn btn-dark" id="accountSubmit" type="submit">${setup ? 'Create organization →' : 'Sign in securely →'}</button></div></form></section><aside class="panel account-principles"><p class="panel-kicker">Evidence belongs to your team</p><h2 class="panel-title">A clear boundary around every business.</h2><p class="lead">Your organization’s observations, research briefs and private evidence stay together. Every data request checks your membership.</p>${setup ? '<p class="panel-desc">Each verified account can create up to three organizations. Organization owners manage access; viewers can inspect evidence without changing it.</p>' : '<p class="panel-desc">Use your confirmed Supabase account invitation. An OpenAI API key is a server credential; it is never a sign-in password.</p>'}</aside></div>`;
  $('#accountForm').onsubmit = async event => {
    event.preventDefault(); const button = $('#accountSubmit'); button.disabled = true; button.textContent = setup ? 'Creating…' : 'Signing in…';
    try {
      await apiRequest(setup ? '/api/organizations' : '/api/auth/login',{method:'POST',body:JSON.stringify(setup ? {name:$('#organizationName').value} : {email:$('#accountEmail').value,password:$('#accountPassword').value})});
      if ($('#accountPassword')) $('#accountPassword').value = '';
      await retry();
    } catch (failure) { $('#accountError').textContent = failure.message; $('#accountError').classList.remove('hidden'); button.disabled = false; button.textContent = setup ? 'Create organization →' : 'Sign in securely →'; }
  };
  return true;
}
export const canEdit = state => !state?.hosted || ['owner','editor'].includes(state.organization?.role);
export function renderAccountChrome(state, switchWorkspace) {
  let controls = $('#accountControls');
  if (!state.hosted) { controls?.remove(); return; }
  if (!controls) { controls = document.createElement('div'); controls.id = 'accountControls'; controls.className = 'account-controls'; $('.top-actions').prepend(controls); }
  controls.innerHTML = `<label class="sr-only" for="organizationPicker">Organization</label><select id="organizationPicker" aria-label="Organization">${state.organizations.map(org => `<option value="${esc(org.id)}" ${org.id === state.organization?.id ? 'selected' : ''}>${esc(org.name)}</option>`).join('')}<option value="new">+ New organization</option></select><span class="account-role">${esc(state.organization?.role)}</span><button class="btn btn-ghost" id="researchHistory" type="button">History</button><button class="btn btn-ghost" id="signOut" type="button">Sign out</button>`;
  $('#researchHistory').onclick = async () => {
    try {
      const rows=await apiRequest('/api/project-versions');
      const overlay=document.createElement('dialog');overlay.className='account-history';
      overlay.innerHTML=`<h2>Research history</h2><p>Previous briefs retain their original evidence. They are excluded from the current cohort’s metrics.</p>${rows.length?rows.map(row=>`<p><a href="/api/project-versions/${encodeURIComponent(row.id)}/export" download>Export version ${esc(row.revision)} · ${esc(row.archived_at)}</a></p>`).join(''):'<p>No archived research versions yet.</p>'}<button class="btn btn-dark" autofocus>Close history</button>`;
      overlay.querySelector('button').onclick=()=>overlay.close();overlay.onclose=()=>overlay.remove();document.body.append(overlay);overlay.showModal();
    } catch(error) { $('#toast').textContent=error.message;$('#toast').classList.remove('hidden'); }
  };
  $('#organizationPicker').onchange = async event => {
    const id = event.target.value;
    if (id === 'new') { renderAccountGate({setupRequired:true},switchWorkspace); return; }
    event.target.disabled = true;
    try { await apiRequest('/api/organizations/select',{method:'POST',body:JSON.stringify({id})}); await switchWorkspace(); }
    catch (error) { event.target.disabled = false; $('#toast').textContent = error.message; $('#toast').classList.remove('hidden'); }
  };
  $('#signOut').onclick = async () => { $('#signOut').disabled = true; try { await apiRequest('/api/auth/logout',{method:'POST',body:'{}'}); } finally { window.location.reload(); } };
  $('.side-footer span:last-child').textContent = 'Private organization workspace';
  $('.footer span:last-child').textContent = 'Evidence-first · Organization research';
}
