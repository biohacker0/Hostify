# Hostify /Self-Hosted Vercel - GitHub Repository Deployment System

This project automates deploying React apps (or similar frontend projects) directly from GitHub repositories. It clones the repo, builds it using Bun, and deploys the output to an S3-compatible storage service, making it publicly accessible via a unique URL.

## Architecture

The system consists of several containerized services working together:

```
                    ┌─────────────┐
                    │   Frontend  │
                    │    (Vite)   │
                    └──────┬──────┘
                           │
                           ▼
                    ┌─────────────┐         ┌─────────────┐        ┌─────────────┐
                    │  Service 1  │         │  RabbitMQ   │        │  Service 2  │
 User Input         │             │ Queue   │             │ Queue  │             │  Deploy
 (GitHub URL) ──────►  API Server ├─────────► Message     ├────────► Build       ├─────► S3 Storage
                    │             │         │  Broker     │        │  Service    │
                    └──────┬──────┘         └─────────────┘        └──────┬──────┘
                           │                                              │
                           │                 ┌─────────────┐              │
                           └─────────────────►    Redis    ◄──────────────┘
                                             │  (Storage)  │
                                             └─────────────┘
```

Everything runs in containers, with a simple service-based design:

### Components:

1. **Frontend (React + Vite)**: User submits a GitHub repo URL for deployment.
2. **API Server (Service 1)**:
   - Accepts GitHub URLs, generates a tracking ID
   - Stores deployment status in Redis
   - Queues jobs via RabbitMQ
   - Exposes endpoints to check status
3. **Build Service (Service 2)**:
   - Clones repo, installs dependencies using Bun
   - Runs `bun run build`
   - Uploads built files to S3
   - Updates status in Redis
4. **RabbitMQ**: Message broker handling three queues (`bridge_queue`, `cloned_queue`, `build_queue`)
5. **Redis**: Tracks deployment status, providing fast lookups

## Prerequisites

- Docker & Docker Compose
- S3-compatible storage (AWS S3, DigitalOcean Spaces, etc.)
- S3 credentials (access key, secret key, endpoint, bucket name)

## Setup

### 1. Clone the repository

```bash
git clone https://github.com/biohacker0/Hostify.git
cd Hostify
```

### 2. Configure environment variables

Update `docker-compose.yml` with your S3 credentials:

```yaml
service2:
  environment:
    - S3_ENDPOINT=your-endpoint.digitaloceanspaces.com
    - S3_BUCKET_NAME=your-bucket-name
    - AWS_ACCESS_KEY_ID=your-access-key
    - AWS_SECRET_ACCESS_KEY=your-secret-key
```

### 3. Start the services

```bash
docker compose up -d
```

### 4. Open the frontend

```
http://localhost:5173
```

## Usage

1. Enter a GitHub repo URL.
2. Get a tracking ID and deployment URL.
3. Monitor deployment status.
4. Access the deployed app via the generated URL.

## Deployment Flow

1. **Repo Submission** → API server assigns a UUID, queues it.
2. **Cloning** → Build service clones the repo, updates status, pushes job to `cloned_queue`.
3. **Building** → Runs `bun install` & `bun run build`, updates status, pushes job to `build_queue`.
4. **Deploying** → Uploads output to S3, finalizes status, returns the deployed URL.

## Monitoring & Debugging

- **RabbitMQ UI** → [http://localhost:15672](http://localhost:15672) (guest/guest)
- **Redis Insight** → [http://localhost:5540](http://localhost:5540)
- **Logs** → `docker compose logs service1` / `docker compose logs service2`

## Repository Requirements

- Must be a JS/TS frontend project (React, Vue, etc.)
- Needs a `package.json` with:
  - Dependencies installable via `bun install`
  - A build script running via `bun run build`
- Build output should be in `dist/` or `build/`

## Troubleshooting

- **Deployment failed?** Check `docker compose logs service2`.
- **Frontend can't connect?** Run `docker compose ps` to check service health.
- **Build errors?** Ensure the repo has the correct structure & scripts.

## Status Tracking (Redis)

Each deployment has one of these statuses:

- `processing` → Initial state
- `repo cloned successfully` → Cloning completed
- `repo built successfully` → Build completed
- `repo deployed successfully` → Deployment completed
- `deployment failed` → Something went wrong
