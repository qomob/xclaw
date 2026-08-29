#!/bin/sh
set -e

KEY_FILE="/data/keys/.env-secrets"

load_or_generate() {
  key_name="$1"
  key_len="$2"
  if [ -z "$(eval echo \$$key_name)" ]; then
    if [ -f "$KEY_FILE" ]; then
      saved_value=$(grep "^${key_name}=" "$KEY_FILE" 2>/dev/null | cut -d'=' -f2-)
      if [ -n "$saved_value" ]; then
        export "$key_name"="$saved_value"
        echo "[entrypoint] Loaded $key_name from persisted file"
        return
      fi
    fi
    generated=$(openssl rand -hex "$key_len")
    export "$key_name"="$generated"
    mkdir -p "$(dirname "$KEY_FILE")"
    echo "${key_name}=${generated}" >> "$KEY_FILE"
    echo "[entrypoint] Generated and persisted $key_name"
  fi
}

load_or_generate ENCRYPTION_KEY 32
load_or_generate JWT_SECRET 64

if [ -z "$REDIS_PASSWORD" ]; then
  echo "[entrypoint] ERROR: REDIS_PASSWORD is not set — refusing to start (insecure default removed)" >&2
  exit 1
fi

exec npm start
