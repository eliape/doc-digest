import pytest
from fastapi.testclient import TestClient
from pdfs import filler, make_pdf

from doc_digest import main
from doc_digest.config import Settings
from doc_digest.saved import SavedWorkspace


@pytest.fixture
def client(tmp_path):
    services = main.Services(Settings(data_dir=tmp_path, anthropic_api_key=None))
    main.app.dependency_overrides[main.get_services] = lambda: services
    yield TestClient(main.app)
    main.app.dependency_overrides.clear()


def test_nothing_saved_yet_is_an_empty_workspace(client: TestClient) -> None:
    assert client.get("/api/workspace").json() == {}


def test_a_saved_workspace_comes_back(client: TestClient, tmp_path) -> None:
    workspace = {"version": 1, "topics": [{"id": "t1", "name": "Calculus", "chat": []}]}
    assert client.put("/api/workspace", json=workspace).status_code == 200
    assert client.get("/api/workspace").json() == workspace
    assert SavedWorkspace(tmp_path / "workspace.json").load() == workspace
    assert not (tmp_path / "workspace.tmp").exists()


def test_a_stored_pdf_can_be_downloaded_again(client: TestClient) -> None:
    data = make_pdf([filler("limits")])
    doc_id = client.post("/api/docs?name=a.pdf", content=data).json()["id"]
    response = client.get(f"/api/docs/{doc_id}/pdf")
    assert response.status_code == 200
    assert response.content == data
    assert client.get("/api/docs/0000000000000000/pdf").status_code == 404
