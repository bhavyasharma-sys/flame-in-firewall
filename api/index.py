"""Vercel ASGI entrypoint; local development still uses uvicorn server:app."""

from server import app

__all__ = ["app"]
