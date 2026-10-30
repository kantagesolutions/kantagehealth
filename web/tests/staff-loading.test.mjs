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

test('staff booking request shows the preferred day and time as an unconfirmed request', async () => {
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  try {
    const { default: BookingRequestsPanel } = await vite.ssrLoadModule('/src/BookingRequestsPanel.jsx');
    const html = renderToString(React.createElement(BookingRequestsPanel, {
      requests: [{ id: 'request-1', patient_id: 'patient-1', first_name: 'Jamie', last_name: 'Example', appointment_type: 'Preventive care', preferred_date: '2030-05-10', preferred_time: 'Morning', preferred_contact: 'email', email: 'jamie@example.com', phone: '4435550100', status: 'new' }],
      loading: false, scheduleId: '', scheduleTime: '', setScheduleId() {}, setScheduleTime() {}, onSchedule() {}, onMatch() {}, onOpenPatient() {},
    }));
    assert.match(html, /Friday, May 10, 2030 · Morning/);
    assert.match(html, /Requested time is not confirmed/);
    assert.match(html, /Email available times/);
  } finally {
    await vite.close();
  }
});
