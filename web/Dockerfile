FROM --platform=$BUILDPLATFORM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:1.29-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
COPY runtime-config.template.js /etc/day-health/runtime-config.template.js
EXPOSE 8080
CMD ["/bin/sh", "-c", "envsubst < /etc/day-health/runtime-config.template.js > /usr/share/nginx/html/runtime-config.js && exec nginx -g 'daemon off;'"]
