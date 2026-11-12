# Базовий образ пісочниці (§5.3). Запускається з --runtime=runsc (gVisor).
FROM node:22-alpine
RUN apk add --no-cache python3 py3-pip bash coreutils tini \
 && addgroup -g 10001 sandbox && adduser -D -u 10001 -G sandbox sandbox
WORKDIR /work
USER 10001:10001
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sleep", "infinity"]
