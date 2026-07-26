FROM node:20.19.4-alpine3.22@sha256:df02558528d3d3d0d621f112e232611aecfee7cbc654f6b375765f72bb262799

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src

ENV NODE_ENV=production
ENV RELAY_HOST=0.0.0.0
ENV PORT=8080
USER node
EXPOSE 8080
CMD ["node", "src/index.js"]
