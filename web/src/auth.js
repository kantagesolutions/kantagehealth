const authConfig = {
  clientId: 'i8paj6abvpevcs833bqrjt6oc',
  domain: 'https://kantage-healthcare-438064565992.auth.us-east-1.amazoncognito.com',
};

const tokenKey = 'kantage-health-portal-session';
const verifierKey = 'kantage-health-pkce-verifier';
const stateKey = 'kantage-health-oauth-state';

function base64Url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomValue(length = 48) {
  return base64Url(crypto.getRandomValues(new Uint8Array(length)));
}

async function challengeFor(verifier) {
  return base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}

function redirectUri() {
  return `${window.location.origin}/`;
}

export async function beginSignIn() {
  const verifier = randomValue();
  const state = randomValue(24);
  sessionStorage.setItem(verifierKey, verifier);
  sessionStorage.setItem(stateKey, state);
  const params = new URLSearchParams({
    client_id: authConfig.clientId,
    response_type: 'code',
    scope: 'openid email profile',
    redirect_uri: redirectUri(),
    state,
    code_challenge_method: 'S256',
    code_challenge: await challengeFor(verifier),
  });
  window.location.assign(`${authConfig.domain}/oauth2/authorize?${params}`);
}

export async function finishSignIn() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  if (!code) return readSession();
  const verifier = sessionStorage.getItem(verifierKey);
  const expectedState = sessionStorage.getItem(stateKey);
  if (!verifier || !expectedState || params.get('state') !== expectedState) throw new Error('The sign-in response could not be verified. Please try again.');
  const response = await fetch(`${authConfig.domain}/oauth2/token`, {
    method: 'POST',
    headers: {'content-type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({grant_type: 'authorization_code', client_id: authConfig.clientId, code, redirect_uri: redirectUri(), code_verifier: verifier}),
  });
  if (!response.ok) throw new Error('Sign in could not be completed. Please try again.');
  const session = await response.json();
  sessionStorage.removeItem(verifierKey);
  sessionStorage.removeItem(stateKey);
  sessionStorage.setItem(tokenKey, JSON.stringify(session));
  window.history.replaceState({}, '', '/');
  return session;
}

export function readSession() {
  try { return JSON.parse(sessionStorage.getItem(tokenKey) || 'null'); }
  catch { return null; }
}

export function claims(session) {
  if (!session?.id_token) return {};
  try {
    const payload = session.id_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(decodeURIComponent(Array.from(atob(payload), character => `%${character.charCodeAt(0).toString(16).padStart(2, '0')}`).join('')));
  } catch { return {}; }
}

export function hasGroup(session, group) {
  const groups = claims(session)['cognito:groups'];
  return Array.isArray(groups) && groups.includes(group);
}

export function signOut() {
  sessionStorage.removeItem(tokenKey);
  const params = new URLSearchParams({client_id: authConfig.clientId, logout_uri: redirectUri()});
  window.location.assign(`${authConfig.domain}/logout?${params}`);
}
