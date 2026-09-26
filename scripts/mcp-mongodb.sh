#!/bin/sh
# launches the official mongodb mcp server with the uri from .env, kept out of argv and config files.
cd "$(dirname "$0")/.." || exit 1
set -a; [ -f .env ] && . ./.env; set +a
export MDB_MCP_CONNECTION_STRING="$MONGODB_URI"
[ -n "$MDB_MCP_API_CLIENT_ID" ] || unset MDB_MCP_API_CLIENT_ID MDB_MCP_API_CLIENT_SECRET
exec npx -y mongodb-mcp-server@3 "$@"
