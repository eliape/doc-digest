from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Settings read from the environment or a local .env file."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    anthropic_api_key: str | None = None
    # Where uploaded PDFs, their indexes and the usage log are kept.
    data_dir: Path = Path("data")


def get_settings() -> Settings:
    return Settings()
