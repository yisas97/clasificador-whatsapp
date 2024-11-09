#!/bin/sh

# Asegurar que los directorios existan y tengan los permisos correctos
mkdir -p /usr/src/app/session_auth_info
mkdir -p /usr/src/app/store
mkdir -p /usr/src/app/messages_store

chmod -R 777 /usr/src/app/session_auth_info
chmod -R 777 /usr/src/app/store
chmod -R 777 /usr/src/app/messages_store

# Ejecutar el comando proporcionado
exec "$@"