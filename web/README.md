# Kantage Healthcare portal

This is the staff operations portal for the Kantage Healthcare platform. It is deliberately separate from the clinical API so the browser only receives the user interface; clinical data remains behind authenticated API routes.

## Local preview

Run from this directory:

```sh
npm install
npm run dev
```

Open `http://127.0.0.1:5173`.

## Production service

The included Dockerfile builds the Vite application and serves it with Nginx on port 8080. In AWS, an HTTPS Application Load Balancer should route the portal hostname to this service, and route `/api/*` to the separate healthcare API service. Authentication is enforced by Cognito before a portal session receives access to location data.
