from fastapi import FastAPI

app = FastAPI(title="doc-digest")


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
