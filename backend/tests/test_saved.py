import json

import pytest
from fastapi.testclient import TestClient
from pdfs import filler, make_pdf

from leqtern import main
from leqtern.config import Settings
from leqtern.saved import SavedWorkspace


@pytest.fixture
def client(tmp_path):
    services = main.Services(Settings(data_dir=tmp_path, anthropic_api_key=None))
    main.app.dependency_overrides[main.get_services] = lambda: services
    yield TestClient(main.app)
    main.app.dependency_overrides.clear()


def test_nothing_saved_yet_is_an_empty_workspace(client: TestClient) -> None:
    assert client.get("/api/workspace").json() == {"revision": 0}


def test_a_saved_workspace_comes_back(client: TestClient, tmp_path) -> None:
    workspace = {"version": 1, "topics": [{"id": "t1", "name": "Calculus", "chat": []}]}
    response = client.put("/api/workspace?base=0&writer=a", json=workspace)
    assert response.status_code == 200
    assert response.json()["revision"] == 1
    assert client.get("/api/workspace").json() == {**workspace, "revision": 1}
    assert SavedWorkspace(tmp_path / "workspace.json").load() == workspace
    assert not (tmp_path / "workspace.tmp").exists()


def test_a_workspace_saved_before_revisions_still_loads(tmp_path) -> None:
    workspace = {"version": 1, "topics": []}
    (tmp_path / "workspace.json").write_text(json.dumps(workspace))
    saved = SavedWorkspace(tmp_path / "workspace.json")
    assert saved.load() == workspace
    assert saved.revision() == 0
    assert saved.save({"version": 1, "topics": [{"id": "t"}]}, base=0, writer="a") == 1


def test_a_tab_working_from_an_older_copy_cannot_save_over_another_tabs_save(
    client: TestClient,
) -> None:
    first = {"version": 1, "topics": [{"id": "t1"}]}
    assert client.put("/api/workspace?base=0&writer=a", json=first).json()["revision"] == 1
    # Tab b loads revision 1 and saves; tab a, still on revision 1, then tries to save.
    second = {"version": 1, "topics": [{"id": "t1"}, {"id": "t2"}]}
    assert client.put("/api/workspace?base=1&writer=b", json=second).json()["revision"] == 2
    stale = client.put("/api/workspace?base=1&writer=a", json=first)
    assert stale.status_code == 409
    assert client.get("/api/workspace").json() == {**second, "revision": 2}


def test_a_tabs_own_saves_can_overtake_each_other(client: TestClient) -> None:
    # Two saves sent before either came back are both based on revision 0.
    assert client.put("/api/workspace?base=0&writer=a", json={"n": 1}).status_code == 200
    assert client.put("/api/workspace?base=0&writer=a", json={"n": 2}).status_code == 200
    assert client.get("/api/workspace").json() == {"n": 2, "revision": 2}


def test_other_sites_and_hosts_are_turned_away(client: TestClient) -> None:
    data = make_pdf([filler("limits")])
    pdf = {"Content-Type": "application/pdf"}
    evil = {**pdf, "Origin": "https://evil.example"}
    assert client.post("/api/docs?name=a.pdf", content=data, headers=evil).status_code == 403
    # A plain cross-site request can only send text/plain, which uploads refuse.
    plain = {"Content-Type": "text/plain"}
    assert client.post("/api/docs?name=a.pdf", content=data, headers=plain).status_code == 415
    rebound = {**pdf, "Host": "attacker.example"}
    assert client.get("/api/workspace", headers={"Host": "attacker.example"}).status_code == 403
    assert client.post("/api/docs?name=a.pdf", content=data, headers=rebound).status_code == 403
    local = {**pdf, "Origin": "http://localhost:5173", "Host": "localhost:5173"}
    assert client.post("/api/docs?name=a.pdf", content=data, headers=local).status_code == 200
    assert client.get("/api/workspace", headers={"Host": "127.0.0.1:8000"}).status_code == 200
    assert client.get("/api/workspace", headers={"Host": "[::1]:8000"}).status_code == 200


def test_a_stored_pdf_can_be_downloaded_again(client: TestClient) -> None:
    data = make_pdf([filler("limits")])
    doc_id = client.post(
        "/api/docs?name=a.pdf", content=data, headers={"Content-Type": "application/pdf"}
    ).json()["id"]
    response = client.get(f"/api/docs/{doc_id}/pdf")
    assert response.status_code == 200
    assert response.content == data
    assert client.get("/api/docs/0000000000000000/pdf").status_code == 404
