FROM almir/webhook AS webhook-bin

FROM alpine:3.20

# docker-cli-buildx: deploy.sh builds with DOCKER_BUILDKIT=1 and the app
# Dockerfile uses --mount=type=secret, both of which need the buildx plugin.
# Without it every deploy died at that step (2026-08-09 to 2026-08-11).
RUN apk add --no-cache git bash docker-cli docker-cli-buildx ca-certificates

COPY --from=webhook-bin /usr/local/bin/webhook /usr/local/bin/webhook

ENTRYPOINT ["/usr/local/bin/webhook"]

# ─────────────────────────────────────────────────────────────────────────────
# This is a COPY of the image definition that lives on the games box at
# /opt/raising-intelligences/webhook/Dockerfile — the container that receives
# the GitHub push hook and runs deploy.sh. It was box-only state until now,
# which is how it went unnoticed that the container's docker CLI had no buildx
# plugin: every deploy from 2026-08-09 (when the app Dockerfile started using
# --mount=type=secret) to 2026-08-11 failed at that step, and production
# quietly kept serving the last image that built.
#
# Editing this file does NOT redeploy the webhook. To apply a change:
#   scp deploy/webhook.Dockerfile games:/opt/raising-intelligences/webhook/Dockerfile
#   ssh games 'cd /opt/raising-intelligences/webhook \
#     && docker tag ri-webhook:latest ri-webhook:backup-$(date +%Y%m%d) \
#     && docker build -t ri-webhook:latest . \
#     && docker rm -f ri-webhook \
#     && docker run -d --name ri-webhook --restart unless-stopped --network coolify \
#         -v /opt/raising-intelligences/webhook/hooks.json:/etc/webhook/hooks.json \
#         -v /opt/raising-intelligences:/opt/raising-intelligences \
#         -v /var/run/docker.sock:/var/run/docker.sock \
#         ri-webhook:latest -hooks /etc/webhook/hooks.json -verbose -port 9000'
