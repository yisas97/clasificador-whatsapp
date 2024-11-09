FROM node:20-slim

# Instalar dependencias necesarias
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

# Crear directorios necesarios
RUN mkdir -p \
    /usr/src/app/session_auth_info \
    /usr/src/app/store \
    /usr/src/app/messages_store

# Copiar package files
COPY package*.json ./

# Instalar dependencias
RUN npm install

# Copiar el resto del código
COPY . .

# Dar permisos necesarios
RUN chmod -R 777 /usr/src/app/session_auth_info \
    && chmod -R 777 /usr/src/app/store \
    && chmod -R 777 /usr/src/app/messages_store

EXPOSE 3000

# Script de inicio
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "app.js"]