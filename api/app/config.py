from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    supabase_url: str
    supabase_service_role_key: str

    anthropic_api_key: str

    voyage_api_key: str = ""
    openai_api_key: str = ""
    embedding_provider: str = "voyage"
    embedding_model: str = "voyage-3"
    embedding_dims: int = 1024

    lastfm_api_key: str
    musicbrainz_user_agent: str

    cors_origins: str = "http://localhost:3000"

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

settings = Settings()
