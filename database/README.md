# Database

Database infrastructure for local development is provided by Docker Compose.
Prisma reads `DATABASE_URL` from the ignored root `.env` file. Create it from
`.env.example` before running Prisma commands. Prisma is configured without
application models for Sprint 0.
