import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { createServer } from 'vite';

test('staff portal renders while clinic assignments are loading', async () => {
  globalThis.window = { location: { hostname: 'localhost', pathname: '/staff' } };
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  try {
    const { StaffPortal } = await vite.ssrLoadModule('/src/main.jsx');
    const html = renderToString(React.createElement(StaffPortal, { session: {} }));
    assert.match(html, /Loading assigned clinics/);
  } finally {
    await vite.close();
    delete globalThis.window;
  }
});


test('admin portal renders the organization directory before data loads', async () => {
  globalThis.window = { location: { hostname: 'localhost', pathname: '/admin' } };
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  try {
    const { AdminPortal } = await vite.ssrLoadModule('/src/main.jsx');
    const html = renderToString(React.createElement(AdminPortal, { session: {} }));
    assert.match(html, /Organization directory/);
    assert.match(html, /Administrator navigation/);
  } finally {
    await vite.close();
    delete globalThis.window;
  }
});
