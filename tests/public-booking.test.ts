import assert from 'node:assert/strict';
import test from 'node:test';
import { createPublicBookingInquiry, isOpenPreferredDate } from '../src/public-booking.js';

test('appointment requests accept Monday through Thursday and reject closed days', () => {
  assert.equal(isOpenPreferredDate('2030-05-06'),true);
  assert.equal(isOpenPreferredDate('2030-05-07'),true);
  assert.equal(isOpenPreferredDate('2030-05-08'),true);
  assert.equal(isOpenPreferredDate('2030-05-09'),true);
  assert.equal(isOpenPreferredDate('2030-05-10'),false);
  assert.equal(isOpenPreferredDate('2030-05-11'),false);
  assert.equal(isOpenPreferredDate('2030-05-12'),false);
});

test('public booking creates a patient-linked inquiry in the selected clinic scope', async () => {
  const calls: Array<{ text: string; values?: unknown[] }> = [];
  const client = {
    query: async (text: string, values?: unknown[]) => {
      calls.push({ text, values });
      if (text.includes('booking_date_open')) return { rows: [{ open: true }] };
      if (text.startsWith('SELECT * FROM clinical.create_public_booking_inquiry')) {
        return { rows: [{ inquiry_id: 'inquiry-1', patient_id: 'patient-1' }] };
      }
      return { rows: [] };
    },
    release: () => undefined,
  };
  const pool = { connect: async () => client };

  const result = await createPublicBookingInquiry(pool as never, {
    organizationId: '00000000-0000-4000-8000-000000000001',
    locationId: '00000000-0000-4000-8000-000000000002',
    clinicName: 'Express Dental Emergency Services',
    timezone: 'America/New_York',
  }, {
    firstName: 'Jamie',
    lastName: 'Example',
    phone: '443-555-0100',
    email: 'jamie@example.com',
    appointmentType: 'Emergency dentistry',
    preferredDate: '2030-05-09',
    preferredContact: 'text',
    textConsent: true,
    preferredTime: 'Morning',
    message: 'Please call when available.',
  }, { ip: '127.0.0.1', userAgent: 'test-agent' });

  assert.deepEqual(result, { id: 'inquiry-1', patientId: 'patient-1', patient:{firstName:'Jamie',lastName:'Example',email:'jamie@example.com',phone:'443-555-0100',textConsent:true} });
  assert.deepEqual(calls[2]?.values, [
    '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', '2030-05-09',
  ]);
  assert.deepEqual(calls[3]?.values?.slice(0, 9), [
    'Jamie', 'Example', '443-555-0100', 'jamie@example.com', 'Emergency dentistry',
    '2030-05-09', 'text', 'Morning', 'Please call when available.',
  ]);
  assert.equal(calls.at(-1)?.text, 'COMMIT');
});

test('public booking refuses a clinic blocked date before writing data', async () => {
  let written=false;
  const client={query:async(text:string)=>{
    if(text.includes('booking_date_open')) return {rows:[{open:false}]};
    if(text.includes('create_public_booking_inquiry')) written=true;
    return {rows:[]};
  },release:()=>undefined};
  const pool={connect:async()=>client};
  await assert.rejects(createPublicBookingInquiry(pool as never,{
    organizationId:'00000000-0000-4000-8000-000000000001',
    locationId:'00000000-0000-4000-8000-000000000002',
    clinicName:'Express Dental Emergency Services',
    timezone:'America/New_York',
  },{
    firstName:'Jamie',lastName:'Example',phone:'443-555-0100',appointmentType:'Cleaning',preferredDate:'2030-05-10',
  },{userAgent:'test-agent'}),/not accepting appointment requests/);
  assert.equal(written,false);
});
