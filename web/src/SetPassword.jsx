import { useEffect, useState } from 'react';
import { Check, Copy, KeyRound, ShieldCheck } from 'lucide-react';
import { beginSignIn } from './auth.js';
import { apiBaseUrl } from './config.js';

// The staff portal address a password link opens. The secret sits after the #, so browsers never send
// it to a server or in a referrer; the page reads it and posts it to the API.
const staffPortalOrigin = () => window.location.hostname.endsWith('.kantage.solutions') ? 'https://staff.health.kantage.solutions' : window.location.origin;
export const passwordLinkUrl = token => `${staffPortalOrigin()}/#set-password=${token}`;
export function passwordLinkToken() {
  const match = window.location.hash.match(/^#set-password=([0-9a-f-]{36}\.[A-Za-z0-9_-]{43})$/);
  return match ? match[1] : null;
}

// The workforce pool's rules (infrastructure/main.tf), shown as the person types.
const rules = [
  ['At least 14 characters', value => value.length >= 14],
  ['An upper case letter', value => /[A-Z]/.test(value)],
  ['A lower case letter', value => /[a-z]/.test(value)],
  ['A number', value => /[0-9]/.test(value)],
  ['A symbol, such as ! or #', value => /[^A-Za-z0-9]/.test(value)],
];

async function post(path, payload) {
  const response = await fetch(`${apiBaseUrl()}${path}`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(payload)});
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
  return data;
}

export function SetPassword({ token, Brand }) {
  const [account, setAccount] = useState(null);
  const [failure, setFailure] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  useEffect(() => {
    // Take the secret out of the address bar, so it is not left in history or caught in a screenshot.
    window.history.replaceState(null, '', window.location.pathname);
    post('/v1/public/staff-password/lookup', {token}).then(data => setAccount(data.account)).catch(event => setFailure(event.message));
  }, [token]);
  const valid = rules.every(([, test]) => test(password)) && password === confirm;
  const submit = async event => {
    event.preventDefault();
    if (!valid) return;
    setSaving(true); setError('');
    try { await post('/v1/public/staff-password', {token, password}); setDone(true); }
    catch (event) { setError(event.message); }
    finally { setSaving(false); }
  };
  const card = body => <div className="workforce-login login-staff"><main className="workforce-login-card set-password-card"><Brand /><span className="owner-kicker">CLINIC STAFF PORTAL</span>{body}</main></div>;
  if (failure) return card(<><h1>This link can’t be used</h1><p>{failure}</p><button className="primary portal-sign-in" type="button" onClick={() => beginSignIn()}>Go to sign in</button></>);
  if (!account) return card(<p>Checking your link…</p>);
  if (done) return card(<><h1>Your password is set</h1><p>Sign in with your username <strong>{account.username}</strong> and the password you just chose.</p><button className="primary portal-sign-in" type="button" onClick={() => beginSignIn()}>Continue to sign in</button></>);
  return card(<>
    <h1>Welcome, {account.name.split(/\s+/)[0]}</h1>
    <p>Choose a password for your staff account. You will sign in with the username <strong>{account.username}</strong>.</p>
    <form className="set-password-form" onSubmit={submit}>
      <label>New password<input type="password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} required autoFocus /></label>
      <ul className="password-rules" aria-label="Password requirements">{rules.map(([label, test]) => <li key={label} data-met={test(password)}><Check size={14} aria-hidden="true" /> {label}</li>)}</ul>
      <label>Confirm password<input type="password" autoComplete="new-password" value={confirm} onChange={event => setConfirm(event.target.value)} required /></label>
      {confirm && password !== confirm && <p className="field-hint mismatch">The passwords don’t match yet.</p>}
      {error && <p className="login-error">{error}</p>}
      <button className="primary portal-sign-in" disabled={!valid || saving}><KeyRound size={16} /> {saving ? 'Saving…' : 'Set password'}</button>
    </form>
    <p className="workforce-login-notice"><ShieldCheck size={16} /> This link works once and expires 72 hours after it was created.</p>
  </>);
}

// Shown to an administrator after an invite or a new link: the link to hand to the staff member.
export function PasswordLinkPanel({ link, onClose }) {
  const [copied, setCopied] = useState(false);
  const url = passwordLinkUrl(link.token);
  const copy = async () => { try { await navigator.clipboard.writeText(url); setCopied(true); } catch { setCopied(false); } };
  return <section className="live-panel admin-section password-link-panel" aria-labelledby="password-link-title">
    <div className="panel-heading"><div><h2 id="password-link-title">Password link for {link.name}</h2><p>Send this to {link.name.split(/\s+/)[0]} by text or email. They open it, choose their own password, then sign in as <strong>{link.username}</strong>. No temporary password is needed.</p></div></div>
    <div className="password-link-row"><input readOnly value={url} aria-label="Password link" onFocus={event => event.target.select()} /><button type="button" className="primary" onClick={copy}>{copied ? <><Check size={15} /> Copied</> : <><Copy size={15} /> Copy link</>}</button></div>
    <p className="field-hint">Works once, until {new Date(link.expiresAt).toLocaleString([], {dateStyle: 'medium', timeStyle: 'short'})}. Anyone with the link can set this password, so send it only to them. Creating a new link cancels this one.</p>
    <div className="staff-edit-actions"><button type="button" className="secondary" onClick={onClose}>Done</button></div>
  </section>;
}
