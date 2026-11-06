FROM node:22-alpine
WORKDIR /app
COPY src/ ./
# Runs as root inside the container. With rootless Docker that maps to the
# unprivileged host user 'agent', so it can write to ./data without extra setup.
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:3000/health || exit 1
CMD ["node", "server.js"]
