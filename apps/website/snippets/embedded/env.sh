export VOLA_DATABASE_URL=file:data/app.db    # SQLite: one file, no database service
# export VOLA_DATABASE_URL=postgresql://vola:secret@localhost:5432/vola    # or PostgreSQL
export VOLA_STORAGE_PATH=data/storage
node server.ts
