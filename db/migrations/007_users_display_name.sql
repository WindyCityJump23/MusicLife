-- Add display_name to users table for multi-user support.
-- Safe to run even if column already exists.
alter table public.users
  add column if not exists display_name text;
