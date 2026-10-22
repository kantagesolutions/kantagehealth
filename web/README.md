# Kantage Healthcare Staff Portal

This is the staff operations portal for the Kantage Healthcare platform. It is deliberately separate from the clinical API so the browser only receives the user interface; clinical data remains behind authenticated API routes.

## Local preview

Run from this directory:

```sh
npm install
npm run dev
```

Open `http://127.0.0.1:5173`.

## Production service

The included Dockerfile builds the Vite application and serves it with Nginx on port 8080. In AWS, an HTTPS Application Load Balancer should route the portal hostnames to this service and `/api/*` to the separate healthcare API service. The current frontend is a demonstration; Cognito sign-in and authenticated clinical API requests still need to be integrated before real patient records are used.

## Dedicated portal URLs

The frontend recognizes these hostnames and opens the corresponding portal at `/`:

| Audience | URL |
| --- | --- |
| Kantage administrators | `https://admin.health.kantage.solutions/` |
| Clinic staff | `https://staff.health.kantage.solutions/` |
| Patients | `https://patient.health.kantage.solutions/` |

Clinic websites can link to `https://patient.health.kantage.solutions/patient/<clinic-slug>` to open the correct clinic login. The existing `portal.health.kantage.solutions` path URLs remain available during migration.

To activate these names, create DNS CNAME records for `admin.health`, `staff.health`, and `patient.health` pointing to `kh-production-api-1256179568.us-east-1.elb.amazonaws.com`. The existing certificate covers `*.health.kantage.solutions`. Apply the Terraform listener-rule update and deploy the latest portal image, then verify each hostname directly. The current portal UI still contains sample data and a demonstration sign-in; these URLs must not be represented as ready for real patient records until authenticated API integration is complete.
