FROM node:22-slim

RUN apt-get update && apt-get install -y \
    gnupg2 \
    git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

COPY package.json package-lock.json ./

# https://probot.github.io/docs/configuration/
# Comment NODE_ENV out for development to include smee-client proxy
ENV NODE_ENV="production"
ENV HUSKY=0

RUN npm ci --omit=dev && npm cache clean --force
# For development to include smee-client proxy, comment out the above line and use this instead:
# RUN npm ci && npm cache clean --force

COPY . ./
COPY scripts/setup.sh ./setup.sh

RUN npm run build

# Copy GPG configuration files to ~/.gnupg and GPG cache refresh script to /usr/local/bin
RUN mkdir -p ~/.gnupg && \
    cp scripts/gpg.conf ~/.gnupg/gpg.conf && \
    chmod 700 ~/.gnupg && \
    chmod 600 ~/.gnupg/gpg.conf && \
    chown -R root:root ~/.gnupg

CMD [ "/bin/bash", "./setup.sh" ]
