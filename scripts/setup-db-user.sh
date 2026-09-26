#!/bin/sh
# creates an atlas db user with a random password and writes MONGODB_URI to .env.
# the password never hits argv, stdout, or chat. usage: scripts/setup-db-user.sh <username>
set -eu
cd "$(dirname "$0")/.."
A="${ATLAS:-$HOME/.local/bin/atlas}"
U="${1:?username}"
PW=$(openssl rand -base64 36 | tr -dc 'A-Za-z0-9' | head -c 32)
printf '%s\n' "$PW" | "$A" dbusers create atlasAdmin --username "$U" >/dev/null
echo "db user $U created"
"$A" clusters watch Cluster0 >/dev/null
SRV=$("$A" clusters describe Cluster0 -o json | sed -n 's/.*"standardSrv": *"\([^"]*\)".*/\1/p')
HOST=${SRV#mongodb+srv://}
touch .env && chmod 600 .env
grep -v '^MONGODB_URI=' .env > .env.tmp || true
printf 'MONGODB_URI=mongodb+srv://%s:%s@%s/?retryWrites=true&w=majority&appName=mongo-hive\n' "$U" "$PW" "$HOST" >> .env.tmp
grep -q '^MONGODB_DB=' .env.tmp || echo 'MONGODB_DB=harness' >> .env.tmp
mv .env.tmp .env && chmod 600 .env
echo "wrote MONGODB_URI for $U to .env"
