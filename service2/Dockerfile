FROM oven/bun:1 AS base
WORKDIR /app

RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    git \
    curl \
    unzip \
    groff \
    less \
    nodejs \
    npm \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Install AWS CLI
RUN curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip" && \
    unzip awscliv2.zip && \
    ./aws/install --bin-dir /usr/local/bin --install-dir /usr/local/aws-cli --update && \
    rm -rf awscliv2.zip aws

# Verify AWS CLI installation
RUN aws --version

COPY package.json bun.lockb* ./

RUN bun install

COPY . .

EXPOSE 3000

CMD ["bun", "run", "start"]