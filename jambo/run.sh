#!/usr/bin/with-contenv sh
# with-contenv imports the container environment (SUPERVISOR_TOKEN included) —
# s6 otherwise strips env vars when launching the command.
exec node /app/server.js
